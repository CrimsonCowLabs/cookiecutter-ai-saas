# The research agent

The worker's second pipeline step hands off to a bounded, tool-calling
LangGraph agent: `workers/app/agents/research_agent.py`, invoked from
`_step_process_with_ai` in `workers/app/runner.py`. This guide covers what
that agent does today, the loop it runs and the bounds that keep it from
running away, and how to give it a new tool. Everything else about the
pipeline — adding a new step, the step/progress-weight plumbing in
`PIPELINE_STEPS` — belongs to the pipeline guide, not this one.

## The shipped example

A fresh clone does something real on the very first job, and needs no key
beyond a model provider. Submit a URL on the dashboard and the pipeline fetches
that page, reads it with the agent, and returns a report:

```
input:  {"url": "https://example.com/article", "question": "optional focus question"}
output: {"status": "generated", "url", "title", "summary",
         "insights": [...], "sources": [...], "ai_enhanced": bool}
```

`url` is required; `question` is optional.

- **Step 1 "Data Collection"** calls `fetch_url` (`workers/app/tools/fetch_url.py`).
- **Step 2 "AI Processing"** hands the fetched page, plus every discovered tool,
  to the bounded agent in `workers/app/agents/research_agent.py`.
- **Step 3 "Results Generation"** assembles the report above.

The UI is `components/dashboard/new-job-form.tsx` to submit and
`/dashboard/jobs/[id]` for live progress and then the report.

`fetch_url` deliberately needs no API key — that is what keeps a first run free
of third-party signup. Because the URL comes from an end user and the worker
shares a Docker network with Postgres and Redis, the tool treats every request
as hostile: http/https only, and any host resolving to a loopback, private,
link-local, reserved or otherwise non-public address is refused — re-checked on
**every redirect hop**, since validating only the first URL is the usual SSRF
bypass. It caps the response size while reading rather than after, enforces a
timeout, accepts only text-ish content types, and truncates extracted text to a
character budget so a large page cannot blow up the prompt. It does not defend
against DNS rebinding; the module documents that limit rather than implying
coverage it lacks.

When there is no report — no model configured, the page could not be read, the
agent spent its tool-call budget — the job still completes, `ai_enhanced` is
`false`, and `summary` is a plain sentence naming what to change instead of a
bare "Processing complete".

## The loop and its bounds

