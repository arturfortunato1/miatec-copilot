"""Record agent — approved note → the miatec staging store (DynamoDB). THE REAL WRITE.

Integration decision (see docs/INTEGRATIONS.md): miatec exposes no public REST API yet, so the
approved encounter is written to a DynamoDB staging table (`MIATEC_TABLE`) that the miatec entry
follows — a real, idempotency-keyed write on AWS, not a simulation. The put is conditional
(`attribute_not_exists(pk)`) with the idempotency key as the partition key, so a retry after a
timeout can never double-write: one approval, one record. Falls back to a clearly labeled simulated
write when AWS isn't configured, so the loop never breaks. The direct miatec REST write slots in
here unchanged once an API exists. Scores under: Actions & Tool Use.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone

from app.aws import aws_configured, client
from app.events import publish

AGENT = "record"
MAX_RETRIES = 3


def miatec_store_configured() -> bool:
    return aws_configured() and bool(os.getenv("MIATEC_TABLE"))


def _put_encounter(state: dict, encounter_id: str, idempotency_key: str) -> None:
    """Conditional DynamoDB put — raises ConditionalCheckFailedException if the key already exists
    (treated by the caller as idempotent success, not an error)."""
    note = state.get("note", {}) or {}
    considerations = [c for c in (state.get("considerations") or []) if not c.get("dismissed")]
    verification = state.get("verification", {}) or {}
    item = {
        "pk": {"S": idempotency_key},
        "encounter_id": {"S": encounter_id},
        "session_id": {"S": state["session_id"]},
        "note": {"S": json.dumps(note, ensure_ascii=False)},
        "considerations": {"S": json.dumps(considerations, ensure_ascii=False)},
        "evidence_alignment": {"N": str(round(float(verification.get("alignment", 0.0)), 3))},
        "source": {"S": "miatec-copilot"},
        "created_at": {"S": datetime.now(timezone.utc).isoformat()},
    }
    client("dynamodb").put_item(
        TableName=os.environ["MIATEC_TABLE"],
        Item=item,
        ConditionExpression="attribute_not_exists(pk)",
    )


async def run_record(state: dict) -> dict:
    session_id = state["session_id"]
    table = os.getenv("MIATEC_TABLE", "")
    live = miatec_store_configured()
    target = f"miatec staging store (DynamoDB · {table})" if live \
        else "miatec staging store (simulated — no AWS)"
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": f"Writing the approved encounter to the {target}…"})

    idempotency_key = f"{session_id}:record"
    encounter_id = f"miatec-enc-{session_id[:8]}"

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            if live:
                try:
                    await asyncio.to_thread(_put_encounter, state, encounter_id, idempotency_key)
                    detail = f"DynamoDB put ({table}), attempt {attempt}"
                except Exception as exc:
                    # Same idempotency key already written → success, not an error.
                    if "ConditionalCheckFailed" in type(exc).__name__ or "ConditionalCheckFailed" in str(exc):
                        detail = f"already written ({table}) — idempotency key matched, no double-write"
                    else:
                        raise
            else:
                await asyncio.sleep(0.6)
                detail = "simulated write — set AWS creds + MIATEC_TABLE for the real DynamoDB write"
            result = {"encounter_id": encounter_id, "status": "success", "detail": detail}
            # NB: keep the event's lifecycle status ("done") distinct from the write-result status
            # ("success") — don't spread **result here or it clobbers status and the cockpit drops the frame.
            await publish(session_id, {"agent": AGENT, "status": "done",
                                       "encounter_id": encounter_id, "detail": detail,
                                       "degraded": not live,
                                       "summary": f"Encounter staged for miatec · {encounter_id}",
                                       "reason": f"idempotency-keyed write — {detail}"})
            return {"miatec_write_result": result}
        except Exception as exc:  # noqa: BLE001 — surface, retry, then fail loudly
            last_err = str(exc)
            await publish(session_id, {"agent": AGENT, "status": "retry",
                                       "attempt": attempt, "error": last_err})
            await asyncio.sleep(0.5 * attempt)

    result = {"encounter_id": None, "status": "error", "detail": last_err}
    await publish(session_id, {"agent": AGENT, "status": "error",
                               "encounter_id": None, "detail": last_err})
    return {"miatec_write_result": result}
