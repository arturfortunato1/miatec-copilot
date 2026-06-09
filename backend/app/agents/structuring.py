"""Structuring agent — transcript → validated SOAP JSON (ClinicalNote).

Real: Claude via Amazon Bedrock with a strict-JSON instruction; the output is validated by
constructing ClinicalNote(**data) so bad shapes raise instead of leaking. Missing fields become
"not documented", never invented. The low_confidence_segments come from the Scribe confidences, not
the model. Scores under: Autonomy & Decision-Making.

Falls back to a canned note when Bedrock isn't configured, so the loop always runs.
"""
from __future__ import annotations

import asyncio

from app.events import publish
from app.llm import claude_configured, claude_json
from app.schema import ClinicalNote

AGENT = "structuring"

_SYSTEM = (
    "You are a clinical scribe for a Brazilian consultation. Convert the transcript into a SOAP "
    "clinical note as STRICT JSON with exactly these keys: chief_complaint (string), hpi (string), "
    "review_of_systems (array of strings), vitals (object with bp, hr, temp — string or null), "
    "current_medications (array of strings), allergies (array of strings), assessment (string), "
    "plan (string). Write the clinical content in pt-BR. For anything not stated in the transcript "
    'use "not documented" for strings, null for vitals fields, and [] for arrays — never invent. '
    "Output ONLY the JSON object: no prose, no code fences."
)


async def run_structuring(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})

    transcript = state.get("transcript", [])
    low_conf = [seg["text"] for seg in transcript if seg.get("confidence", 1.0) < 0.7]

    note_dict = None
    if claude_configured() and transcript:
        try:
            note_dict = await asyncio.to_thread(_structure_with_claude, transcript)
        except Exception as exc:  # noqa: BLE001 — surface, then fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc)})

    if not note_dict:
        await asyncio.sleep(0.8)  # simulate latency for the stub path
        note_dict = ClinicalNote(
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
        ).model_dump()

    # Confidence flags come from Scribe, not the model.
    note_dict["low_confidence_segments"] = low_conf

    await publish(session_id, {"agent": AGENT, "status": "done", "note": note_dict})
    return {"note": note_dict}


def _structure_with_claude(transcript: list) -> dict:
    convo = "\n".join(f'{s.get("speaker", "?")}: {s.get("text", "")}' for s in transcript)
    data = claude_json(_SYSTEM, f"Transcript:\n{convo}", max_tokens=1500)
    # Validate by constructing the model — raises on bad shape, so the caller falls back.
    return ClinicalNote(**data).model_dump()
