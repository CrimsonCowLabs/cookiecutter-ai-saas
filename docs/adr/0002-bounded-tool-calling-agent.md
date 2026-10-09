# 2. The AI step is a tool-calling agent with a hard tool-call limit

**Status:** Accepted. Issues [#13](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/13), [#14](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/14), [#15](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/15) and [#30](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/30).

## Context

The inherited AI step made exactly one model call and parsed the reply. It was
a pipeline step, not an agent. The example tool beside it was never called by
a model, so the tool-extension contract had never been used.

An agent that loops on tool calls spends money on every turn. A template ships
to people who will run it with their own provider key, so a runaway loop is a
billing problem, not just a bug.

## Decision

- Step 2 of the worker pipeline runs a LangGraph tool-calling agent,
  `workers/app/agents/research_agent.py`, built with the current
  `langchain.agents.create_agent` rather than the deprecated prebuilt
  constructor.
- The agent module is standalone and gets everything from its caller: model,
  tools and limits. It knows nothing about Redis, BullMQ or settings, so it can
  be tested with a scripted fake model and no network.
- There are two independent bounds:
  - `max_tool_calls` (`RESEARCH_MAX_TOOL_CALLS`, default 8) is the real limit.
    A call that would exceed it never runs.
  - The LangGraph `recursion_limit` is derived from it
    (`default_recursion_limit`) as a backstop. A caller's `run_config` cannot
    loosen it.
- However the agent ends, the job completes. The limit tripping, an invalid
  report, a provider failure or no model configured each become a status and a
  `reason`, and the report's `summary` says what to change. The job never hangs
  or crashes.
- Progress reporting is best effort. The agent's steps stream into the AI
  step's slice of the progress bar, but a failure to publish progress never
  fails the job.
- Tools are discovered from `workers/app/tools/`, so adding one is a single new
  file. The shipped example (fetch a URL, report on it) needs no key beyond a
  model provider, so a first run shows something real.

## Consequences

- A run costs at most `RESEARCH_MAX_TOOL_CALLS` tool calls plus the model turns
  between them. Raising the limit is an explicit config change.
- The rate limiter holds one slot for the whole run, so a run with many tool
  calls makes more provider requests than the `*_RPM` setting implies.
- Every discovered tool is offered to the model. A tool that reaches outside
  the worker must defend itself; see [ADR-0003](0003-fetch-tool-treats-urls-as-hostile.md).
