"""Async retry helper — agents retry transient LLM/Exa failures with VISIBLE 'retry' events.

Each agent already runs its blocking call (LLM, Exa) on a worker thread. Wrapping that call here keeps
the retry loop in async land (no thread→event-loop juggling): the callable is sync and re-run on a
fresh worker thread each attempt, and every retry publishes a `retry` SSE frame the cockpit animates
before the agent finally falls back to its stub. This turns Failure Handling from passive
(one shot → stub) into active + demonstrable.
"""
from __future__ import annotations

import asyncio
from typing import Callable

from app.events import publish


async def call_with_retry(
    session_id: str,
    agent: str,
    fn: Callable,
    *,
    attempts: int = 3,
    base_delay: float = 1.0,
    step: str = "call failed",
):
    """Run sync `fn` on a worker thread, retrying transient failures with backoff.

    Publishes a `retry` event before each re-attempt. Raises the last exception if all attempts fail
    (so the caller can fall back to its stub). `attempts` is the TOTAL number of tries.
    """
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return await asyncio.to_thread(fn)
        except Exception as exc:  # noqa: BLE001 — treat as transient; retry, then let caller fall back
            last_exc = exc
            if attempt < attempts:
                await publish(session_id, {
                    "agent": agent,
                    "status": "retry",
                    "step": f"{step} — retry {attempt}/{attempts - 1}",
                    "error": str(exc),
                })
                await asyncio.sleep(base_delay * attempt)
    raise last_exc
