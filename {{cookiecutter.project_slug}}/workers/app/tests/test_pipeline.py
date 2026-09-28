"""Tests for pipeline steps 1 and 3 — collection and the user-visible report.

Offline throughout: the fetcher is faked by the `serve_page` fixture, and
`block_network` makes any unfaked fetch fail loudly.
"""

import functools

import pytest

import runner
from tests.fakes import public_resolver
from runner import PIPELINE_STEPS, _step_collect_data, _step_generate_results
# Bound at import time, before `block_network` swaps the module attribute out.
from tools.fetch_url import FetchError, http_get as real_http_get

ARTICLE = (
    "<html><head><title>Solar keeps getting cheaper</title></head>"
    "<body><nav>Menu</nav><h1>Solar</h1><p>Module prices fell again.</p></body></html>"
)

REPORT_KEYS = {"status", "url", "title", "summary", "insights", "sources", "ai_enhanced"}


def collected(**overrides) -> dict:
    base = {
        "status": "collected",
        "url": "https://example.com/article",
        "title": "Solar keeps getting cheaper",
        "chars": 34,
        "truncated": False,
        "text": "Solar\nModule prices fell again.",
    }
    return {**base, **overrides}


def processed(summary="Prices fell.", insights=("Modules are cheaper",), sources=("https://example.com/article",)):
    return {
        "status": "processed",
        "analysis": {"summary": summary, "insights": list(insights)},
        "research": {
            "topic": "solar",
            "summary": summary,
            "key_findings": list(insights),
            "sources": list(sources),
        },
    }


def context(data_collection: dict, ai_processing: dict) -> dict:
    return {"step_results": {"Data Collection": data_collection, "AI Processing": ai_processing}}


# --------------------------------------------------------------------------
# The pipeline's shape has not drifted
# --------------------------------------------------------------------------


def test_step_names_are_unchanged():
    """worker.py's progress publishing and the frontend key off these names."""
    assert [name for name, _, _ in PIPELINE_STEPS] == [
        "Data Collection",
        "AI Processing",
        "Results Generation",
    ]


# --------------------------------------------------------------------------
# Step 1: Data Collection
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_collect_data_returns_the_fetched_page(serve_page, sample_input_data):
    serve_page(ARTICLE)

    result = await _step_collect_data(sample_input_data, {"step_results": {}})

    assert result["status"] == "collected"
    assert result["url"] == "https://example.com/article"
    assert result["title"] == "Solar keeps getting cheaper"
    assert result["text"] == "Solar\nModule prices fell again."
    assert result["chars"] == len(result["text"])
    assert result["truncated"] is False
    assert "Menu" not in result["text"]


@pytest.mark.asyncio
async def test_collect_data_reports_truncation(serve_page, monkeypatch):
    monkeypatch.setattr(runner, "fetch_page", _truncating_fetch)
    result = await _step_collect_data({"url": "https://example.com/big"}, {"step_results": {}})

    assert result["truncated"] is True


async def _truncating_fetch(url, **kwargs):
    from tools.fetch_url import PageContent

    return PageContent(url=url, title="Big", text="x" * 10, chars=10, truncated=True, content_type="text/html")


@pytest.mark.asyncio
@pytest.mark.parametrize("input_data", [{}, {"url": ""}, {"url": "   "}, {"url": None}, {"question": "why?"}])
async def test_collect_data_without_a_url_is_a_structured_error(input_data):
    result = await _step_collect_data(input_data, {"step_results": {}})

    assert result["status"] == "error"
    assert result["reason"] == "no_url"
    assert "url" in result["error"]


@pytest.mark.asyncio
async def test_collect_data_turns_a_fetch_failure_into_a_structured_error(monkeypatch):
    async def fail(url, **kwargs):
        raise FetchError("refusing to fetch 'internal': it resolves to a loopback address")

    monkeypatch.setattr(runner, "fetch_page", fail)

    result = await _step_collect_data({"url": "http://internal/"}, {"step_results": {}})

    assert result["status"] == "error"
    assert result["reason"] == "fetch_failed"
    assert result["url"] == "http://internal/"
    assert "loopback" in result["error"]


