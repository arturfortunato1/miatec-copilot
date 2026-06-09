"""Evidence agent — symptoms → cited guidelines/literature via Exa.

Real: build a query from note.chief_complaint + symptoms; Exa `search` restricted to authoritative
domains (PubMed, guideline bodies, Brazilian MoH / specialty societies) + recency; `get_contents` on
top hits; Claude summarizes each to one grounded line + citation. If the top score is below
threshold → return "no strong evidence found" (failure handling — never hallucinate).
Scores under: Tool Use + Exa prize.
"""
from __future__ import annotations

import asyncio

from app.events import publish

AGENT = "evidence"
SCORE_THRESHOLD = 0.35

# Stubbed authoritative hits so the loop runs without an Exa key.
_MOCK_EVIDENCE = [
    {
        "claim": "Dor torácica com irradiação para MSE + fatores de risco exige descartar SCA com ECG e troponina.",
        "source": "Diretriz SBC de Síndromes Coronarianas Agudas",
        "url": "https://www.portal.cardiol.br/",
        "score": 0.71,
    },
    {
        "claim": "Losartana (BRA) é anti-hipertensivo; hipertensão é fator de risco cardiovascular relevante.",
        "source": "UpToDate — Hypertension and cardiovascular risk",
        "url": "https://www.uptodate.com/",
        "score": 0.52,
    },
]


async def run_evidence(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})
    await asyncio.sleep(0.7)

    # TODO(real): exa.search_and_contents(query, include_domains=[...], start_published_date=...)
    # then Claude one-line grounding per hit. Filter by score; never invent a citation.
    hits = [e for e in _MOCK_EVIDENCE if e["score"] >= SCORE_THRESHOLD]

    if not hits:
        # Failure-handling path: honest empty result instead of a hallucinated citation.
        await publish(session_id, {"agent": AGENT, "status": "done", "evidence": [],
                                   "note": "no strong evidence found"})
        return {"evidence": []}

    await publish(session_id, {"agent": AGENT, "status": "done", "evidence": hits})
    return {"evidence": hits}
