"""Opt-in LangSmith tracing for the worker.

Tracing is **off** unless it is asked for. A deployment that never sets
`LANGSMITH_TRACING` sends nothing anywhere, and that is the default: traces
carry the prompts and completions of whoever uses the app, so shipping them to
a third party has to be a decision somebody made on purpose.

Opting in takes two variables:

    LANGSMITH_TRACING=true
    LANGSMITH_API_KEY=lsv2_...

and optionally `LANGSMITH_ENDPOINT` (a self-hosted LangSmith instead of the
hosted collector) and `LANGSMITH_PROJECT` (which project the runs land in).

`configure_tracing` is the only authority over the environment LangSmith reads:
it writes those variables from settings at startup, clears every on switch it
does not set — including the legacy `LANGCHAIN_TRACING_V2`, `LANGCHAIN_TRACING`
and `LANGCHAIN_HANDLER` spellings — and drops LangSmith's memoised view of the
environment so the result takes effect. A variable inherited from the
surrounding shell therefore cannot turn tracing on behind the worker's back,
and the two v1 switches cannot break every model call, which is what LangChain
does when it finds one of them set.

Everything here fails open. `configure_tracing` never raises: a misconfigured
environment leaves tracing off and the worker running. Once tracing is on,
delivery is LangSmith's background thread, and LangChain swallows callback
failures, so an unreachable collector costs a log line, not a job.
"""

from __future__ import annotations

import logging
import os
from collections.abc import MutableMapping
from contextlib import suppress
from dataclasses import dataclass

from settings import settings

logger = logging.getLogger("tracing")

HOSTED_ENDPOINT = "https://api.smith.langchain.com"
DEFAULT_PROJECT = "default"

# What a trace calls a job nobody signed in for.
ANONYMOUS_USER = "anonymous"

# Every variable that switches tracing on, current and legacy. The last two
# select the retired v1 tracer: LangChain raises on *every* model call if one
# of them is set while v2 is off, so an inherited shell variable would break
# each job rather than merely tracing it. Clearing them is not tidiness.
_TRACING_SWITCHES = (
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_HANDLER",
)

_OFF_REASONS = {
    "not_enabled": "LANGSMITH_TRACING is not set",
    "no_api_key": "LANGSMITH_TRACING is set but LANGSMITH_API_KEY is empty",
    "configuration_failed": "the LangSmith environment could not be written",
}


@dataclass(frozen=True)
class TracingStatus:
    """What `configure_tracing` decided, in a form worth logging.

    `reason` is a stable code: `enabled`, or one of `not_enabled`,
    `no_api_key`, `configuration_failed`.
    """

    enabled: bool
    reason: str
    endpoint: str = ""
    project: str = ""

    def describe(self) -> str:
        if self.enabled:
            return f"LangSmith tracing enabled: project '{self.project}' at {self.endpoint}"
        return f"LangSmith tracing disabled ({_OFF_REASONS.get(self.reason, self.reason)})"


def configure_tracing(env: MutableMapping[str, str] | None = None) -> TracingStatus:
    """Apply the tracing settings to `env` (the process environment by default).

    Call this once, before any model runs. Safe to call again: it recomputes
    the whole LangSmith environment from settings rather than adding to it.

    Returns:
        The resulting `TracingStatus`. Never raises — a failure is reported as
        a disabled status, because a broken collector must not stop the worker.
    """
    env = os.environ if env is None else env

    try:
        status = _apply(env)
        _reread_by_langsmith()
    except Exception as exc:
        logger.warning("Could not configure LangSmith tracing: %s", exc)
        _force_off(env)
        status = TracingStatus(enabled=False, reason="configuration_failed")

    log = logger.warning if status.reason in ("no_api_key", "configuration_failed") else logger.info
    log("%s", status.describe())
    return status


def job_trace_config(
    *,
    job_id: str | None,
    job_type: str | None,
    user_id: str | None,
) -> dict:
    """LangChain run config that labels one job's model run.

    Pass the result to `run_research_agent(run_config=...)`. When tracing is
    on, LangSmith records it as the run's name, tags and metadata, which is
    what makes a trace findable: the job it came from, the kind of job it was
    and who asked for it. When tracing is off, nothing reads it.
    """
    job_type = job_type or "unknown"
    return {
        "run_name": f"job:{job_type}",
        "tags": [f"job_type:{job_type}"],
        "metadata": {
            "job_id": job_id or "unknown",
            "job_type": job_type,
            "user_id": user_id or ANONYMOUS_USER,
        },
    }


def _apply(env: MutableMapping[str, str]) -> TracingStatus:
    """Write the LangSmith environment. The on switch is written last, so a
    failure part way through leaves tracing off rather than half-configured."""
    _clear_switches(env)

    if not settings.langsmith_tracing:
        env["LANGSMITH_TRACING"] = "false"
        return TracingStatus(enabled=False, reason="not_enabled")

    if not settings.langsmith_api_key:
        env["LANGSMITH_TRACING"] = "false"
        return TracingStatus(enabled=False, reason="no_api_key")

    endpoint = settings.langsmith_endpoint or HOSTED_ENDPOINT
    project = settings.langsmith_project or DEFAULT_PROJECT

    env["LANGSMITH_API_KEY"] = settings.langsmith_api_key
    env["LANGSMITH_ENDPOINT"] = endpoint
    env["LANGSMITH_PROJECT"] = project
    env["LANGSMITH_TRACING"] = "true"

    return TracingStatus(enabled=True, reason="enabled", endpoint=endpoint, project=project)


def _reread_by_langsmith() -> None:
    """Drop LangSmith's cached view of the environment.

    LangSmith reads each variable once and memoises the answer for the life of
    the process, so anything that asked before this ran would otherwise pin
    the stale value — the difference between configuring tracing and it
    actually taking effect.
    """
    from langsmith import utils as langsmith_utils

    langsmith_utils.get_env_var.cache_clear()


def _clear_switches(env: MutableMapping[str, str]) -> None:
    for name in _TRACING_SWITCHES:
        env.pop(name, None)


def _force_off(env: MutableMapping[str, str]) -> None:
    """Best effort: leave nothing switched on after a failed configuration.

    Already on the failure path, so an environment that cannot even be read
    must not raise a second time.
    """
    with suppress(Exception):
        _clear_switches(env)
