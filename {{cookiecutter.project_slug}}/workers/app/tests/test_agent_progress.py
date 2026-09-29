"""Tests for streaming the agent's steps into job progress.

Everything runs offline: the model is scripted and `serve_page` fakes the
fetch tool. Progress is observed through the same `progress_callback` the
BullMQ worker hands to `run_job`.

Reporting a tool's own intermediate progress is unit-tested against the agent
module directly in `test_research_agent_events.py`; the two tests here that
need it stand up a synthetic tool (`discover_tools` is monkeypatched) to check
that it also reaches the real progress channel, mapped into the AI step's band.
"""

import dataclasses

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool

import llm_utils
import runner
from agents.research_agent import report_tool_progress
from progress import JobCancelled, JobProgress
from runner import run_job
from tests.fakes import ScriptedChatModel, tool_call_message

GOOD_REPORT = {
    "topic": "solar power",
    "summary": "Solar output is growing quickly.",
    "key_findings": ["Panels are cheaper"],
    "sources": [],
}
PAGE = "<html><head><title>Solar</title></head><body><p>Panels got cheaper.</p></body></html>"
INPUT_DATA = {"url": "https://example.com/article", "question": "Is solar getting cheaper?"}
AI_BAND = (30, 70)


@pytest.fixture(autouse=True)
def fresh_rate_limiter(monkeypatch):
    limiter = llm_utils.LLMRateLimiter(rpm=6000, max_concurrency=1)
    monkeypatch.setattr(llm_utils, "get_rate_limiter", lambda: limiter)


def script(count):
    """`count` calls of the shipped fetch tool, then a valid report."""
    calls = [
        tool_call_message("fetch_url", {"url": f"https://example.com/link{i}"}, call_id=f"c{i}")
        for i in range(count)
    ]
    return ScriptedChatModel(responses=calls + [tool_call_message("ResearchReport", GOOD_REPORT, call_id="r")])


def use_a_slow_tool(monkeypatch, fraction=0.5, message="halfway"):
    """Swap the agent's tools for one that reports its own progress once.

    Named "slow_tool" so a script can target it instead of the real fetch tool.
    """

    async def run(note: str) -> str:
        """A slow tool, for tests, that reports its own progress once."""
        await report_tool_progress(fraction, message)
        return "done"

    tool = StructuredTool.from_function(coroutine=run, name="slow_tool")
    monkeypatch.setattr(runner, "discover_tools", lambda: [tool])


def slow_tool_calls(count):
    calls = [tool_call_message("slow_tool", {"note": "go"}, call_id=f"c{i}") for i in range(count)]
    return ScriptedChatModel(responses=calls + [tool_call_message("ResearchReport", GOOD_REPORT, call_id="r")])


class Events:
    """Records progress callbacks; `detail` is only passed for agent events."""

    def __init__(self):
        self.items = []

    async def __call__(self, pct, step, status, message, detail=None):
        self.items.append({"pct": pct, "step": step, "status": status, "message": message, "detail": detail})

    def pcts(self):
        return [i["pct"] for i in self.items]

    def agent(self):
        return [i for i in self.items if i["detail"]]


async def run(monkeypatch, model, serve_page, **kwargs):
    serve_page(PAGE)
    monkeypatch.setattr(llm_utils, "get_llm", lambda: model)
    events = Events()
    result = await run_job("job-1", "default", "u", INPUT_DATA, progress_callback=events, **kwargs)
    return events, result


@pytest.mark.asyncio
async def test_every_model_step_and_tool_call_emits_an_event_inside_the_ai_band(monkeypatch, serve_page):
    events, result = await run(monkeypatch, script(2), serve_page)

    assert result["status"] == "completed"
    kinds = [i["detail"]["kind"] for i in events.agent()]
    assert kinds == ["model_start", "tool_start", "tool_end"] * 2 + ["model_start"]
    for item in events.agent():
        assert item["step"] == "AI Processing"
        assert item["status"] == "running"
        assert AI_BAND[0] <= item["pct"] < AI_BAND[1]
        assert item["message"]
    tool_events = [i for i in events.agent() if i["detail"]["kind"] == "tool_start"]
    assert all(i["detail"]["tool"] == "fetch_url" for i in tool_events)
    assert "fetch_url" in tool_events[0]["message"]


@pytest.mark.asyncio
async def test_a_long_running_tool_reports_its_own_progress(monkeypatch, serve_page):
    use_a_slow_tool(monkeypatch)
    events, _ = await run(monkeypatch, slow_tool_calls(1), serve_page)

    (tool_progress,) = [i for i in events.agent() if i["detail"]["kind"] == "tool_progress"]
    start = next(i for i in events.agent() if i["detail"]["kind"] == "tool_start")
    end = next(i for i in events.agent() if i["detail"]["kind"] == "tool_end")
    assert tool_progress["message"]
    assert start["pct"] <= tool_progress["pct"] <= end["pct"]


