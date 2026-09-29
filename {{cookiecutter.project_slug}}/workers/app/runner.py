"""Job orchestrator — runs pipeline steps in sequence and returns structured results.

The shipped pipeline reads a web page and reports on it:

    input:  {"url": "https://example.com/article", "question": "optional focus question"}
    output: {"status": "generated", "url", "title", "summary",
             "insights": [...], "sources": [...], "ai_enhanced": bool}

`url` is required, `question` is optional. Step 1 fetches the page, step 2 hands
it to a bounded tool-calling agent, step 3 assembles the report. Every step
returns a structured status instead of raising, so a job always finishes: a bad
URL, an unreachable page or a missing model key all produce a report whose
`ai_enhanced` is false and whose `summary` says what went wrong.
"""

import logging
import time
from typing import Callable, Awaitable

import llm_utils
from agents.research_agent import (
    DEFAULT_SYSTEM_PROMPT,
    AgentEvent,
    RecursionBackstopReached,
    ReportSchemaError,
    ResearchAgentError,
    ToolCallLimitReached,
    run_research_agent,
)
from progress import JobCancelled, JobProgress, StepProgress
from settings import settings
from tools import discover_tools
from tools.fetch_url import FetchError, fetch_page
from tracing import job_trace_config

logger = logging.getLogger("runner")


# Stable `reason` codes for each way the research agent can end a step.
_AGENT_ERROR_REASONS: dict[type[ResearchAgentError], str] = {
    ToolCallLimitReached: "tool_call_limit",
    RecursionBackstopReached: "recursion_limit",
    ReportSchemaError: "invalid_report",
}


# Pipeline steps: (name, function, progress_weight)
# Each step receives (input_data, context) and returns a result dict.
PIPELINE_STEPS = [
    ("Data Collection", "collect_data", 30),
    ("AI Processing", "process_with_ai", 40),
    ("Results Generation", "generate_results", 30),
]


async def run_job(
    job_id: str,
    job_type: str,
    user_id: str | None,
    input_data: dict,
    progress_callback: Callable[..., Awaitable] | None = None,
    cancel_check: Callable[[], Awaitable[bool]] | None = None,
) -> dict:
    """Run a job through the pipeline steps.

    Args:
        job_id: Unique job identifier
        job_type: Type of job (determines pipeline behavior)
        user_id: User who initiated the job
        input_data: Job input parameters
        progress_callback: Async callback for progress updates
            (pct, step_name, status, message). Events from inside a step (for
            example each agent step and tool call) also pass `detail=` (a dict
            with at least `kind`); a callback must accept it. The percentage
            never decreases, except that a failure reports 0.
        cancel_check: Async function that returns True if job should be cancelled

    Returns:
        Dict with job results including all step outputs.
    """
    logger.info("Starting job pipeline for %s (type=%s)", job_id, job_type)
    start_time = time.monotonic()

    context = {
        "job_id": job_id,
        "job_type": job_type,
        "user_id": user_id,
        "input_data": input_data,
        "step_results": {},
    }

    progress = JobProgress(progress_callback, cancel_check)

    # Calculate progress ranges for each step
    total_weight = sum(w for _, _, w in PIPELINE_STEPS)
    progress_base = 0

    try:
        for step_name, step_func_name, weight in PIPELINE_STEPS:
            # Check for cancellation before each step
            await progress.check_cancelled()

            step_pct_start = int(progress_base / total_weight * 100)
            step_pct_end = int((progress_base + weight) / total_weight * 100)

            await progress.emit(step_pct_start, step_name, "running", f"Starting {step_name}")
            # Steps may spread finer events across their own slice of the bar.
            context["progress"] = progress.step(step_name, step_pct_start, step_pct_end)

            logger.info("Job %s: running step '%s'", job_id, step_name)
            step_start = time.monotonic()

            # Execute the pipeline step
            step_result = await _execute_step(step_func_name, input_data, context)
            context["step_results"][step_name] = step_result

            elapsed = time.monotonic() - step_start
            logger.info("Job %s: step '%s' completed in %.1fs", job_id, step_name, elapsed)

            await progress.emit(step_pct_end, step_name, "running", f"Completed {step_name}")

            progress_base += weight

        total_elapsed = time.monotonic() - start_time

        await progress.emit(100, "Complete", "completed", "Job completed")

        return {
            "job_id": job_id,
            "job_type": job_type,
            "user_id": user_id,
            "status": "completed",
            "duration_seconds": round(total_elapsed, 2),
            "results": context["step_results"],
        }
    except JobCancelled:
        raise
    except Exception as exc:
        await progress.emit(0, "", "failed", f"Job failed: {type(exc).__name__}")
        raise


async def _execute_step(step_func_name: str, input_data: dict, context: dict) -> dict:
    """Execute a single pipeline step by name."""
    steps = {
        "collect_data": _step_collect_data,
        "process_with_ai": _step_process_with_ai,
        "generate_results": _step_generate_results,
    }

    func = steps.get(step_func_name)
    if not func:
        raise ValueError(f"Unknown pipeline step: {step_func_name}")

    return await func(input_data, context)




