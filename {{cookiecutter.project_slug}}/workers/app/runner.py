"""Job orchestrator — runs pipeline steps in sequence and returns structured results."""

import json
import logging
import time
from typing import Callable, Awaitable, Any

from langchain_core.tools import StructuredTool

import llm_utils
from agents.research_agent import (
    DEFAULT_SYSTEM_PROMPT,
    AgentEvent,
    RecursionBackstopReached,
    ReportSchemaError,
    ResearchAgentError,
    ToolCallLimitReached,
    report_tool_progress,
    run_research_agent,
)
from progress import JobCancelled, JobProgress, StepProgress
from settings import settings
from tools.example_tool import example_processing_step

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
    """Step 1: Collect and prepare data for processing.

    Replace this with your actual data collection logic — API calls,
    database queries, file reads, web scraping, etc.
    """
    # Example: use the example tool for data collection
    collected = await example_processing_step(input_data)

    return {
        "status": "collected",
        "items_count": len(collected.get("items", [])),
        "data": collected,
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
        await progress.update(fraction, message, detail)

    return on_event


async def _step_process_with_ai(input_data: dict, context: dict) -> dict:
    """Step 2: Analyze the collected data with a tool-calling research agent.

    Runs `agents.research_agent.run_research_agent` with the configured LLM and
    the example tool. The agent may call tools in a loop, bounded by
    `settings.research_max_tool_calls` (with a graph recursion backstop).

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
        logger.warning("No LLM configured, returning raw data")
        return {
            "status": "skipped",
            "reason": "no_llm_configured",
        }

    collected_data = context["step_results"].get("Data Collection", {})
    topic = str(input_data.get("query") or "").strip() or "the collected data"

    async def collect(query: str) -> dict:
        """Collect example items related to a query."""
        # A tool can report its own progress; this one only has a single hop,
        # but a slow tool would call this repeatedly as it works.
        await report_tool_progress(0.5, f"Collecting items for '{query}'")
        return await example_processing_step({**input_data, "query": query})

    tools = [StructuredTool.from_function(coroutine=collect, name="collect")]
    system_prompt = (
        f"{DEFAULT_SYSTEM_PROMPT}\n\n"
        "Data already collected for this job:\n"
        f"{json.dumps(collected_data, indent=2, default=str)}"
    )

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
                tools=tools,
                max_tool_calls=settings.research_max_tool_calls,
                system_prompt=system_prompt,
                on_event=on_event,
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
            # The research report has no recommendations; keep the key so
            # downstream consumers see the shape they always did.
            "recommendations": [],
        },
        "research": report.model_dump(),
    }


async def _step_generate_results(input_data: dict, context: dict) -> dict:
    """Step 3: Generate final results from all previous steps.

    Combines data collection and AI processing outputs into
    the final result format.
    """
    collected = context["step_results"].get("Data Collection", {})
    ai_result = context["step_results"].get("AI Processing", {})

    return {
        "status": "generated",
        "summary": ai_result.get("analysis", {}).get("summary", "Processing complete"),
        "items_processed": collected.get("items_count", 0),
        "ai_enhanced": ai_result.get("status") == "processed",
        "insights": ai_result.get("analysis", {}).get("insights", []),
        "recommendations": ai_result.get("analysis", {}).get("recommendations", []),
    }
