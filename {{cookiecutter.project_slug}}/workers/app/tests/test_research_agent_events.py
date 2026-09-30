"""Tests for the research agent's event stream (`on_event`) and tool progress.

Offline: the model is a scripted fake.
"""

import pytest
from langchain_core.tools import StructuredTool

from agents.research_agent import report_tool_progress, run_research_agent
from tests.fakes import ScriptedChatModel, tool_call_message

REPORT = {"topic": "t", "summary": "s", "key_findings": ["f"], "sources": []}


def report_message():
    return tool_call_message("ResearchReport", REPORT, call_id="report")


def make_tool(name="lookup", body=None):
    async def run(query: str) -> str:
        if body is not None:
            await body()
        return "ok"

    run.__doc__ = "Look something up."
    return StructuredTool.from_function(coroutine=run, name=name)


class Recorder:
    def __init__(self):
        self.events = []

    async def __call__(self, event):
        self.events.append(event)

    def kinds(self):
        return [e.kind for e in self.events]


@pytest.mark.asyncio
async def test_emits_an_event_for_every_model_step_and_tool_call():
    model = ScriptedChatModel(
        responses=[
            tool_call_message("lookup", {"query": "a"}, call_id="c1"),
            tool_call_message("lookup", {"query": "b"}, call_id="c2"),
            report_message(),
        ]
    )
    rec = Recorder()

    await run_research_agent("t", model=model, tools=[make_tool()], on_event=rec)

    assert rec.kinds() == [
        "model_start",
        "tool_start",
        "tool_end",
        "model_start",
        "tool_start",
        "tool_end",
        "model_start",
    ]
    assert [e.step for e in rec.events if e.kind == "model_start"] == [1, 2, 3]
    assert [e.tool for e in rec.events if e.kind != "model_start"] == ["lookup"] * 4
    # tool_calls_done counts finished calls: it moves at tool_end, not tool_start.
    assert [e.tool_calls_done for e in rec.events] == [0, 0, 1, 1, 1, 2, 2]


@pytest.mark.asyncio
async def test_a_tool_can_report_intermediate_progress():
    async def body():
        await report_tool_progress(0.25, "fetching page 1")
        await report_tool_progress(0.75, "fetching page 2")

    model = ScriptedChatModel(responses=[tool_call_message("lookup", {"query": "a"}), report_message()])
    rec = Recorder()

    await run_research_agent("t", model=model, tools=[make_tool(body=body)], on_event=rec)

    assert rec.kinds() == ["model_start", "tool_start", "tool_progress", "tool_progress", "tool_end", "model_start"]
    progress = [e for e in rec.events if e.kind == "tool_progress"]
    assert [(e.tool, e.fraction, e.message) for e in progress] == [
        ("lookup", 0.25, "fetching page 1"),
        ("lookup", 0.75, "fetching page 2"),
    ]


@pytest.mark.asyncio
async def test_report_tool_progress_outside_an_agent_is_a_no_op():
    await report_tool_progress(0.5, "nobody is listening")


@pytest.mark.asyncio
async def test_run_without_a_listener_is_unchanged():
    async def body():
        await report_tool_progress(0.5, "still fine")

    model = ScriptedChatModel(responses=[tool_call_message("lookup", {"query": "a"}), report_message()])

    result = await run_research_agent("t", model=model, tools=[make_tool(body=body)])

    assert result.summary == "s"


class Stop(Exception):
    pass


@pytest.mark.asyncio
async def test_a_listener_error_stops_the_run_before_the_next_model_call():
    model = ScriptedChatModel(
        responses=[tool_call_message("lookup", {"query": "a"}), tool_call_message("lookup", {"query": "b"}), report_message()]
    )

    async def stop_after_first_tool(event):
        if event.kind == "tool_end":
            raise Stop()

    with pytest.raises(Stop):
        await run_research_agent("t", model=model, tools=[make_tool()], on_event=stop_after_first_tool)

    assert len(model.seen) == 1


@pytest.mark.asyncio
async def test_a_listener_error_on_tool_start_means_the_tool_never_runs():
    ran = []

    async def body():
        ran.append(1)

    model = ScriptedChatModel(responses=[tool_call_message("lookup", {"query": "a"}), report_message()])

    async def stop(event):
        if event.kind == "tool_start":
            raise Stop()

    with pytest.raises(Stop):
        await run_research_agent("t", model=model, tools=[make_tool(body=body)], on_event=stop)

    assert ran == []


@pytest.mark.asyncio
async def test_a_listener_error_from_tool_progress_interrupts_a_running_tool():
    reached_end = []

    async def body():
        await report_tool_progress(0.5, "halfway")
        reached_end.append(1)

    model = ScriptedChatModel(responses=[tool_call_message("lookup", {"query": "a"}), report_message()])

    async def stop(event):
        if event.kind == "tool_progress":
            raise Stop()

    with pytest.raises(Stop):
        await run_research_agent("t", model=model, tools=[make_tool(body=body)], on_event=stop)

    assert reached_end == []


@pytest.mark.asyncio
async def test_progress_fraction_is_clamped_to_the_unit_interval():
    async def body():
        await report_tool_progress(7, "too far")
        await report_tool_progress(-1)

    model = ScriptedChatModel(responses=[tool_call_message("lookup", {"query": "a"}), report_message()])
    rec = Recorder()

    await run_research_agent("t", model=model, tools=[make_tool(body=body)], on_event=rec)

    assert [e.fraction for e in rec.events if e.kind == "tool_progress"] == [1.0, 0.0]
