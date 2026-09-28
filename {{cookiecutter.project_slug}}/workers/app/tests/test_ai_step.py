"""Tests for the AI pipeline step, which runs the research agent.

Everything runs offline: the model is a scripted fake and the fetcher is faked,
so no provider key and no network are needed.
"""

import dataclasses

import pytest
from langchain_core.messages import AIMessage, ToolMessage

import llm_utils
import runner
from runner import PIPELINE_STEPS, _step_generate_results, _step_process_with_ai, run_job
from tests.fakes import ScriptedChatModel, tool_call_message
from tools import discover_tools

GOOD_REPORT = {
    "topic": "solar power",
    "summary": "Solar output is growing quickly.",
    "key_findings": ["Panels are cheaper", "Storage lags"],
    "sources": ["https://example.com/article"],
}

PAGE = (
    "<html><head><title>Solar keeps getting cheaper</title></head>"
    "<body><p>Module prices fell again.</p></body></html>"
)

INPUT_DATA = {"url": "https://example.com/article", "question": "Is solar getting cheaper?"}


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
    """`count` calls of the shipped fetch tool, then a valid report."""
    calls = [
        tool_call_message("fetch_url", {"url": f"https://example.com/link{i}"}, call_id=f"c{i}")
        for i in range(count)
    ]
    return calls + [tool_call_message("ResearchReport", GOOD_REPORT, call_id="report")]


def context_with_collected_data(**overrides):
    collected = {
        "status": "collected",
        "url": "https://example.com/article",
        "title": "Solar keeps getting cheaper",
        "chars": 25,
        "truncated": False,
        "text": "Module prices fell again.",
        **overrides,
    }
    return {"step_results": {"Data Collection": collected}}


@pytest.mark.asyncio
async def test_happy_path_calls_the_tool_and_maps_the_report(monkeypatch, serve_page):
    serve_page(PAGE)
    model = ScriptedChatModel(responses=tool_calls(1))
    use_model(monkeypatch, model)

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "processed"
    assert result["analysis"]["summary"] == "Solar output is growing quickly."
    assert result["analysis"]["insights"] == ["Panels are cheaper", "Storage lags"]
    assert result["research"]["sources"] == ["https://example.com/article"]

    # The fetch tool was offered to the model and really ran.
    assert "fetch_url" in model.bound_tool_names
    tool_message = next(m for m in model.seen[1] if isinstance(m, ToolMessage))
    assert "Module prices fell again." in tool_message.content
    # The question and the already-fetched page both reached the model.
    assert "Is solar getting cheaper?" in str(model.seen[0][-1].content)
    system_prompt = str(model.seen[0][0].content)
    assert "https://example.com/article" in system_prompt
    assert "Module prices fell again." in system_prompt
    assert "Solar keeps getting cheaper" in system_prompt


@pytest.mark.asyncio
async def test_every_discovered_tool_reaches_the_agent(monkeypatch):
    """The registry is what the step passes, so a new tool file needs no edit here."""
    model = ScriptedChatModel(responses=tool_calls(0))
    use_model(monkeypatch, model)

    await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    discovered = {tool.name for tool in discover_tools()}
    assert discovered
    assert discovered <= set(model.bound_tool_names)


@pytest.mark.asyncio
async def test_an_added_tool_is_offered_without_touching_this_step(monkeypatch):
    """Whatever `discover_tools` finds is bound — nothing in runner.py lists tools."""
    from langchain_core.tools import StructuredTool

    async def _extra(text: str) -> str:
        """A tool added by dropping in one file."""
        return text

    extra = StructuredTool.from_function(coroutine=_extra, name="brand_new_tool")
    monkeypatch.setattr(runner, "discover_tools", lambda: [*discover_tools(), extra])

    model = ScriptedChatModel(responses=tool_calls(0))
    use_model(monkeypatch, model)

    await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert "brand_new_tool" in model.bound_tool_names


@pytest.mark.asyncio
async def test_mapped_output_feeds_the_results_step_unchanged(monkeypatch):
    use_model(monkeypatch, ScriptedChatModel(responses=tool_calls(0)))
    context = context_with_collected_data()
    context["step_results"]["AI Processing"] = await _step_process_with_ai(INPUT_DATA, context)

    result = await _step_generate_results(INPUT_DATA, context)

    assert result["ai_enhanced"] is True
    assert result["summary"] == "Solar output is growing quickly."
    assert result["insights"] == ["Panels are cheaper", "Storage lags"]
    assert result["sources"] == ["https://example.com/article"]
    assert result["url"] == "https://example.com/article"
    assert result["title"] == "Solar keeps getting cheaper"


@pytest.mark.asyncio
async def test_no_model_configured_skips_the_step(monkeypatch):
    use_model(monkeypatch, None)

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result == {"status": "skipped", "reason": "no_llm_configured"}