async def _step_collect_data(input_data: dict, context: dict) -> dict:
    """Step 1: fetch the page named by `input_data["url"]`.

    Returns, so the job always finishes cleanly:
    - fetched   -> `{"status": "collected", "url", "title", "chars", "truncated", "text"}`
    - no url    -> `{"status": "error", "reason": "no_url", "error": ...}`
    - fetch bad -> `{"status": "error", "reason": "fetch_failed", "url", "error": ...}`

    Swap `fetch_page` for your own collection here — an API call, a database
    query, a file read — and keep the same status/reason discipline.
    """
    url = str(input_data.get("url") or "").strip()
    if not url:
        return {
            "status": "error",
            "reason": "no_url",
            "error": "Job input has no 'url' to fetch.",
        }

    try:
        page = await fetch_page(url)
    except FetchError as exc:
        logger.warning("Could not fetch %s: %s", url, exc)
        return {"status": "error", "reason": "fetch_failed", "url": url, "error": str(exc)}

    return {
        "status": "collected",
        "url": page.url,
        "title": page.title,
        "chars": page.chars,
        "truncated": page.truncated,
        "text": page.text,
    }


def _agent_progress_listener(progress: StepProgress | None, max_tool_calls: int):
    """Listener that turns agent events into progress inside the step's slice.

    The step's slice is divided into `max_tool_calls + 1` equal parts: one per
    tool call the agent may make, plus one for the final model call that writes
    the report. A tool call fills its own part (its intermediate progress moves
    within it), so the bar advances with the agent's work, cannot run past the
    slice however the run goes, and the step-complete event finishes the slice.
    Returns None when there is nowhere to report (the step ran standalone).
    """
    if progress is None:
        return None
    parts = max_tool_calls + 1

    async def on_event(event: AgentEvent) -> None:
        done = event.tool_calls_done
        fraction = done / parts
        if event.kind == "model_start":
            message = f"Agent step {event.step}: thinking"
        elif event.kind == "tool_start":
            message = f"Agent step {event.step}: calling {event.tool}"
        elif event.kind == "tool_progress":
            fraction = (done + (event.fraction or 0.0)) / parts
            message = event.message or f"Agent step {event.step}: {event.tool} running"
        else:
            message = f"Agent step {event.step}: {event.tool} finished"
        detail = {"kind": event.kind, "step": event.step, "tool_calls": done}
        if event.tool:
            detail["tool"] = event.tool
        try:
            await progress.update(fraction, message, detail)
        except JobCancelled:
            raise
        except Exception:
            # Progress is best effort: a failed publish must not turn a
            # working agent into an "error" AI step.
            logger.warning("Could not report agent progress", exc_info=True)

    return on_event


def _agent_topic(url: str, question: str) -> str:
    """What the agent is asked to research. Never blank — the agent rejects that."""
    if question and url:
        return f"{question} (as answered by the page at {url})"
    if question:
        return question
    if url:
        return f"the content of the page at {url}"
    return "the page content collected for this job"


def _page_context(collected: dict) -> str:
    """The already-fetched page, as a block appended to the agent's system prompt."""
    if collected.get("status") != "collected":
        return (
            "No page content was collected for this job "
            f"(reason: {collected.get('reason', 'unknown')}). "
            "Use the fetch_url tool if you have a URL worth reading; otherwise "
            "report what you can and say the page was unavailable."
        )

    note = " (truncated)" if collected.get("truncated") else ""
    return (
        "Page already fetched for this job — use it as your primary source and "
        "cite its URL:\n"
        f"URL: {collected.get('url', '')}\n"
        f"Title: {collected.get('title', '')}\n"
        f"Content{note}:\n---\n{collected.get('text', '')}\n---"
    )


