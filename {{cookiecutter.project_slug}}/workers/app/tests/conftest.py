"""Pytest fixtures for __PROJECT_NAME__ worker tests."""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_redis():
    """Mock Redis connection for tests."""
    redis = AsyncMock()
    redis.publish = AsyncMock(return_value=1)
    redis.exists = AsyncMock(return_value=0)
    return redis


@pytest.fixture
def mock_llm():
    """Mock LLM for tests that don't need real API calls."""
    llm = MagicMock()
    llm.invoke.return_value = MagicMock(
        content='{"summary": "test", "insights": [], "recommendations": []}'
    )
    return llm


@pytest.fixture
def sample_input_data():
    """Sample job input data: the pipeline's `url` / optional `question` contract."""
    return {
        "url": "https://example.com/article",
        "question": "What does the article claim?",
    }


@pytest.fixture
def sample_job_data(sample_input_data):
    """Sample BullMQ job data."""
    return {
        "jobId": "test-job-123",
        "type": "default",
        "userId": "user-456",
        "input": sample_input_data,
    }


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    """No test may reach the network: the default fetcher refuses to run.

    Tests that need a page use `serve_page`; anything that tries to fetch
    without it fails loudly instead of quietly making a real request.
    """
    from tools import fetch_url

    def refuse(url, **kwargs):
        raise AssertionError(f"a test tried to fetch {url!r} over the network")

    monkeypatch.setattr(fetch_url, "http_get", refuse)


@pytest.fixture(autouse=True)
def fresh_rate_limiter(monkeypatch):
    """A limiter per test, so no test waits on another's rpm spacing.

    Replaces the cached singleton rather than `get_rate_limiter` itself, so a
    test that wants the real construction path still gets it by clearing the
    cache the way production would never need to.
    """
    import llm_utils

    limiter = llm_utils.LLMRateLimiter(rpm=6000, max_concurrency=1)
    monkeypatch.setattr(llm_utils, "_limiter", limiter)
    return limiter


@pytest.fixture(autouse=True)
def no_ambient_tracing(monkeypatch):
    """No test may ship a trace anywhere, whatever the developer has exported.

    Two doors to shut: the environment LangSmith reads at run time, and the
    settings snapshot `tracing` took at import. A developer with
    `LANGSMITH_TRACING` exported would otherwise send every test run's prompts
    to their project. Tests that exercise tracing override these deliberately.
    """
    import dataclasses

    import tracing

    for name in (
        *tracing._TRACING_SWITCHES,
        "LANGSMITH_API_KEY",
        "LANGSMITH_ENDPOINT",
        "LANGSMITH_PROJECT",
        "LANGCHAIN_API_KEY",
        "LANGCHAIN_ENDPOINT",
        "LANGCHAIN_PROJECT",
    ):
        # Recording each name here is also what lets a test call
        # `configure_tracing()` against the real environment and have
        # monkeypatch put it back afterwards.
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(
        tracing,
        "settings",
        dataclasses.replace(
            tracing.settings,
            langsmith_tracing=False,
            langsmith_api_key=None,
            langsmith_endpoint=None,
            langsmith_project=None,
        ),
    )


@pytest.fixture
def serve_page(monkeypatch):
    """Serve canned content to `tools.fetch_url.fetch_page`.

    Call it with the same arguments as `tests.fakes.fake_fetcher`.
    """
    from tests.fakes import fake_fetcher
    from tools import fetch_url

    def serve(*args, **kwargs):
        fetcher = fake_fetcher(*args, **kwargs)
        monkeypatch.setattr(fetch_url, "http_get", fetcher)
        return fetcher

    return serve
