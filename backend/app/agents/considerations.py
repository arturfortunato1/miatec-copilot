"""Considerations agent — note + evidence → ranked differentials with rationale.

Decision SUPPORT, never autonomous diagnosis. Real: Claude via Amazon Bedrock reasons over
(note + evidence) and returns a ranked JSON array with rationale, confidence, and evidence_refs
(indices into state['evidence']). Each item is validated against the Consideration schema. Scores
under: Autonomy & Decision-Making. Falls back to a canned ranking when Bedrock isn't configured.
"""
from __future__ import annotations

import asyncio
import json

from app.events import publish
from app.llm import claude_configured, claude_json
from app.schema import Consideration

AGENT = "considerations"

_SYSTEM = (
    "You are a clinical decision SUPPORT assistant (never an autonomous diagnosis). Given a SOAP note "
    "and a list of evidence items, output a ranked JSON array of differential considerations. Each "
    'element: {"label": string, "rationale": string, "confidence": number between 0 and 1, '
    '"evidence_refs": array of integer indices into the evidence array}. Rank most-to-least likely '
    "and keep confidences calibrated and modest. Output ONLY the JSON array: no prose, no code fences."
)


async def run_considerations(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})

    note = state.get("note", {})
    evidence = state.get("evidence", [])

    considerations = None
    if claude_configured() and note:
        try:
            considerations = await asyncio.to_thread(_rank_with_claude, note, evidence)
        except Exception as exc:  # noqa: BLE001 — surface, then fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc)})

    if not considerations:
        await asyncio.sleep(0.7)  # simulate latency for the stub path
        refs = list(range(len(evidence)))
        considerations = [
            {"label": "Síndrome coronariana aguda (descartar)",
             "rationale": "Dor torácica com irradiação para braço esquerdo, dispneia e hipertensão em uso de losartana.",
             "confidence": 0.62, "evidence_refs": refs, "dismissed": False},
            {"label": "Angina estável",
             "rationale": "Dor possivelmente relacionada a esforço, sem critérios de instabilidade documentados.",
             "confidence": 0.21, "evidence_refs": refs[:1], "dismissed": False},
            {"label": "Causa musculoesquelética",
             "rationale": "Considerar se a investigação cardíaca for negativa.",
             "confidence": 0.12, "evidence_refs": [], "dismissed": False},
        ]

    await publish(session_id, {"agent": AGENT, "status": "done", "considerations": considerations})
    return {"considerations": considerations}


def _rank_with_claude(note: dict, evidence: list) -> list:
    payload = json.dumps({"note": note, "evidence": evidence}, ensure_ascii=False)
    data = claude_json(_SYSTEM, payload, max_tokens=1200)
    if not isinstance(data, list):
        raise ValueError("expected a JSON array of considerations")
    return [Consideration(**item).model_dump() for item in data]  # validate each; raises → fallback