@pytest.mark.asyncio
async def test_overall_progress_never_goes_backwards(monkeypatch, serve_page):
    for count in (0, 1, 4):
        events, _ = await run(monkeypatch, script(count), serve_page)
        assert events.pcts() == sorted(events.pcts()), count
        assert events.pcts()[0] == 0 and events.pcts()[-1] == 100


@pytest.mark.asyncio
async def test_progress_stays_monotonic_when_the_agent_hits_its_limit(monkeypatch, serve_page):
    monkeypatch.setattr(runner, "settings", dataclasses.replace(runner.settings, research_max_tool_calls=2))
    events, result = await run(monkeypatch, script(10), serve_page)

    assert result["results"]["AI Processing"]["reason"] == "tool_call_limit"
    assert events.pcts() == sorted(events.pcts())


@pytest.mark.asyncio
async def test_step_boundaries_are_unchanged(monkeypatch, serve_page):
    events, _ = await run(monkeypatch, script(3), serve_page)

    boundaries = [i["pct"] for i in events.items if not i["detail"]]
    assert boundaries == [0, 30, 30, 70, 70, 100, 100]


@pytest.mark.asyncio
async def test_a_four_argument_callback_still_works(monkeypatch, serve_page):
    serve_page(PAGE)
    monkeypatch.setattr(llm_utils, "get_llm", lambda: script(1))
    seen = []

    async def old_style(pct, step, status, message):
        seen.append(pct)

    result = await run_job("j", "default", "u", INPUT_DATA, progress_callback=old_style)

    assert result["status"] == "completed"
    assert seen == sorted(seen)


@pytest.mark.asyncio
async def test_cancelling_mid_agent_stops_the_job(monkeypatch, serve_page):
    serve_page(PAGE)
    model = script(5)

    async def cancel_after_first_tool_call():
        # Let the pipeline start, then cancel once the agent is working.
        return any(i["detail"] and i["detail"]["kind"] == "tool_end" for i in events.items)

    events = Events()
    monkeypatch.setattr(llm_utils, "get_llm", lambda: model)

    with pytest.raises(JobCancelled):
        await run_job(
            "j", "default", "u", INPUT_DATA, progress_callback=events, cancel_check=cancel_after_first_tool_call
        )

    # One tool round ran; the agent never made its next model call.
    assert len(model.seen) == 1
    assert not any(i["status"] == "failed" for i in events.items)
    assert not any(i["step"] == "Results Generation" for i in events.items)


@pytest.mark.asyncio
async def test_cancelling_during_a_tool_stops_before_the_tool_finishes(monkeypatch, serve_page):
    serve_page(PAGE)
    use_a_slow_tool(monkeypatch)
    model = slow_tool_calls(3)
    events = Events()

    async def cancel_once_a_tool_reports():
        return any(i["detail"] and i["detail"]["kind"] == "tool_progress" for i in events.items)

    monkeypatch.setattr(llm_utils, "get_llm", lambda: model)
    with pytest.raises(JobCancelled):
        await run_job("j", "default", "u", INPUT_DATA, progress_callback=events, cancel_check=cancel_once_a_tool_reports)

    assert not any(i["detail"] and i["detail"]["kind"] == "tool_end" for i in events.items)


@pytest.mark.asyncio
async def test_a_failing_agent_is_not_reported_as_cancelled_or_failed(monkeypatch, serve_page):
    events, result = await run(monkeypatch, ScriptedChatModel(responses=[AIMessage(content="prose")]), serve_page)

    assert result["status"] == "completed"
    assert result["results"]["AI Processing"]["reason"] == "invalid_report"


@pytest.mark.asyncio
async def test_a_failing_progress_publish_does_not_fail_the_agent(monkeypatch, serve_page):
    serve_page(PAGE)
    monkeypatch.setattr(llm_utils, "get_llm", lambda: script(1))

    async def flaky(pct, step, status, message, detail=None):
        if detail is not None:
            raise ConnectionError("redis down")

    result = await run_job("j", "default", "u", INPUT_DATA, progress_callback=flaky)

    assert result["results"]["AI Processing"]["status"] == "processed"


# JobProgress: the monotonic emitter the runner is built on.


@pytest.mark.asyncio
async def test_job_progress_clamps_a_lower_percentage_up_to_the_last_one():
    events = Events()
    progress = JobProgress(events)

    await progress.emit(50, "s", "running", "a")
    await progress.emit(40, "s", "running", "b")

    assert events.pcts() == [50, 50]


@pytest.mark.asyncio
async def test_job_progress_lets_a_failure_report_zero():
    events = Events()
    progress = JobProgress(events)

    await progress.emit(50, "s", "running", "a")
    await progress.emit(0, "", "failed", "boom")

    assert events.pcts() == [50, 0]


@pytest.mark.asyncio
async def test_step_progress_maps_a_fraction_into_its_band_and_never_reaches_the_end():
    events = Events()
    step = JobProgress(events).step("AI", 30, 70)

    await step.update(0.0, "start")
    await step.update(0.5, "half")
    await step.update(1.0, "over")

    assert events.pcts() == [30, 50, 69]
