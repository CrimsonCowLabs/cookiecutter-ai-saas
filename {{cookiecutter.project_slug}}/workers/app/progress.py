"""Job progress reporting: a monotonic emitter and per-step sub-ranges.

`run_job` owns one `JobProgress` per job. It forwards every event to the
caller's `progress_callback` (which publishes to the live-progress channel) and
guarantees the percentage never decreases. A `StepProgress` lets one pipeline
step spread finer-grained events across its own slice of the bar and is also
where cancellation is noticed while a step is busy.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any


class JobCancelled(Exception):
    pass


ProgressCallback = Callable[..., Awaitable[None]]
CancelCheck = Callable[[], Awaitable[bool]]


class JobProgress:
    """Forwards progress events to the callback with a non-decreasing percentage."""

    def __init__(self, callback: ProgressCallback | None, cancel_check: CancelCheck | None = None) -> None:
        self._callback = callback
        self._cancel_check = cancel_check
        self._last = 0

    async def check_cancelled(self) -> None:
        if self._cancel_check and await self._cancel_check():
            raise JobCancelled()

    async def emit(
        self,
        pct: int,
        step_name: str,
        status: str,
        message: str,
        detail: dict[str, Any] | None = None,
    ) -> None:
        # A failure reports 0 by contract (the job is over); everything else
        # can only move forward.
        if status != "failed":
            pct = max(pct, self._last)
            self._last = pct
        if self._callback is None:
            return
        if detail is None:
            await self._callback(pct, step_name, status, message)
        else:
            await self._callback(pct, step_name, status, message, detail=detail)

    def step(self, step_name: str, start_pct: int, end_pct: int) -> StepProgress:
        return StepProgress(self, step_name, start_pct, end_pct)


class StepProgress:
    """Progress inside one step, mapped onto `[start_pct, end_pct)`.

    The step's own "completed" event (at `end_pct`) is emitted by `run_job`, so
    updates here stop one point short of it and the bar cannot look finished
    before the step is.
    """

    def __init__(self, job: JobProgress, step_name: str, start_pct: int, end_pct: int) -> None:
        self._job = job
        self._step_name = step_name
        self._start = start_pct
        self._end = end_pct

    async def update(self, fraction: float, message: str, detail: dict[str, Any] | None = None) -> None:
        """Report `fraction` (0..1) of the step done. Raises `JobCancelled` if the job was cancelled."""
        await self._job.check_cancelled()
        fraction = min(1.0, max(0.0, fraction))
        pct = self._start + int((self._end - self._start) * fraction)
        pct = min(pct, max(self._start, self._end - 1))
        await self._job.emit(pct, self._step_name, "running", message, detail)
