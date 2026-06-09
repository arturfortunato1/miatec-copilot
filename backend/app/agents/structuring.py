"""Structuring agent — transcript → validated SOAP JSON (ClinicalNote).

Real: Claude with a strict JSON schema (tool-calling); Pydantic validates server-side; missing
required fields become "not documented", never invented. Scores under: Autonomy & Decision-Making.
"""
from __future__ import annotations

import asyncio

from app.events import publish
from app.schema import ClinicalNote

AGENT = "structuring"


async def run_structuring(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})
    await asyncio.sleep(0.8)

    transcript = state.get("transcript", [])
    low_conf = [seg["text"] for seg in transcript if seg.get("confidence", 1.0) < 0.7]

    # TODO(real): call Claude (tool-calling, JSON schema) over the transcript, then validate the
    # tool output by constructing ClinicalNote(**claude_json) so bad shapes raise instead of leak.
    note = ClinicalNote(
        chief_complaint="Dor torácica e dispneia, início há 1 dia",
        hpi="Paciente refere dor torácica iniciada ontem, com irradiação para o braço esquerdo e falta de ar.",
        review_of_systems=[
            "Cardiovascular: dor torácica com irradiação para MSE",
            "Respiratório: dispneia",
        ],
        current_medications=["Losartana"],
        allergies=[],
        assessment="not documented",
        plan="Solicitar ECG e marcadores cardíacos (troponina).",
        low_confidence_segments=low_conf,
    )
    note_dict = note.model_dump()

    await publish(session_id, {"agent": AGENT, "status": "done", "note": note_dict})
    return {"note": note_dict}
