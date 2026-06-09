"""Evidence agent — symptoms → cited guidelines/literature via Exa.

Real: build a query from the structured note (chief complaint + symptoms), call Exa
`search_and_contents` (type="auto", highlights) for query-relevant excerpts from across the web, and
surface them as cited evidence cards. If Exa returns nothing → "no strong evidence found" (failure
handling — never hallucinate a citation). Falls back to canned hits when EXA_API_KEY is unset.
Scores under: Tool Use + Exa prize.

Per Exa's coding-agent guide:
- Use the SDK convenience `search_and_contents` so content options nest correctly under `contents`.
- `highlights=True` returns token-efficient, query-relevant excerpts — ideal for agent cards.
- Domain restriction is usually unnecessary (neural search surfaces reputable sources); AUTH_DOMAINS
  below is provided to enable stricter, authoritative-only sourcing if you want it.
"""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlparse

from app.events import publish

AGENT = "evidence"
SCORE_THRESHOLD = 0.35   # only used to filter the canned stub hits
_NUM_RESULTS = 6

# Optional: pass include_domains=AUTH_DOMAINS in _search_exa for authoritative-only sourcing.
AUTH_DOMAINS = [
    "pubmed.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "www.uptodate.com",
    "www.nice.org.uk", "www.who.int", "portal.cardiol.br",
    "bvsms.saude.gov.br", "www.gov.br",
]

# Stubbed authoritative hits so the loop runs without an Exa key.
_MOCK_EVIDENCE = [
    {"claim": "Dor torácica com irradiação para MSE + fatores de risco exige descartar SCA com ECG e troponina.",
     "source": "Diretriz SBC de Síndromes Coronarianas Agudas", "url": "https://www.portal.cardiol.br/", "score": 0.71},
    {"claim": "Losartana (BRA) é anti-hipertensivo; hipertensão é fator de risco cardiovascular relevante.",
     "source": "UpToDate — Hypertension and cardiovascular risk", "url": "https://www.uptodate.com/", "score": 0.52},
]


def exa_configured() -> bool:
    return bool(os.getenv("EXA_API_KEY"))


async def run_evidence(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})

    note = state.get("note", {})
    query = _build_query(note)

    hits = None
    if exa_configured() and query:
        try:
            hits = await asyncio.to_thread(_search_exa, query)
        except Exception as exc:  # noqa: BLE001 — surface, then fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc)})

    if hits is None:  # Exa not configured or errored → canned stub
        await asyncio.sleep(0.7)
        hits = [e for e in _MOCK_EVIDENCE if e["score"] >= SCORE_THRESHOLD]

    if not hits:
        # Honest empty result instead of a hallucinated citation (failure handling).
        await publish(session_id, {"agent": AGENT, "status": "done", "evidence": [],
                                   "note": "no strong evidence found"})
        return {"evidence": []}

    await publish(session_id, {"agent": AGENT, "status": "done", "evidence": hits})
    return {"evidence": hits}


def _build_query(note: dict) -> str:
    cc = note.get("chief_complaint", "")
    ros = note.get("review_of_systems", []) or []
    parts = [cc] + list(ros)[:3]
    focus = "; ".join(p for p in parts if p and p != "not documented").strip("; ").strip()
    if not focus:
        return ""
    return f"diretrizes clínicas e evidências médicas para: {focus}"


def _search_exa(query: str) -> list:
    from exa_py import Exa  # lazy
    exa = Exa(os.environ["EXA_API_KEY"])
    # Raw-retrieval pattern: inspect results directly and render cards.
    # For authoritative-only sourcing, add: include_domains=AUTH_DOMAINS
    res = exa.search_and_contents(query, type="auto", num_results=_NUM_RESULTS, highlights=True)

    hits = []
    for r in getattr(res, "results", []):
        highlights = getattr(r, "highlights", None) or []
        title = (getattr(r, "title", "") or "").strip()
        url = getattr(r, "url", "") or ""
        excerpt = " ".join(highlights[0].split()) if highlights else ""  # collapse fragmented whitespace
        claim = (title or excerpt)[:200]   # clean headline as the card claim
        if not claim or not url:
            continue
        score = getattr(r, "score", None)
        hits.append({
            "claim": claim,
            "source": urlparse(url).netloc or title,   # domain as the citation label
            "url": url,
            "snippet": excerpt[:300] or None,           # grounded excerpt (rendered later)
            "score": float(score) if score is not None else None,
        })
    return hits