Step 2 of the pipeline (`_step_process_with_ai` in `workers/app/runner.py`) runs
`workers/app/agents/research_agent.py`, a LangGraph tool-calling agent built
with `langchain.agents.create_agent`. The agent can call tools in a loop — it
gets the whole discovered tool set, so a new tool file reaches it with no change
to `runner.py` — and finishes by submitting a `ResearchReport`, which the step
maps onto `analysis.summary` and `analysis.insights` (the report's findings).
The full report is also under `research`. The agent module is standalone and
takes everything from its caller; it knows nothing about Redis, BullMQ, or
`settings`. You can use it directly:

```python
from agents.research_agent import run_research_agent, ResearchAgentError

report = await run_research_agent(
    "solar power",
    model=llm_utils.get_llm(),   # any LangChain chat model that supports tool calling
    tools=[my_tool],             # any LangChain tools; may be empty
    max_tool_calls=8,            # explicit bound; the call that would exceed it never runs
)
```

Bounds and exit behaviour. A runaway loop cannot run up an unbounded bill:

- `RESEARCH_MAX_TOOL_CALLS` (default 8) is the tool-call limit, the real
  bound; the LangGraph `recursion_limit` is derived from it as a backstop. See
  the `RESEARCH_MAX_TOOL_CALLS` entry under Environment Variables in
  README.md to change it.
- Whatever ends the agent, the job still completes, with the same step
  boundaries (0, 30, 30, 70, 70, 100, 100) however many tool calls ran. The AI step
  returns `{"status": "error", "reason": ..., "error": ...}` and the results
  step reports `ai_enhanced: false`. `reason` is `tool_call_limit`,
  `recursion_limit` or `invalid_report` (a report that does not satisfy the
  schema; no partial report is used). A provider or tool failure gives
  `status: "error"` without a `reason`.
- With no model configured (for example a missing API key) the step returns
  `{"status": "skipped", "reason": "no_llm_configured"}`.
- Every one of those cases becomes a user-facing sentence in the report's
  `summary`, so a job that produced nothing still says why.
- The rate limiter holds one slot for the whole agent run, not one per model
  call, so a run with many tool calls makes more requests than `*_RPM` implies.
- Tests use a scripted fake model (`tests/fakes.py`) and an injected fake
  fetcher, so the whole suite runs with no provider key and no network.

`run_research_agent` also takes `run_config`, LangChain runnable config merged
into the invocation (`metadata`, `tags`, `run_name`, `callbacks`). The AI step
fills it with the job's identity so traces are findable; it cannot loosen the
bounds, because `recursion_limit` always comes from the argument. See the
Tracing section under Environment Variables in README.md for the LangSmith
env vars this feeds.

## Progress and cancellation

The agent's work shows up in the job's live progress, on the same
`job:{id}:progress` Redis channel and SSE stream as the step boundaries.

- Every model step and every tool call emits an event whose percentage falls
  inside the AI step's slice (30 to 70). The slice is split into
  `RESEARCH_MAX_TOOL_CALLS + 1` equal parts, so the bar advances as the agent
  works and cannot pass 70 before the step completes.
- Events carry a `message` (for example `Agent step 2: calling collect`) and a
  `detail` object: `{kind, step, tool_calls, tool?}` with `kind` one of
  `model_start`, `tool_start`, `tool_progress`, `tool_end`. Step-boundary events
  have no `detail`. `job_events.payload` stores the whole event.
- A long-running tool reports its own progress with
  `from agents.research_agent import report_tool_progress` and
  `await report_tool_progress(0.4, "fetched 2 of 5 pages")`. The fraction moves
  the bar within that tool call's part of the slice. It is a no-op outside an
  agent run.
- Overall percentage never decreases (`workers/app/progress.py` clamps it
  server-side); only a `failed` event reports 0.
- Cancellation is checked at every agent event, so a cancelled job stops at the
  next model step, tool start or tool progress report. A tool that never calls
  `report_tool_progress` cannot be interrupted while it runs.
- `run_research_agent(..., on_event=...)` is the generic hook; the module still
  knows nothing about Redis. A listener that raises stops the run.
- `progress_callback` receives `detail=` as a keyword for in-step events, so a
  custom callback needs to accept it.

## Adding a tool

**One new file.** `workers/app/tools/__init__.py` discovers tools, so there is
no registry list to edit:

1. Create `workers/app/tools/my_tool.py`.
2. Expose the callable as a module-level `TOOL`:

   ```python
   from langchain_core.tools import StructuredTool

   async def _summarize(text: str) -> str:
       """Summarize text. The model reads this docstring, so be specific."""
       ...

   TOOL = StructuredTool.from_function(coroutine=_summarize, name="summarize")
   ```

That is the entire change: the AI step passes whatever `discover_tools()`
returns. Modules are visited in sorted order so the tool list — and therefore
the prompt — stays reproducible. A module with no `TOOL` is a plain helper and
is skipped, as are private modules (`_draft.py`) and subpackages. A module that
fails to import, or whose `TOOL` is not a LangChain `BaseTool`, raises
`ToolRegistryError` naming the module: a broken tool is never skipped quietly,
because an agent silently running with fewer tools is the worse failure.
`workers/app/tests/test_tool_registry.py` proves the one-file property.

To use a ready-made tool, add its package (`poetry add langchain-tavily`) and
re-export its tool as `TOOL` from one such file.

`workers/app/tools/fetch_url.py` is the worked example: it is a plain module
with a module-level `TOOL = StructuredTool.from_function(...)` at the bottom,
nothing more — the SSRF guard, redirect handling and the rest of its body are
just the implementation behind that one callable, not anything the discovery
mechanism needs to know about.
