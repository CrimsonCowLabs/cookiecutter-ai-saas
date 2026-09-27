"""Standalone research agent.

A tool-calling agent that takes a research topic and returns a typed report.

This module has no dependency on the worker's job plumbing: no Redis, BullMQ,
progress channel, or settings singleton. The caller supplies the chat model and
the tools, so tests can pass a scripted fake model and callers can pass
whatever `llm_utils.get_llm()` (or anything else) built.

Bounds (both explicit, both surfacing as `ResearchAgentError` subclasses):

- `max_tool_calls` is the real limit: at most that many tool calls run in one
  call to `run_research_agent`. Reaching it raises `ToolCallLimitReached`; the
  call that would exceed it never executes.
- `recursion_limit` is the LangGraph backstop for anything the tool-call limit
  cannot see (for example a model that never stops). It raises
  `RecursionBackstopReached`.

Events (optional): pass `on_event` to be told about every model step and tool
call as it happens (`AgentEvent`). A tool can report its own intermediate
progress with `report_tool_progress`. The listener may raise: the exception
stops the run at that point and propagates unchanged, which is how a caller
cancels an agent that is mid-run. The module still knows nothing about the
channel the events end up on.

Output is bound to `ResearchReport`. A generation that does not satisfy the
schema (or is free text) raises `ReportSchemaError`; a partial report is never
returned and the model is not re-prompted to repair it.
"""

from __future__ import annotations

import contextvars
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, after_model
from langchain.agents.structured_output import StructuredOutputError, ToolStrategy
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import BaseTool
from langgraph.errors import GraphRecursionError
from pydantic import BaseModel, Field

DEFAULT_MAX_TOOL_CALLS = 8

DEFAULT_SYSTEM_PROMPT = (
    "You are a research assistant. Investigate the topic the user gives you, "
    "using the available tools when they help. When you are done, submit your "
    "findings with the structured report tool; do not answer in free text."
)


class ResearchReport(BaseModel):
    """The agent's result. The model's final answer is bound to this schema."""

    topic: str = Field(min_length=1, description="The topic that was researched.")
    summary: str = Field(min_length=1, description="A short overall summary.")
    key_findings: list[str] = Field(min_length=1, description="The main findings, one per item.")
    sources: list[str] = Field(description="Where the findings came from; empty if no source applies.")


class ResearchAgentError(Exception):
    """Base class for every failure `run_research_agent` reports. Catch this to end cleanly."""


class ToolCallLimitReached(ResearchAgentError):
    """The agent asked for more tool calls than `max_tool_calls` allows."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(f"Research agent exceeded its limit of {limit} tool calls")


class RecursionBackstopReached(ResearchAgentError):
    """The graph hit `recursion_limit` before producing a report."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(f"Research agent hit the graph recursion limit of {limit}")


class ReportSchemaError(ResearchAgentError):
    """The model's output did not satisfy `ResearchReport`."""


EventKind = Literal["model_start", "tool_start", "tool_progress", "tool_end"]


@dataclass(frozen=True)
class AgentEvent:
    """One thing the agent did, as reported to `on_event`.

    `step` is the 1-based model step. `tool_calls_done` counts tool calls that
    have finished (it moves on `tool_end`). `tool`, `fraction` (0..1, clamped)
    and `message` are set only where they apply.
    """

    kind: EventKind
    step: int
    tool_calls_done: int
    tool: str | None = None
    fraction: float | None = None
    message: str | None = None


EventListener = Callable[[AgentEvent], Awaitable[None]]

# The progress reporter of the tool call currently running, if any. A
# ContextVar so concurrent tool calls each report as themselves.
_tool_reporter: contextvars.ContextVar[Callable[[float | None, str | None], Awaitable[None]] | None] = (
    contextvars.ContextVar("research_agent_tool_reporter", default=None)
)


async def report_tool_progress(fraction: float | None = None, message: str | None = None) -> None:
    """Report intermediate progress from inside a running (async) tool.

    `fraction` is how far through the tool is (0..1; clamped). Does nothing
    when no listener is attached or when called outside an agent tool call.
    """
    reporter = _tool_reporter.get()
    if reporter is not None:
        await reporter(fraction, message)


