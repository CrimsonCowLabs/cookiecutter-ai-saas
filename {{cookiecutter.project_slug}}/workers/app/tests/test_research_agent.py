"""Tests for the standalone research agent.

Everything runs offline: the model is a scripted fake, the tools are local.
"""

import subprocess
import sys
from pathlib import Path

import pytest
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.retrievers import BaseRetriever
from langchain_core.tools import StructuredTool
from langchain_core.tools.retriever import create_retriever_tool

from agents.research_agent import (
    RecursionBackstopReached,
    ReportSchemaError,
    ResearchAgentError,
    ResearchReport,
    ToolCallLimitReached,
    run_research_agent,
)
from tests.fakes import ScriptedChatModel, tool_call_message

APP_DIR = Path(__file__).resolve().parent.parent

GOOD_REPORT = {
    "topic": "solar power",
    "summary": "Solar output is growing quickly.",
    "key_findings": ["Panels are cheaper", "Storage lags"],
    "sources": ["notes/solar"],
}


class KeywordRetriever(BaseRetriever):
    """Tiny in-memory retriever: returns documents whose text mentions the query."""

    docs: list[Document]

    def _get_relevant_documents(self, query, *, run_manager=None):
        words = query.lower().split()
        return [d for d in self.docs if any(w in d.page_content.lower() for w in words)]


@pytest.fixture
def search_tool():
    """A ready-made retriever tool over a two-document corpus."""
    retriever = KeywordRetriever(
        docs=[
            Document(page_content="Solar panels got cheaper.", metadata={"source": "notes/solar"}),
            Document(page_content="Wind farms need storage.", metadata={"source": "notes/wind"}),
        ]
    )
    return create_retriever_tool(retriever, "search_notes", "Search the research notes.")


@pytest.fixture
def counting_tool():
    """A tool that counts its executions, so tests can assert on real calls."""
    calls = []

    def lookup(query: str) -> str:
        calls.append(query)
        return f"result {len(calls)} for {query}"

    tool = StructuredTool.from_function(lookup, name="lookup", description="Look something up.")
    return tool, calls


@pytest.mark.asyncio
async def test_returns_typed_report_after_calling_the_tool(search_tool):
    model = ScriptedChatModel(
        responses=[
            tool_call_message("search_notes", {"query": "solar"}, call_id="c1"),
            tool_call_message("ResearchReport", GOOD_REPORT, call_id="c2"),
        ]
    )

    report = await run_research_agent("solar power", model=model, tools=[search_tool])

    assert isinstance(report, ResearchReport)
    assert report.topic == "solar power"
    assert report.key_findings == ["Panels are cheaper", "Storage lags"]
    assert report.sources == ["notes/solar"]

    # The model was offered the caller's tool plus the report schema...
    assert set(model.bound_tool_names) == {"search_notes", "ResearchReport"}
    # ...the topic reached it...
    assert "solar power" in str(model.seen[0][-1].content)
    # ...and the retriever tool really ran: its output came back to the model.
    tool_messages = [m for m in model.seen[1] if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 1
    assert tool_messages[0].name == "search_notes"
    assert "Solar panels got cheaper." in tool_messages[0].content


@pytest.mark.asyncio
async def test_existing_example_tool_can_be_handed_to_the_agent():
    """The worker's example tool becomes an agent tool without modification."""
    from tools.example_tool import example_processing_step

    async def collect(query: str) -> dict:
        """Collect example items for a query."""
        return await example_processing_step({"query": query})

    tool = StructuredTool.from_function(coroutine=collect, name="collect")
    model = ScriptedChatModel(
        responses=[
            tool_call_message("collect", {"query": "solar"}, call_id="c1"),
            tool_call_message("ResearchReport", GOOD_REPORT, call_id="c2"),
        ]
    )

    await run_research_agent("solar power", model=model, tools=[tool])

    tool_message = next(m for m in model.seen[1] if isinstance(m, ToolMessage))
    assert "Result for: solar" in tool_message.content


@pytest.mark.asyncio
async def test_works_with_no_tools():
    model = ScriptedChatModel(responses=[tool_call_message("ResearchReport", GOOD_REPORT)])

    report = await run_research_agent("solar power", model=model, tools=[])

    assert report.summary == "Solar output is growing quickly."


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_args",
    [
        {k: v for k, v in GOOD_REPORT.items() if k != "summary"},  # missing field
        {**GOOD_REPORT, "key_findings": "not a list"},  # wrong type
        {**GOOD_REPORT, "key_findings": []},  # violates min_length
        {**GOOD_REPORT, "summary": ""},  # violates min_length
    ],
    ids=["missing-field", "wrong-type", "empty-findings", "empty-summary"],
)
async def test_schema_violation_is_a_typed_failure_not_a_partial_report(bad_args):
    # A second, valid response is queued: a retry must not silently repair it.
    model = ScriptedChatModel(
        responses=[
            tool_call_message("ResearchReport", bad_args),
            tool_call_message("ResearchReport", GOOD_REPORT),
        ]
    )

    with pytest.raises(ReportSchemaError) as excinfo:
        await run_research_agent("solar power", model=model, tools=[])

    assert isinstance(excinfo.value, ResearchAgentError)
    assert len(model.seen) == 1


