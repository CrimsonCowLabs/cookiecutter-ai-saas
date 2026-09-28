"""Tests for opt-in LangSmith tracing.

Nothing here turns tracing on for real: the environment LangSmith reads is a
plain dict the tests own, and the "collector" is a callback handler. No trace
ever leaves the test process.
"""

import dataclasses

import pytest
from langchain_core.callbacks.base import BaseCallbackHandler

import runner
import tracing
from agents.research_agent import RecursionBackstopReached, run_research_agent
from runner import _step_process_with_ai, run_job
from tests.fakes import ScriptedChatModel, tool_call_message

GOOD_REPORT = {
    "topic": "solar power",
    "summary": "Solar output is growing quickly.",
    "key_findings": ["Panels are cheaper"],
    "sources": [],
}

PAGE = "<html><head><title>Solar</title></head><body><p>Cheaper again.</p></body></html>"


def report_only():
    """A model that submits a valid report on its first turn."""
    return ScriptedChatModel(responses=[tool_call_message("ResearchReport", GOOD_REPORT, "report")])


def configure(monkeypatch, env=None, **overrides):
    """Run `configure_tracing` against a throwaway environment and settings.

    The baseline is the all-off settings the `no_ambient_tracing` fixture
    installs, so `overrides` is the whole of what this test configures however
    the developer's own shell is set up.
    """
    monkeypatch.setattr(tracing, "settings", dataclasses.replace(tracing.settings, **overrides))
    env = {} if env is None else env
    return tracing.configure_tracing(env), env


def run_a_job(monkeypatch, serve_page):
    """One whole job over a canned page, with a model that reports first turn."""
    serve_page(PAGE)
    monkeypatch.setattr(runner.llm_utils, "get_llm", report_only)
    return run_job("job-1", "report", "user-3", {"url": "https://example.com/article"})


# --------------------------------------------------------------------------
# configure_tracing
# --------------------------------------------------------------------------


def test_tracing_is_off_when_nothing_is_configured(monkeypatch):
    status, env = configure(monkeypatch)

    assert status.enabled is False
    assert status.reason == "not_enabled"
    assert env["LANGSMITH_TRACING"] == "false"


def test_an_ambient_switch_cannot_turn_tracing_on(monkeypatch):
    """A stray LANGCHAIN_TRACING_V2 in the environment is not "explicitly configured"."""
    status, env = configure(monkeypatch, env={"LANGCHAIN_TRACING_V2": "true"})

    assert status.enabled is False
    assert env["LANGSMITH_TRACING"] == "false"
    assert "LANGCHAIN_TRACING_V2" not in env


def test_tracing_needs_an_api_key(monkeypatch):
    status, env = configure(monkeypatch, langsmith_tracing=True, langsmith_api_key=None)

    assert status.enabled is False
    assert status.reason == "no_api_key"
    assert env["LANGSMITH_TRACING"] == "false"


def test_configured_tracing_writes_the_langsmith_environment(monkeypatch):
    status, env = configure(monkeypatch, langsmith_tracing=True, langsmith_api_key="lsv2-key")

    assert status.enabled is True
    assert status.endpoint == tracing.HOSTED_ENDPOINT
    assert env["LANGSMITH_TRACING"] == "true"
    assert env["LANGSMITH_API_KEY"] == "lsv2-key"
    assert env["LANGSMITH_ENDPOINT"] == tracing.HOSTED_ENDPOINT


def test_a_self_hosted_collector_is_used_as_given(monkeypatch):
    status, env = configure(
        monkeypatch,
        langsmith_tracing=True,
        langsmith_api_key="lsv2-key",
        langsmith_endpoint="http://langsmith.internal:8000/api",
        langsmith_project="nightly",
    )

    assert status.enabled is True
    assert status.endpoint == "http://langsmith.internal:8000/api"
    assert status.project == "nightly"
    assert env["LANGSMITH_ENDPOINT"] == "http://langsmith.internal:8000/api"
    assert env["LANGSMITH_PROJECT"] == "nightly"


def test_a_broken_environment_disables_tracing_instead_of_raising(monkeypatch):
    class ReadOnlyEnv(dict):
        def __setitem__(self, key, value):
            raise RuntimeError("environment is read-only")

    status, env = configure(
        monkeypatch,
        env=ReadOnlyEnv(),
        langsmith_tracing=True,
        langsmith_api_key="lsv2-key",
    )

    assert status.enabled is False
    assert status.reason == "configuration_failed"
    # Nothing was left half-written that could switch tracing on.
    assert "LANGSMITH_TRACING" not in env


def test_the_status_describes_itself_for_the_startup_log(monkeypatch):
    on, _ = configure(monkeypatch, langsmith_tracing=True, langsmith_api_key="k")
    off, _ = configure(monkeypatch, langsmith_tracing=False)

    assert tracing.HOSTED_ENDPOINT in on.describe()
    assert "disabled" in off.describe()


# --------------------------------------------------------------------------
# job_trace_config
# --------------------------------------------------------------------------


def test_trace_config_carries_job_identity_type_and_user():
    config = tracing.job_trace_config(job_id="job-1", job_type="report", user_id="user-9")

    assert config["metadata"] == {
        "job_id": "job-1",
        "job_type": "report",
        "user_id": "user-9",
    }
    assert "job_type:report" in config["tags"]
    assert "report" in config["run_name"]


def test_trace_config_names_a_missing_user_rather_than_leaving_a_blank():
    config = tracing.job_trace_config(job_id="job-1", job_type="report", user_id=None)

    assert config["metadata"]["user_id"] == tracing.ANONYMOUS_USER


# --------------------------------------------------------------------------
# What reaches the agent run
# --------------------------------------------------------------------------