@pytest.mark.asyncio
async def test_collect_data_ends_cleanly_when_the_ssrf_guard_refuses(monkeypatch):
    """A hostile URL ends the step cleanly, and no connection is ever opened."""
    from tools import fetch_url

    def never_opens(request, timeout):
        raise AssertionError("the guard let a loopback address through")

    monkeypatch.setattr(
        fetch_url,
        "http_get",
        functools.partial(real_http_get, opener=never_opens, resolve=public_resolver("127.0.0.1")),
    )

    result = await _step_collect_data({"url": "http://db.internal/"}, {"step_results": {}})

    assert result["status"] == "error"
    assert result["reason"] == "fetch_failed"
    assert "loopback" in result["error"]


# --------------------------------------------------------------------------
# Step 3: Results Generation
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_results_emits_exactly_the_documented_keys():
    result = await _step_generate_results({}, context(collected(), processed()))

    assert set(result) == REPORT_KEYS


@pytest.mark.asyncio
async def test_generate_results_drops_the_vestigial_keys():
    result = await _step_generate_results({}, context(collected(), processed()))

    assert "items_processed" not in result
    assert "recommendations" not in result


@pytest.mark.asyncio
async def test_generate_results_carries_the_report_through():
    result = await _step_generate_results({}, context(collected(), processed()))

    assert result["status"] == "generated"
    assert result["ai_enhanced"] is True
    assert result["url"] == "https://example.com/article"
    assert result["title"] == "Solar keeps getting cheaper"
    assert result["summary"] == "Prices fell."
    assert result["insights"] == ["Modules are cheaper"]
    assert result["sources"] == ["https://example.com/article"]


@pytest.mark.asyncio
async def test_insights_come_from_the_reports_key_findings():
    ai_result = processed(insights=("one", "two", "three"))

    result = await _step_generate_results({}, context(collected(), ai_result))

    assert result["insights"] == ai_result["research"]["key_findings"]


@pytest.mark.asyncio
async def test_sources_fall_back_to_the_page_when_the_report_cites_none():
    result = await _step_generate_results({}, context(collected(), processed(sources=())))

    assert result["sources"] == ["https://example.com/article"]


@pytest.mark.asyncio
async def test_the_url_falls_back_to_the_job_input_when_nothing_was_fetched():
    ctx = context({"status": "error", "reason": "fetch_failed", "error": "boom"}, {"status": "skipped"})

    result = await _step_generate_results({"url": "https://example.com/gone"}, ctx)

    assert result["url"] == "https://example.com/gone"
    assert result["sources"] == ["https://example.com/gone"]
    assert result["title"] == ""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ai_result,expected",
    [
        ({"status": "skipped", "reason": "no_llm_configured"}, "LLM_PROVIDER"),
        ({"status": "error", "reason": "tool_call_limit", "error": "limit 2"}, "RESEARCH_MAX_TOOL_CALLS"),
        ({"status": "error", "reason": "recursion_limit", "error": "limit 42"}, "step limit"),
        ({"status": "error", "reason": "invalid_report", "error": "bad"}, "report format"),
        ({"status": "error", "error": "provider exploded"}, "provider exploded"),
        ({"status": "error", "error": "Connection error."}, "LLM_PROVIDER"),
    ],
)
async def test_a_missing_analysis_is_explained_in_plain_language(ai_result, expected):
    result = await _step_generate_results({}, context(collected(), ai_result))

    assert result["ai_enhanced"] is False
    assert result["insights"] == []
    assert expected in result["summary"]
    assert result["summary"] != "Processing complete"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data_collection,expected",
    [
        ({"status": "error", "reason": "no_url", "error": "Job input has no 'url' to fetch."}, "no URL to read"),
        ({"status": "error", "reason": "fetch_failed", "error": "HTTP 404"}, "HTTP 404"),
    ],
)
async def test_a_collection_failure_is_reported_over_the_ai_step(data_collection, expected):
    """Collection failing is the root cause, so that is what the user is told."""
    ctx = context(data_collection, {"status": "skipped", "reason": "no_llm_configured"})

    result = await _step_generate_results({}, ctx)

    assert result["ai_enhanced"] is False
    assert expected in result["summary"]


@pytest.mark.asyncio
async def test_generate_results_survives_missing_step_results():
    result = await _step_generate_results({}, {"step_results": {}})

    assert set(result) == REPORT_KEYS
    assert result["ai_enhanced"] is False
    assert result["summary"]
