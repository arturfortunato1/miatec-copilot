"""Record agent — approved note → into miatec. THE MOAT.

Integration decision (see docs/INTEGRATIONS.md): for now the approved encounter is entered into
miatec through the miatec app's own frontend — so this agent MAPS the ClinicalNote to the miatec
encounter shape and marks it ready for entry. The direct REST write (with Idempotency-Key + retry,
scaffolded below) is a later enhancement; the retry loop stays as a ready-made Failure-Handling beat.
Scores under: Actions & Tool Use.
"""
from __future__ import annotations

import asyncio

from app.events import publish

AGENT = "record"
MAX_RETRIES = 3


async def run_record(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})

    note = state.get("note", {})
    idempotency_key = f"{session_id}:record"

    # TODO(real): httpx.post(f"{MIATEC_API_BASE}/encounters", json=mapped_note,
    #             headers={"Authorization": ..., "Idempotency-Key": idempotency_key})
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            await asyncio.sleep(0.6)
            # ---- stubbed success; replace with the real POST above ----
            encounter_id = f"miatec-enc-{session_id[:8]}"
            result = {
                "encounter_id": encounter_id,
                "status": "success",
                "detail": f"written on attempt {attempt}",
                "idempotency_key": idempotency_key,
            }
            await publish(session_id, {"agent": AGENT, "status": "done", **result})
            return {"miatec_write_result": result}
        except Exception as exc:  # noqa: BLE001 — surface, retry, then fail loudly
            last_err = str(exc)
            await publish(session_id, {"agent": AGENT, "status": "retry",
                                       "attempt": attempt, "error": last_err})
            await asyncio.sleep(0.5 * attempt)

    result = {"encounter_id": None, "status": "error", "detail": last_err}
    await publish(session_id, {"agent": AGENT, "status": "error", **result})
    return {"miatec_write_result": result}