def _event_middleware(on_event: EventListener) -> AgentMiddleware:
    """Middleware that turns graph activity into `AgentEvent`s for `on_event`."""
    state = {"step": 0, "done": 0}

    class Events(AgentMiddleware):
        async def abefore_model(self, agent_state, runtime):
            state["step"] += 1
            await on_event(AgentEvent("model_start", state["step"], state["done"]))
            return None

        async def awrap_tool_call(self, request, handler):
            name = request.tool_call["name"]
            step = state["step"]

            async def report(fraction: float | None, message: str | None) -> None:
                if fraction is not None:
                    fraction = min(1.0, max(0.0, float(fraction)))
                await on_event(AgentEvent("tool_progress", step, state["done"], name, fraction, message))

            await on_event(AgentEvent("tool_start", step, state["done"], name))
            token = _tool_reporter.set(report)
            try:
                result = await handler(request)
            finally:
                _tool_reporter.reset(token)
            state["done"] += 1
            await on_event(AgentEvent("tool_end", step, state["done"], name))
            return result

    return Events()


def default_recursion_limit(max_tool_calls: int) -> int:
    """Backstop sized so the tool-call limit always trips first.

    One tool round trip is four graph steps (model, the two after-model checks,
    tools); the rest is headroom for the final model step that emits the report.
    """
    return 4 * max_tool_calls + 10


def _tool_call_limit(max_tool_calls: int):
    """Middleware that raises `ToolCallLimitReached` before the over-limit call runs.

    Counts every tool call the model has requested so far, except the call that
    submits the report: that is the exit, not work, so it must not eat the
    budget. (langchain's `ToolCallLimitMiddleware` counts it, so it is not used.)
    Raising before the tools node means nothing from the offending batch executes.
    """

    @after_model
    def check(state, runtime):
        requested = sum(
            1
            for message in state["messages"]
            if isinstance(message, AIMessage)
            for call in message.tool_calls
            if call["name"] != ResearchReport.__name__
        )
        if requested > max_tool_calls:
            raise ToolCallLimitReached(max_tool_calls)

    return check


@after_model(can_jump_to=["end"])
def _end_on_free_text(state, runtime):
    """Stop as soon as the model answers without calling a tool.

    With tools, that already ends the loop; with no tools, langchain would
    re-prompt the model until the recursion limit. Either way the run ends here
    with no report, which `run_research_agent` reports as `ReportSchemaError`.
    """
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and not last.tool_calls:
        return {"jump_to": "end"}
    return None


async def run_research_agent(
    topic: str,
    *,
    model: BaseChatModel,
    tools: Sequence[BaseTool],
    max_tool_calls: int = DEFAULT_MAX_TOOL_CALLS,
    recursion_limit: int | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    on_event: EventListener | None = None,
) -> ResearchReport:
    """Research `topic` with `model` and `tools` and return a validated report.

    Args:
        topic: What to research. Must not be blank.
        model: Chat model supplied by the caller; it must support tool calling.
        tools: Tools the model may call (may be empty).
        max_tool_calls: Upper bound on tool calls in this run. Must be >= 1.
        recursion_limit: LangGraph backstop; defaults to `default_recursion_limit`.
        system_prompt: Overrides the default instructions.
        on_event: Async listener called for each `AgentEvent`. If it raises,
            the run stops there and the exception propagates unchanged.

    Raises:
        ValueError: `topic` is blank or a bound is not positive.
        ToolCallLimitReached: the agent exceeded `max_tool_calls`.
        RecursionBackstopReached: the graph hit `recursion_limit`.
        ReportSchemaError: the model's output did not satisfy `ResearchReport`.

    Errors raised by the model or a tool themselves propagate unchanged.
    """
    if not topic.strip():
        raise ValueError("topic must not be blank")
    if max_tool_calls < 1:
        raise ValueError("max_tool_calls must be at least 1")
    if recursion_limit is None:
        recursion_limit = default_recursion_limit(max_tool_calls)
    elif recursion_limit < 1:
        raise ValueError("recursion_limit must be at least 1")

    middleware = [_tool_call_limit(max_tool_calls), _end_on_free_text]
    if on_event is not None:
        middleware.append(_event_middleware(on_event))

    agent = create_agent(
        model,
        tools=list(tools),
        system_prompt=system_prompt,
        # handle_errors=False: invalid output raises instead of re-prompting the
        # model, so a bad generation can never be quietly patched into a report.
        response_format=ToolStrategy(ResearchReport, handle_errors=False),
        middleware=middleware,
    )

    try:
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": f"Research topic: {topic.strip()}"}]},
            config={"recursion_limit": recursion_limit},
        )
    except GraphRecursionError as exc:
        raise RecursionBackstopReached(recursion_limit) from exc
    except StructuredOutputError as exc:
        raise ReportSchemaError(str(exc)) from exc

    report = result.get("structured_response")
    if not isinstance(report, ResearchReport):
        raise ReportSchemaError("Model finished without submitting a ResearchReport")
    return report
