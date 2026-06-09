"""Considerations agent — note + evidence → ranked differentials with rationale.

Decision SUPPORT, never autonomous diagnosis. Real: Claude reasons over (note + evidence) and emits
a ranked list with rationale, confidence, and evidence_refs (indices into state['evidence']) so the
UI can link each consideration back to its sources. Scores under: Autonomy & Decision-Making.
"""
from __future__ import annotations

import asyncio

from app.events import publish

AGENT = "considerations"


async def run_considerations(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})
    await asyncio.sleep(0.7)

    evidence = state.get("evidence", [])
    refs = list(range(len(evidence)))

    # TODO(real): Claude ranks differentials from note + evidence; keep evidence_refs pointing back
    # at the Evidence items. Cap confidence; this is support, not a verdict.
    considerations = [
        {
            "label": "Síndrome coronariana aguda (descartar)",
            "rationale": "Dor torácica com irradiação para braço esquerdo, dispneia e hipertensão em uso de losartana.",
            "confidence": 0.62,
            "evidence_refs": refs,
            "dismissed": False,
        },
        {
            "label": "Angina estável",
            "rationale": "Dor possivelmente relacionada a esforço, sem critérios de instabilidade documentados.",
            "confidence": 0.21,
            "evidence_refs": refs[:1],
            "dismissed": False,
        },
        {
            "label": "Causa musculoesquelética",
            "rationale": "Considerar se a investigação cardíaca for negativa.",
            "confidence": 0.12,
            "evidence_refs": [],
            "dismissed": False,
        },
    ]

    await publish(session_id, {"agent": AGENT, "status": "done", "considerations": considerations})
    return {"considerations": considerations}