class RecordingHandler(BaseCallbackHandler):
    """Stands in for the collector: records what LangChain would have sent."""

    def __init__(self):
        self.metadata = []
        self.tags = []
        self.names = []

    def on_chain_start(self, serialized, inputs, *, metadata=None, tags=None, **kwargs):
        self.metadata.append(dict(metadata or {}))
        self.tags.append(list(tags or []))
        self.names.append(kwargs.get("name"))


@pytest.mark.asyncio
async def test_run_config_reaches_the_graph():
    handler = RecordingHandler()

    await run_research_agent(
        "solar power",
        model=report_only(),
        tools=[],
        run_config={
            "metadata": {"job_id": "job-1"},
            "tags": ["job_type:report"],
            "run_name": "job:report",
            "callbacks": [handler],
        },
    )

    assert any(m.get("job_id") == "job-1" for m in handler.metadata)
    assert any("job_type:report" in t for t in handler.tags)
    assert "job:report" in handler.names


@pytest.mark.asyncio
async def test_run_config_cannot_loosen_the_recursion_backstop():
    """The bound is an argument, not something a caller's config can raise."""
    from langchain_core.tools import StructuredTool

    async def _echo(text: str) -> str:
        """Echo text back."""
        return text

    looping = ScriptedChatModel(
        responses=[tool_call_message("echo", {"text": "x"}, f"c{i}") for i in range(10)]
    )

    with pytest.raises(RecursionBackstopReached) as caught:
        await run_research_agent(
            "solar power",
            model=looping,
            tools=[StructuredTool.from_function(coroutine=_echo, name="echo")],
            max_tool_calls=50,
            recursion_limit=2,
            run_config={"recursion_limit": 10_000},
        )

    assert caught.value.limit == 2


@pytest.mark.asyncio
async def test_a_collector_that_fails_on_every_event_does_not_fail_the_run():
    """An unreachable collector surfaces as callbacks raising. The job wins."""

    class Unreachable(BaseCallbackHandler):
        def __getattribute__(self, name):
            if name.startswith("on_"):
                def fail(*args, **kwargs):
                    raise RuntimeError("collector is unreachable")

                return fail
            return object.__getattribute__(self, name)

    report = await run_research_agent(
        "solar power",
        model=report_only(),
        tools=[],
        run_config={"callbacks": [Unreachable()]},
    )

    assert report.summary == GOOD_REPORT["summary"]


@pytest.mark.asyncio
async def test_the_ai_step_traces_the_job_it_is_running(monkeypatch):
    """Job identity reaches the agent from the pipeline context, not from settings."""
    captured = {}
    real = runner.run_research_agent

    async def capture(topic, **kwargs):
        captured.update(kwargs.get("run_config") or {})
        return await real(topic, **kwargs)

    monkeypatch.setattr(runner, "run_research_agent", capture)
    monkeypatch.setattr(runner.llm_utils, "get_llm", report_only)

    await _step_process_with_ai(
        {"url": "https://example.com/article"},
        {
            "job_id": "job-77",
            "job_type": "report",
            "user_id": "user-3",
            "step_results": {"Data Collection": {"status": "error", "reason": "fetch_failed"}},
        },
    )

    assert captured["metadata"] == {
        "job_id": "job-77",
        "job_type": "report",
        "user_id": "user-3",
    }


# --------------------------------------------------------------------------
# The real process environment, which is what the worker configures at startup
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_job_runs_normally_with_tracing_unconfigured(monkeypatch, serve_page):
    """Not a dict this time: LangChain's own view of the environment is off."""
    from langsmith.utils import tracing_is_enabled

    status = tracing.configure_tracing()

    result = await run_a_job(monkeypatch, serve_page)

    assert status.enabled is False
    assert tracing_is_enabled() is False
    assert result["status"] == "completed"
    assert result["results"]["Results Generation"]["ai_enhanced"] is True


def test_configuring_tracing_really_switches_langchain_on(monkeypatch):
    """No model runs here, so nothing is sent; only the switch is asserted."""
    from langsmith.utils import tracing_is_enabled

    monkeypatch.setattr(
        tracing,
        "settings",
        dataclasses.replace(
            tracing.settings,
            langsmith_tracing=True,
            langsmith_api_key="lsv2-key",
            langsmith_endpoint="http://langsmith.invalid:8000/api",
        ),
    )

    status = tracing.configure_tracing()

    assert status.enabled is True
    assert tracing_is_enabled() is True


@pytest.mark.asyncio
async def test_an_inherited_v1_switch_cannot_break_every_job(monkeypatch, serve_page):
    """`LANGCHAIN_TRACING` selects a tracer LangChain removed.

    Left in place it raises on every model call, so an exported variable
    nobody remembers would turn each job into a report-less one. Clearing it
    is what makes "disabled unless configured" true rather than merely off.
    """
    monkeypatch.setenv("LANGCHAIN_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_HANDLER", "langchain")

    tracing.configure_tracing()

    result = await run_a_job(monkeypatch, serve_page)

    assert result["results"]["Results Generation"]["ai_enhanced"] is True


@pytest.mark.asyncio
async def test_the_worker_configures_tracing_before_it_takes_work(monkeypatch):
    """Startup order is the whole guarantee: settle tracing, then accept jobs."""
    import worker as worker_module

    class Started(Exception):
        """Ends `main`'s idle loop once the worker is up."""

    async def stop(_seconds):
        raise Started

    order = []
    monkeypatch.setattr(worker_module, "configure_tracing", lambda: order.append("tracing"))
    monkeypatch.setattr(worker_module, "Worker", lambda *args, **kwargs: order.append("worker"))
    monkeypatch.setattr(worker_module.asyncio, "sleep", stop)

    with pytest.raises(Started):
        await worker_module.main()

    assert order == ["tracing", "worker"]