@pytest.mark.asyncio
async def test_free_text_answer_is_a_typed_failure():
    model = ScriptedChatModel(responses=[AIMessage(content="Solar is great, trust me.")])

    with pytest.raises(ReportSchemaError):
        await run_research_agent("solar power", model=model, tools=[])


@pytest.mark.asyncio
async def test_tool_call_limit_ends_the_run_with_a_typed_failure(counting_tool):
    counting_tool, calls = counting_tool
    # The model would call the tool forever.
    model = ScriptedChatModel(
        responses=[tool_call_message("lookup", {"query": "x"}, call_id=f"c{i}") for i in range(20)]
    )

    with pytest.raises(ToolCallLimitReached) as excinfo:
        await run_research_agent("topic", model=model, tools=[counting_tool], max_tool_calls=3)

    assert isinstance(excinfo.value, ResearchAgentError)
    assert excinfo.value.limit == 3
    # Exactly the allowed calls ran; the one over the limit never executed.
    assert len(calls) == 3
    assert len(model.seen) == 4


@pytest.mark.asyncio
async def test_a_batch_that_would_exceed_the_limit_runs_nothing(counting_tool):
    counting_tool, calls = counting_tool
    batch = AIMessage(
        content="",
        tool_calls=[
            {"name": "lookup", "args": {"query": q}, "id": f"c{q}"} for q in ("a", "b", "c")
        ],
    )
    model = ScriptedChatModel(responses=[batch])

    with pytest.raises(ToolCallLimitReached):
        await run_research_agent("topic", model=model, tools=[counting_tool], max_tool_calls=2)

    assert calls == []


@pytest.mark.asyncio
async def test_a_run_within_the_limit_is_unaffected(counting_tool):
    counting_tool, calls = counting_tool
    model = ScriptedChatModel(
        responses=[
            tool_call_message("lookup", {"query": "a"}, call_id="c1"),
            tool_call_message("lookup", {"query": "b"}, call_id="c2"),
            tool_call_message("ResearchReport", GOOD_REPORT, call_id="c3"),
        ]
    )

    await run_research_agent("topic", model=model, tools=[counting_tool], max_tool_calls=2)

    assert calls == ["a", "b"]


@pytest.mark.asyncio
async def test_recursion_limit_is_the_backstop(counting_tool):
    counting_tool, calls = counting_tool
    model = ScriptedChatModel(
        responses=[tool_call_message("lookup", {"query": "x"}, call_id=f"c{i}") for i in range(50)]
    )

    # The tool-call limit is far away, so only the recursion limit can stop this.
    with pytest.raises(RecursionBackstopReached) as excinfo:
        await run_research_agent(
            "topic",
            model=model,
            tools=[counting_tool],
            max_tool_calls=40,
            recursion_limit=6,
        )

    assert isinstance(excinfo.value, ResearchAgentError)
    assert len(calls) < 40


@pytest.mark.asyncio
async def test_default_recursion_limit_leaves_room_for_the_tool_limit(counting_tool):
    """The backstop must not cut in before the explicit limit does."""
    counting_tool, _ = counting_tool
    model = ScriptedChatModel(
        responses=[tool_call_message("lookup", {"query": "x"}, call_id=f"c{i}") for i in range(50)]
    )

    with pytest.raises(ToolCallLimitReached):
        await run_research_agent("topic", model=model, tools=[counting_tool], max_tool_calls=12)


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [{"max_tool_calls": 0}, {"max_tool_calls": -1}, {"recursion_limit": 0}])
async def test_rejects_nonsensical_bounds(kwargs):
    model = ScriptedChatModel(responses=[])

    with pytest.raises(ValueError):
        await run_research_agent("topic", model=model, tools=[], **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("topic", ["", "   "])
async def test_rejects_blank_topic(topic):
    with pytest.raises(ValueError):
        await run_research_agent(topic, model=ScriptedChatModel(responses=[]), tools=[])


def test_module_imports_without_worker_plumbing():
    """No settings singleton, Redis, or BullMQ is pulled in by the module."""
    code = (
        "import sys\n"
        "import agents.research_agent\n"
        "bad = [m for m in ('settings', 'llm_utils', 'runner', 'redis', 'bullmq') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=APP_DIR, capture_output=True, text=True, check=False, env={"PATH": ""}
    )
    assert result.returncode == 0, result.stderr
