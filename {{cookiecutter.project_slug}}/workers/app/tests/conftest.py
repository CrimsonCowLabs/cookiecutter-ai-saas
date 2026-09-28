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
