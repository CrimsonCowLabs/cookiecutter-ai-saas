"""The worker publishes agent progress on the existing job:{id}:progress channel."""

import json
from types import SimpleNamespace

import pytest

import worker


class FakeJob:
    data = {"jobId": "j1", "type": "default", "userId": "u", "input": {}}
    attemptsMade = 0

    def __init__(self):
        self.updates = []

    async def updateProgress(self, pct):
        self.updates.append(pct)


@pytest.fixture
def redis(mock_redis, monkeypatch):
    async def get():
        return mock_redis

    monkeypatch.setattr(worker, "get_redis_pub", get)
    return mock_redis


def published(redis):
    return [(c.args[0], json.loads(c.args[1])) for c in redis.publish.await_args_list]


@pytest.mark.asyncio
async def test_detail_reaches_the_progress_channel_and_boundaries_omit_it(redis, monkeypatch):
    async def fake_run_job(progress_callback, **kwargs):
        await progress_callback(30, "Starting", "running", "Starting AI")
        await progress_callback(
            40, "AI Processing", "running", "Agent step 1: calling collect", detail={"kind": "tool_start", "tool": "collect"}
        )
        return {"status": "completed"}

    monkeypatch.setattr(worker, "run_job", fake_run_job)
    job = FakeJob()

    await worker.process_job(job, "token")

    events = [e for channel, e in published(redis) if channel == "job:j1:progress"]
    assert events[0] == {"status": "running", "progress": 30, "message": "Starting AI"}
    assert events[1] == {
        "status": "running",
        "progress": 40,
        "message": "Agent step 1: calling collect",
        "detail": {"kind": "tool_start", "tool": "collect"},
    }
    assert job.updates == [30, 40]


@pytest.mark.asyncio
async def test_cancellation_mid_agent_publishes_cancelled(redis, monkeypatch):
    async def fake_run_job(progress_callback, **kwargs):
        await progress_callback(40, "AI Processing", "running", "x", detail={"kind": "model_start"})
        raise worker.JobCancelled()

    monkeypatch.setattr(worker, "run_job", fake_run_job)

    await worker.process_job(FakeJob(), "token")

    last = [e for channel, e in published(redis) if channel == "job:j1:progress"][-1]
    assert last["status"] == "cancelled"
