"""BullMQ consumer for __PROJECT_NAME__ jobs."""

import asyncio
import json
import os
import logging

from bullmq import Worker
import redis.asyncio as aioredis

from runner import run_job, JobCancelled
from tracing import configure_tracing

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("worker")

# Suppress noisy retry logs from OpenAI SDK / httpx
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("openai").setLevel(logging.WARNING)
logging.getLogger("openai._base_client").setLevel(logging.WARNING)

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

# Shared Redis connection for publishing progress events
_redis_pub = None


async def get_redis_pub():
    global _redis_pub
    if _redis_pub is None:
        _redis_pub = aioredis.from_url(REDIS_URL)
    return _redis_pub


async def publish_progress(
    job_id: str,
    status: str,
    progress: int,
    message: str = "",
    detail: dict | None = None,
):
    """Publish job progress to Redis channel for SSE consumers.

    `detail` is set for events from inside a step (agent steps, tool calls) and
    carries at least `kind`; step-boundary events omit it.
    """
    r = await get_redis_pub()
    channel = f"job:{job_id}:progress"
    event = {
        "status": status,
        "progress": progress,
        "message": message,
    }
    if detail:
        event["detail"] = detail
    await r.publish(channel, json.dumps(event))


async def publish_result(job_id: str, result: dict):
    """Publish final job results to Redis for DB writer consumption."""
    r = await get_redis_pub()
    channel = f"job:{job_id}:result"
    await r.publish(channel, json.dumps(result))


async def process_job(job, token):
    """Process a job from the queue.

    Relies on BullMQ's built-in lock and stalled-job detection for crash
    recovery. The event loop must stay free during long-running steps
    so BullMQ can extend its lock automatically.
    """
    job_id = job.data.get("jobId")
    job_type = job.data.get("type", "default")
    user_id = job.data.get("userId")
    input_data = job.data.get("input", {})

    logger.info("Starting job %s (type=%s, attempt %d)", job_id, job_type, job.attemptsMade + 1)
    failure_notified = False

    async def is_cancelled() -> bool:
        r = await get_redis_pub()
        return await r.exists(f"job:{job_id}:cancel") > 0

    async def progress_callback(
        pct: int,
        step_name: str = "",
        status: str = "running",
        message: str = "",
        detail: dict | None = None,
    ):
        nonlocal failure_notified
        await job.updateProgress(pct)
        resolved_message = message or (f"Running {step_name}" if step_name else "")
        await publish_progress(job_id, status, pct, resolved_message, detail)
        if status == "failed":
            failure_notified = True

    try:
        result = await run_job(
            job_id=job_id,
            job_type=job_type,
            user_id=user_id,
            input_data=input_data,
            progress_callback=progress_callback,
            cancel_check=is_cancelled,
        )
        await publish_result(job_id, result)
        await publish_progress(job_id, "completed", 100, "Job completed")
        logger.info("Job %s completed successfully", job_id)
    except JobCancelled:
        await publish_progress(job_id, "cancelled", 0, "Job cancelled")
        logger.info("Job %s cancelled by user", job_id)
    except Exception:
        if not failure_notified:
            await publish_progress(job_id, "failed", 0, "Job failed")
        logger.exception("Job %s failed", job_id)
        raise


async def main():
    # Owns every LangSmith variable and logs what it decided. Off by default,
    # and never raises: a broken tracing setup must not stop the worker.
    configure_tracing()

    logger.info("Worker starting, connecting to %s", REDIS_URL)

    worker = Worker(
        "jobs",
        process_job,
        {
            "connection": REDIS_URL,
            "concurrency": 5,
            "lockDuration": 5 * 60 * 1000,       # 5 min initial lock (auto-extended)
            "stalledInterval": 30 * 1000,         # check for stalls every 30s
            "maxStalledCount": 2,                 # retry up to 2 times on stall
        },
    )

    logger.info("Worker listening for jobs...")

    # Keep the worker running
    while True:
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
