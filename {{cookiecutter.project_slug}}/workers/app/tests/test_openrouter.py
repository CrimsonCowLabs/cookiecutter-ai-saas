"""Tests for the OpenRouter provider (OpenAI-compatible, base-URL variant)."""

import dataclasses
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import llm_utils
from runner import run_job


def _use_settings(monkeypatch, **overrides):
    """Swap the frozen settings object for a modified copy."""
    monkeypatch.setattr(
        llm_utils, "settings", dataclasses.replace(llm_utils.settings, **overrides)
    )


@pytest.fixture
def fake_openrouter():
    """Local fake OpenAI-compatible server that records requests."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(
                {"path": self.path, "auth": self.headers.get("Authorization"), "body": body}
            )
            reply = json.dumps(
                {
                    "id": "gen-1",
                    "object": "chat.completion",
                    "created": 0,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": '{"summary": "fake", "insights": ["i1"], "recommendations": ["r1"]}',
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/api/v1", requests
    server.shutdown()


def test_openrouter_without_key_returns_none(monkeypatch):
    _use_settings(monkeypatch, llm_provider="openrouter", openrouter_api_key=None)
    assert llm_utils.get_llm() is None


def test_openrouter_defaults_to_openrouter_base_url(monkeypatch):
    _use_settings(
        monkeypatch,
        llm_provider="openrouter",
        openrouter_api_key="sk-or-test",
        openrouter_base_url=None,
        openrouter_model=None,
    )
    llm = llm_utils.get_llm()
    assert str(llm.openai_api_base) == "https://openrouter.ai/api/v1"
    assert llm.model_name == "openai/gpt-4o-mini"


@pytest.mark.asyncio
async def test_job_runs_end_to_end_with_openrouter(monkeypatch, fake_openrouter):
    base_url, requests = fake_openrouter
    _use_settings(
        monkeypatch,
        llm_provider="openrouter",
        openrouter_api_key="sk-or-test",
        openrouter_base_url=base_url,
        openrouter_model="anthropic/claude-3.5-sonnet",
    )

    result = await run_job("job-1", "default", "user-1", {"query": "test query"})

    assert len(requests) == 1
    assert requests[0]["path"] == "/api/v1/chat/completions"
    assert requests[0]["auth"] == "Bearer sk-or-test"
    assert requests[0]["body"]["model"] == "anthropic/claude-3.5-sonnet"
    assert result["status"] == "completed"
    ai = result["results"]["AI Processing"]
    assert ai["status"] == "processed"
    assert ai["analysis"]["summary"] == "fake"
    assert result["results"]["Results Generation"]["ai_enhanced"] is True


def test_rate_limiter_uses_openrouter_limits(monkeypatch):
    _use_settings(
        monkeypatch,
        llm_provider="openrouter",
        openrouter_rpm=120,
        openrouter_max_concurrency=7,
        openai_rpm=1,
        ollama_rpm=1,
    )
    monkeypatch.setattr(llm_utils, "_limiter", None)
    limiter = llm_utils.get_rate_limiter()
    assert limiter.min_interval == pytest.approx(0.5)
    assert limiter._sem._value == 7
    monkeypatch.setattr(llm_utils, "_limiter", None)
