"""Tests for the AI pipeline step, which runs the research agent.

Everything runs offline: the model is a scripted fake, so no provider key or
network is needed.
"""

import dataclasses

import pytest
from langchain_core.messages import AIMessage, ToolMessage

import llm_utils
import runner
from runner import PIPELINE_STEPS, _step_generate_results, _step_process_with_ai, run_job
from tests.fakes import ScriptedChatModel, tool_call_message

GOOD_REPORT = {
    "topic": "solar power",
    "summary": "Solar output is growing quickly.",
    "key_findings": ["Panels are cheaper", "Storage lags"],
    "sources": ["notes/solar"],
}

INPUT_DATA = {"query": "solar power"}


@pytest.fixture(autouse=True)
def fresh_rate_limiter(monkeypatch):
    """A limiter per test, so no test waits on another's rpm spacing."""
    limiter = llm_utils.LLMRateLimiter(rpm=6000, max_concurrency=1)
    monkeypatch.setattr(llm_utils, "get_rate_limiter", lambda: limiter)
    return limiter


def use_model(monkeypatch, model):
    monkeypatch.setattr(llm_utils, "get_llm", lambda: model)


def set_tool_call_limit(monkeypatch, limit):
    # Settings is a frozen dataclass, so swap the whole object the runner reads.
    monkeypatch.setattr(runner, "settings", dataclasses.replace(runner.settings, research_max_tool_calls=limit))


def tool_calls(count):
    """`count` calls of the pipeline's example tool, then a valid report."""
    calls = [tool_call_message("collect", {"query": "solar"}, call_id=f"c{i}") for i in range(count)]
    return calls + [tool_call_message("ResearchReport", GOOD_REPORT, call_id="report")]


def context_with_collected_data():
    return {"step_results": {"Data Collection": {"status": "collected", "items_count": 2, "data": {"items": [1, 2]}}}}


@pytest.mark.asyncio
async def test_happy_path_calls_the_tool_and_maps_the_report(monkeypatch):
    model = ScriptedChatModel(responses=tool_calls(1))
    use_model(monkeypatch, model)

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "processed"
    assert result["analysis"]["summary"] == "Solar output is growing quickly."
    assert result["analysis"]["insights"] == ["Panels are cheaper", "Storage lags"]
    assert result["analysis"]["recommendations"] == []
    assert result["research"]["sources"] == ["notes/solar"]

    # The example tool was offered to the model and really ran.
    assert "collect" in model.bound_tool_names
    tool_message = next(m for m in model.seen[1] if isinstance(m, ToolMessage))
    assert "Result for: solar" in tool_message.content
    # The topic and the already-collected data both reached the model.
    assert "solar power" in str(model.seen[0][-1].content)
    assert '"items_count": 2' in str(model.seen[0][0].content)


@pytest.mark.asyncio
async def test_mapped_output_feeds_the_results_step_unchanged(monkeypatch):
    use_model(monkeypatch, ScriptedChatModel(responses=tool_calls(1)))
    context = context_with_collected_data()
    context["step_results"]["AI Processing"] = await _step_process_with_ai(INPUT_DATA, context)

    result = await _step_generate_results(INPUT_DATA, context)

    assert result["ai_enhanced"] is True
    assert result["summary"] == "Solar output is growing quickly."
    assert result["insights"] == ["Panels are cheaper", "Storage lags"]
    assert result["recommendations"] == []


@pytest.mark.asyncio
async def test_no_model_configured_skips_the_step(monkeypatch):
    use_model(monkeypatch, None)

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result == {"status": "skipped", "reason": "no_llm_configured"}


@pytest.mark.asyncio
async def test_tool_call_limit_ends_the_step_cleanly(monkeypatch):
    set_tool_call_limit(monkeypatch, 2)
    model = ScriptedChatModel(responses=tool_calls(10))
    use_model(monkeypatch, model)

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "error"
    assert result["reason"] == "tool_call_limit"
    assert "2" in result["error"]
    # Two tool rounds ran, the third model reply tripped the limit.
    assert len(model.seen) == 3


@pytest.mark.asyncio
async def test_tool_call_limit_comes_from_settings(monkeypatch):
    set_tool_call_limit(monkeypatch, 1)
    use_model(monkeypatch, ScriptedChatModel(responses=tool_calls(2)))

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["reason"] == "tool_call_limit"


@pytest.mark.asyncio
async def test_schema_failure_ends_the_step_cleanly(monkeypatch):
    bad = {k: v for k, v in GOOD_REPORT.items() if k != "summary"}
    use_model(monkeypatch, ScriptedChatModel(responses=[tool_call_message("ResearchReport", bad)]))

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "error"
    assert result["reason"] == "invalid_report"
    assert "analysis" not in result


@pytest.mark.asyncio
async def test_free_text_answer_ends_the_step_cleanly(monkeypatch):
    use_model(monkeypatch, ScriptedChatModel(responses=[AIMessage(content="just prose")]))

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "error"
    assert result["reason"] == "invalid_report"


@pytest.mark.asyncio
async def test_blank_query_still_runs_on_the_collected_data(monkeypatch):
    use_model(monkeypatch, ScriptedChatModel(responses=tool_calls(0)))

    result = await _step_process_with_ai({}, context_with_collected_data())

    assert result["status"] == "processed"


@pytest.mark.asyncio
async def test_limiter_is_released_after_a_failed_run(monkeypatch, fresh_rate_limiter):
    use_model(monkeypatch, ScriptedChatModel(responses=[AIMessage(content="just prose")]))

    await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    # max_concurrency is 1: a leaked permit would make this hang.
    await fresh_rate_limiter.acquire()
    fresh_rate_limiter.release()


async def progress_of(monkeypatch, model):
    use_model(monkeypatch, model)
    events = []

    async def record(pct, step, status, message, detail=None):
        # Step-boundary events only; the agent's own events are covered in
        # test_agent_progress.py.
        if detail is None:
            events.append((pct, step, status, message))

    result = await run_job("job-1", "default", "user-1", INPUT_DATA, progress_callback=record)
    return events, result


@pytest.mark.asyncio
async def test_step_boundaries_are_identical_however_many_tool_calls_run(monkeypatch):
    runs = {
        "zero calls": ScriptedChatModel(responses=tool_calls(0)),
        "three calls": ScriptedChatModel(responses=tool_calls(3)),
        "limit exceeded": ScriptedChatModel(responses=tool_calls(20)),
        "schema failure": ScriptedChatModel(responses=[AIMessage(content="prose")]),
        "no model": None,
    }
    observed = {}
    for name, model in runs.items():
        events, result = await progress_of(monkeypatch, model)
        assert result["status"] == "completed", name
        observed[name] = events

    expected = observed["zero calls"]
    # Two events per step plus the final one, at fixed percentages.
    assert len(expected) == 2 * len(PIPELINE_STEPS) + 1
    assert [e[0] for e in expected] == [0, 30, 30, 70, 70, 100, 100]
    for name, events in observed.items():
        assert events == expected, name


@pytest.mark.asyncio
async def test_job_completes_when_the_tool_limit_is_exceeded(monkeypatch):
    set_tool_call_limit(monkeypatch, 1)
    _, result = await progress_of(monkeypatch, ScriptedChatModel(responses=tool_calls(5)))

    assert result["status"] == "completed"
    assert result["results"]["AI Processing"]["reason"] == "tool_call_limit"
    assert result["results"]["Results Generation"]["ai_enhanced"] is False