@pytest.mark.asyncio
async def test_tool_call_limit_ends_the_step_cleanly(monkeypatch, serve_page):
    serve_page(PAGE)
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
async def test_tool_call_limit_comes_from_settings(monkeypatch, serve_page):
    serve_page(PAGE)
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
async def test_a_provider_failure_ends_the_step_cleanly(monkeypatch):
    class ExplodingModel(ScriptedChatModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            raise RuntimeError("provider is down")

    use_model(monkeypatch, ExplodingModel(responses=[]))

    result = await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    assert result["status"] == "error"
    assert "provider is down" in result["error"]
    assert "reason" not in result


@pytest.mark.asyncio
async def test_no_question_still_researches_the_page(monkeypatch):
    model = ScriptedChatModel(responses=tool_calls(0))
    use_model(monkeypatch, model)

    result = await _step_process_with_ai({"url": "https://example.com/article"}, context_with_collected_data())

    assert result["status"] == "processed"
    assert "https://example.com/article" in str(model.seen[0][-1].content)


@pytest.mark.asyncio
async def test_the_step_runs_even_when_collection_failed(monkeypatch):
    """The agent still has the fetch tool, so a failed step 1 is not fatal."""
    model = ScriptedChatModel(responses=tool_calls(0))
    use_model(monkeypatch, model)
    context = {"step_results": {"Data Collection": {"status": "error", "reason": "fetch_failed"}}}

    result = await _step_process_with_ai(INPUT_DATA, context)

    assert result["status"] == "processed"
    system_prompt = str(model.seen[0][0].content)
    assert "No page content was collected" in system_prompt
    assert "fetch_failed" in system_prompt


@pytest.mark.asyncio
async def test_truncation_is_flagged_to_the_model(monkeypatch):
    model = ScriptedChatModel(responses=tool_calls(0))
    use_model(monkeypatch, model)

    await _step_process_with_ai(INPUT_DATA, context_with_collected_data(truncated=True))

    assert "(truncated)" in str(model.seen[0][0].content)


@pytest.mark.asyncio
async def test_limiter_is_released_after_a_failed_run(monkeypatch, fresh_rate_limiter):
    use_model(monkeypatch, ScriptedChatModel(responses=[AIMessage(content="just prose")]))

    await _step_process_with_ai(INPUT_DATA, context_with_collected_data())

    # max_concurrency is 1: a leaked permit would make this hang.
    await fresh_rate_limiter.acquire()
    fresh_rate_limiter.release()


# --------------------------------------------------------------------------
# run_job end to end
# --------------------------------------------------------------------------


async def progress_of(monkeypatch, model, input_data=INPUT_DATA):
    use_model(monkeypatch, model)
    events = []

    async def record(pct, step, status, message):
        events.append((pct, step, status, message))

    result = await run_job("job-1", "default", "user-1", input_data, progress_callback=record)
    return events, result


@pytest.mark.asyncio
async def test_run_job_reaches_100_and_returns_the_final_report(monkeypatch, serve_page):
    serve_page(PAGE)

    events, result = await progress_of(monkeypatch, ScriptedChatModel(responses=tool_calls(1)))

    assert result["status"] == "completed"
    assert events[-1] == (100, "Complete", "completed", "Job completed")

    report = result["results"]["Results Generation"]
    assert report == {
        "status": "generated",
        "url": "https://example.com/article",
        "title": "Solar keeps getting cheaper",
        "summary": "Solar output is growing quickly.",
        "insights": ["Panels are cheaper", "Storage lags"],
        "sources": ["https://example.com/article"],
        "ai_enhanced": True,
    }


@pytest.mark.asyncio
async def test_run_job_completes_with_an_actionable_report_when_no_model_is_set(monkeypatch, serve_page):
    serve_page(PAGE)

    _, result = await progress_of(monkeypatch, None)

    report = result["results"]["Results Generation"]
    assert result["status"] == "completed"
    assert report["ai_enhanced"] is False
    assert report["title"] == "Solar keeps getting cheaper"
    assert "LLM_PROVIDER" in report["summary"]


@pytest.mark.asyncio
async def test_run_job_completes_when_the_url_is_missing(monkeypatch, serve_page):
    serve_page(PAGE)

    _, result = await progress_of(monkeypatch, ScriptedChatModel(responses=tool_calls(0)), input_data={})

    assert result["status"] == "completed"
    assert result["results"]["Data Collection"]["reason"] == "no_url"


def fail_to_fetch(monkeypatch):
    from tools.fetch_url import FetchError

    async def fail(url, **kwargs):
        raise FetchError("'https://example.com/article' returned HTTP 404")

    monkeypatch.setattr(runner, "fetch_page", fail)


@pytest.mark.asyncio
async def test_run_job_completes_when_the_fetch_fails(monkeypatch):
    """Step 1 failing is not fatal: the agent still has the fetch tool itself."""
    fail_to_fetch(monkeypatch)

    _, result = await progress_of(monkeypatch, ScriptedChatModel(responses=tool_calls(0)))

    assert result["status"] == "completed"
    assert result["results"]["Data Collection"]["reason"] == "fetch_failed"
    report = result["results"]["Results Generation"]
    assert report["ai_enhanced"] is True
    # Nothing was fetched, so the URL falls back to the job input.
    assert report["url"] == "https://example.com/article"
    assert report["title"] == ""


@pytest.mark.asyncio
async def test_run_job_explains_a_fetch_failure_when_there_is_no_model(monkeypatch):
    fail_to_fetch(monkeypatch)

    _, result = await progress_of(monkeypatch, None)

    assert result["status"] == "completed"
    report = result["results"]["Results Generation"]
    assert report["ai_enhanced"] is False
    assert "page could not be read" in report["summary"]
    assert "HTTP 404" in report["summary"]


@pytest.mark.asyncio
async def test_progress_is_identical_however_many_tool_calls_run(monkeypatch, serve_page):
    serve_page(PAGE)
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
async def test_job_completes_when_the_tool_limit_is_exceeded(monkeypatch, serve_page):
    serve_page(PAGE)
    set_tool_call_limit(monkeypatch, 1)
    _, result = await progress_of(monkeypatch, ScriptedChatModel(responses=tool_calls(5)))

    assert result["status"] == "completed"
    assert result["results"]["AI Processing"]["reason"] == "tool_call_limit"
    report = result["results"]["Results Generation"]
    assert report["ai_enhanced"] is False
    assert report["insights"] == []
    assert "RESEARCH_MAX_TOOL_CALLS" in report["summary"]