async def _step_process_with_ai(input_data: dict, context: dict) -> dict:
    """Step 2: analyze the fetched page with a bounded tool-calling agent.

    Runs `agents.research_agent.run_research_agent` with the configured LLM and
    every tool `tools.discover_tools()` finds, so a new tool file reaches the
    agent with no change here. The job's identity, type and user go along as
    trace metadata, which only a configured collector ever reads. The agent may
    call tools in a loop, bounded by `settings.research_max_tool_calls` (with a
    graph recursion backstop).

    Exit behaviour, so the job always finishes cleanly:
    - no LLM configured -> `{"status": "skipped", "reason": "no_llm_configured"}`
    - report produced   -> `{"status": "processed", "analysis": {...}, "research": {...}}`
    - bound exceeded or malformed report -> `{"status": "error", "reason": ..., "error": ...}`
      where reason is `tool_call_limit`, `recursion_limit` or `invalid_report`
    - any other failure (provider, tool) -> `{"status": "error", "error": ...}`

    The later steps treat every non-"processed" status as "no AI enhancement".
    Progress: each model step and tool call is reported inside this step's
    slice of the bar (see `_agent_progress_listener`), and a cancelled job
    raises `JobCancelled` out of the agent at the next event. The step's start
    and end percentages do not depend on the outcome or on how many tool calls
    the agent made.
    """
    llm = llm_utils.get_llm()
    if llm is None:
        logger.warning("No LLM configured, skipping AI processing")
        return {
            "status": "skipped",
            "reason": "no_llm_configured",
        }

    collected = context["step_results"].get("Data Collection", {})
    url = collected.get("url") or str(input_data.get("url") or "").strip()
    question = str(input_data.get("question") or "").strip()
    topic = _agent_topic(url, question)
    system_prompt = f"{DEFAULT_SYSTEM_PROMPT}\n\n{_page_context(collected)}"

    on_event = _agent_progress_listener(context.get("progress"), settings.research_max_tool_calls)

    try:
        # The agent module does not rate limit; hold one limiter slot for the
        # whole run (this covers the run, not each model call inside it).
        limiter = llm_utils.get_rate_limiter()
        await limiter.acquire()
        try:
            report = await run_research_agent(
                topic,
                model=llm,
                tools=discover_tools(),
                max_tool_calls=settings.research_max_tool_calls,
                system_prompt=system_prompt,
                on_event=on_event,
                # Labels the run for whatever tracer is configured; a no-op
                # when tracing is off, which is the default.
                run_config=job_trace_config(
                    job_id=context.get("job_id"),
                    job_type=context.get("job_type"),
                    user_id=context.get("user_id"),
                ),
            )
        finally:
            limiter.release()
    except JobCancelled:
        # Raised from `on_event` when the job is cancelled; not an agent failure.
        raise
    except ResearchAgentError as exc:
        reason = _AGENT_ERROR_REASONS.get(type(exc), "agent_error")
        logger.warning("Research agent ended the AI step (%s): %s", reason, exc)
        return {"status": "error", "reason": reason, "error": str(exc)}
    except Exception as exc:
        logger.warning("LLM processing failed: %s", exc)
        return {
            "status": "error",
            "error": str(exc),
        }

    return {
        "status": "processed",
        "analysis": {
            "summary": report.summary,
            "insights": report.key_findings,
        },
        "research": report.model_dump(),
    }


# Plain-language explanations for every way the job can finish without an
# analysis. Each one tells the user what to change, because this text is what
# they see in place of a report.
_NO_ANALYSIS_SUMMARIES: dict[str, str] = {
    "no_url": "No report: this job had no URL to read. Submit a job with a 'url' field.",
    "fetch_failed": "No report: the page could not be read.",
    "no_llm_configured": (
        "No report: this deployment has no model provider configured. Set LLM_PROVIDER "
        "and the matching API key (for example OPENAI_API_KEY) in the worker's "
        "environment, then run the job again."
    ),
    "tool_call_limit": (
        "No report: the agent used its whole tool-call budget without finishing. Ask a "
        "narrower question, or raise RESEARCH_MAX_TOOL_CALLS."
    ),
    "recursion_limit": (
        "No report: the agent kept working past its step limit without finishing. Ask a "
        "narrower question, or try a different model."
    ),
    # Reached via `status` when the AI step failed with no specific reason —
    # nearly always the provider being unreachable, which on a fresh clone means
    # the default local Ollama is not running.
    "error": (
        "No report: the model provider could not be reached, or returned an error. Check "
        "LLM_PROVIDER and the matching credentials in the worker's environment — the "
        "default is a local Ollama at OLLAMA_BASE_URL — then run the job again."
    ),
    "invalid_report": (
        "No report: the model's answer did not match the expected report format. This is "
        "usually a weaker model; retrying, or switching models, normally fixes it."
    ),
}


def _unavailable_summary(collected: dict, ai_result: dict) -> str:
    """Explain, in words a user can act on, why there is no analysis."""
    if collected.get("status") != "collected":
        # Collection failing is the root cause; report it over the AI step's.
        source = collected
    else:
        source = ai_result

    reason = source.get("reason") or source.get("status") or "unknown"
    message = _NO_ANALYSIS_SUMMARIES.get(
        reason, f"No report: the job finished without an analysis ({reason})."
    )
    detail = source.get("error")
    return f"{message} ({detail})" if detail else message


async def _step_generate_results(input_data: dict, context: dict) -> dict:
    """Step 3: assemble the user-visible report from the previous steps.

    Always the same shape, whether or not the AI step produced a report:
    `status`, `url`, `title`, `summary`, `insights`, `sources`, `ai_enhanced`.
    When `ai_enhanced` is false, `summary` says why in plain language.
    """
    collected = context["step_results"].get("Data Collection", {})
    ai_result = context["step_results"].get("AI Processing", {})

    ai_enhanced = ai_result.get("status") == "processed"
    analysis = ai_result.get("analysis") or {}
    research = ai_result.get("research") or {}
    url = collected.get("url") or str(input_data.get("url") or "").strip()

    if ai_enhanced:
        summary = analysis.get("summary") or ""
        insights = list(analysis.get("insights") or [])
    else:
        summary = _unavailable_summary(collected, ai_result)
        insights = []

    # The report's own sources when it cited any, otherwise the page we read.
    sources = list(research.get("sources") or ([url] if url else []))

    return {
        "status": "generated",
        "url": url,
        "title": collected.get("title") or "",
        "summary": summary,
        "insights": insights,
        "sources": sources,
        "ai_enhanced": ai_enhanced,
    }
