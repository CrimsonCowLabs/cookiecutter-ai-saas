"""The worker refuses a job the web app should never have queued.

lib/job-submission.ts admits only registered job types with input that passed
their schema; this is the backstop for anything put on the queue some other
way, so it never reaches a model.
"""

import json

import pytest

import worker
from job_input import (
    MAX_QUESTION_LENGTH,
    MAX_URL_LENGTH,
    InvalidJobInput,
    check_job_input,
)

URL = "https://example.com/article"


def test_a_valid_url_report_passes():
    check_job_input("url-report", {"url": URL, "question": "What is it about?"})
    check_job_input("url-report", {"url": URL})


@pytest.mark.parametrize(
    "job_type, input_data",
    [
        ("unregistered-type", {"url": URL}),
        ("default", {"url": URL}),
        ("url-report", "not a dict"),
        ("url-report", {"url": URL, "extra": "x"}),
        ("url-report", {"url": 42}),
        ("url-report", {"url": "h" * (MAX_URL_LENGTH + 1)}),
        ("url-report", {"url": URL, "question": ["x"]}),
        ("url-report", {"url": URL, "question": "x" * (MAX_QUESTION_LENGTH + 1)}),
        ("url-report", {"url": URL, "question": "x" * 1_000_000}),
    ],
)
def test_anything_else_is_refused(job_type, input_data):
    with pytest.raises(InvalidJobInput):
        check_job_input(job_type, input_data)


def test_the_limits_match_the_web_apps():
    assert (MAX_URL_LENGTH, MAX_QUESTION_LENGTH) == (2048, 500)


class FakeJob:
    attemptsMade = 0

    def __init__(self, data):
        self.data = data

    async def updateProgress(self, pct):
        pass


@pytest.mark.asyncio
async def test_a_refused_job_fails_without_running_or_retrying(mock_redis, monkeypatch):
    async def get():
        return mock_redis

    async def run_job(**kwargs):
        raise AssertionError("a refused job must not run")

    monkeypatch.setattr(worker, "get_redis_pub", get)
    monkeypatch.setattr(worker, "run_job", run_job)
    job = FakeJob({"jobId": "j1", "type": "unregistered-type", "userId": "u", "input": {"question": "x" * 1_000_000}})

    # Returns rather than raising: BullMQ retries a job that raises, and this
    # input will never become valid.
    await worker.process_job(job, "token")

    events = [json.loads(c.args[1]) for c in mock_redis.publish.await_args_list]
    assert [e["status"] for e in events] == ["failed"]
