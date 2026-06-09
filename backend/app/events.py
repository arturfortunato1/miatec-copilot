"""Tiny in-memory pub/sub for Server-Sent Events.

Each agent calls `publish(session_id, {...})` as it runs; the /stream/{session} endpoint subscribes
and forwards events to the cockpit so agents visibly light up live. Swap for Redis pub/sub if you
need multi-process — in-memory is fine for a single-process demo.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict

_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)


def subscribe(session_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[session_id].append(q)
    return q


def unsubscribe(session_id: str, q: asyncio.Queue) -> None:
    subs = _subscribers.get(session_id, [])
    if q in subs:
        subs.remove(q)


async def publish(session_id: str, event: dict) -> None:
    for q in list(_subscribers.get(session_id, [])):
        await q.put(event)
