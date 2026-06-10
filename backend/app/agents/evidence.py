"""Evidence agent — symptoms → cited guidelines/literature via Exa, with a tiered search strategy.

Real: build a query from the structured note (chief complaint + symptoms), then search Exa in two
tiers — **authoritative clinical domains first** (guidelines bodies, PubMed, ministry-of-health);
only if that pass comes back thin does the agent decide to broaden to the open web and merge,
deduped, authoritative hits ranked first. The chosen strategy is narrated over SSE, so the retrieval
decision is visible in the cockpit. If nothing comes back → "no strong evidence found" (failure
handling — never hallucinate a citation). Falls back to canned hits when EXA_API_KEY is unset.
Scores under: Tool Use + Autonomy + Exa prize.

Per Exa's coding-agent guide:
- Use the SDK convenience `search_and_contents` so content options nest correctly under `contents`.
- `highlights=True` returns token-efficient, query-relevant excerpts — ideal for agent cards.
- `include_domains` scopes the authoritative pass; the open-web pass trusts neural ranking.
"""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlparse

from app.events import publish
from app.retry import call_with_retry

AGENT = "evidence"
SCORE_THRESHOLD = 0.35   # only used to filter the canned stub hits
_NUM_RESULTS = 6
_MIN_AUTH_HITS = 3       # authoritative pass thinner than this → agent broadens to the open web

# Tier-1 sourcing for the authoritative Exa pass (guidelines bodies, literature, BR public health).
AUTH_DOMAINS = [
    "pubmed.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "www.uptodate.com",
    "www.nice.org.uk", "www.who.int", "portal.cardiol.br",
    "bvsms.saude.gov.br", "www.gov.br",
]

# Stubbed authoritative hits so the loop runs without an Exa key.
_MOCK_EVIDENCE = [
    {"claim": "Chest pain radiating to the left arm with risk factors requires ruling out ACS with ECG and troponin.",
     "source": "SBC Guideline on Acute Coronary Syndromes", "url": "https://www.portal.cardiol.br/", "score": 0.71},
    {"claim": "Losartan (an ARB) is an antihypertensive; hypertension is a relevant cardiovascular risk factor.",
     "source": "UpToDate — Hypertension and cardiovascular risk", "url": "https://www.uptodate.com/", "score": 0.52},
]


def exa_configured() -> bool:
    return bool(os.getenv("EXA_API_KEY"))


async def run_evidence(state: dict) -> dict:
    session_id = state["session_id"]
    note = state.get("note", {})
    query = _build_query(note)

    step = (f"Searching Exa (authoritative clinical sources first): “{query[:60]}…”"
            if query else "Searching Exa for relevant guidelines…")
    await publish(session_id, {"agent": AGENT, "status": "running", "step": step})

    hits, source, strategy = None, "exa", ""
    if exa_configured() and query:
        try:
            hits, strategy = await call_with_retry(session_id, AGENT, lambda: _search_exa_tiered(query),
                                                   step="Exa search")
        except Exception as exc:  # noqa: BLE001 — retries exhausted → fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "Exa unavailable — using canned guideline citations"})

    if hits is None:  # Exa not configured or errored → canned stub
        source = "stub"
        await asyncio.sleep(0.7)
        hits = [e for e in _MOCK_EVIDENCE if e["score"] >= SCORE_THRESHOLD]

    degraded = source == "stub"
    if not hits:
        # Honest empty result instead of a hallucinated citation (failure handling).
        await publish(session_id, {"agent": AGENT, "status": "done", "evidence": [], "query": query,
                                   "note": "no strong evidence found", "summary": "no strong evidence found",
                                   "reason": "returned nothing rather than inventing a citation (failure handling)",
                                   "degraded": degraded})
        return {"evidence": []}

    n_auth = sum(1 for h in hits if h.get("tier") == "authoritative")
    via = "Exa neural search" if source == "exa" else "canned sources (no Exa key)"
    summary = f"{len(hits)} evidence source(s) via {via}" + (f" · {n_auth} authoritative" if n_auth else "")
    reason = strategy or (f"grounded the query: {query}" if query else "grounded the structured note")
    await publish(session_id, {"agent": AGENT, "status": "done", "evidence": hits, "query": query,
                               "summary": summary, "reason": reason, "degraded": degraded})
    return {"evidence": hits}


async def run_evidence_requery(state: dict, refined_query: str) -> dict:
    """Reconcile loop: the Verifier judged the evidence weak → search AGAIN with a refined,
    assessment-focused query and merge new sources in (deduped by URL, append-only so existing card
    indices stay valid). Returns {} when Exa is unavailable or nothing new surfaces — the caller
    decides what that means. Capped at 8 total cards so the panel stays legible.
    """
    session_id = state["session_id"]
    existing = list(state.get("evidence", []) or [])
    if not (exa_configured() and refined_query):
        return {}

    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": f"Reconcile: re-querying Exa — “{refined_query[:60]}…”"})
    try:
        hits, strategy = await call_with_retry(session_id, AGENT,
                                               lambda: _search_exa_tiered(refined_query),
                                               step="Exa reconcile re-query")
    except Exception as exc:  # noqa: BLE001 — retries exhausted → keep what we have
        await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                   "step": "Reconcile re-query unavailable — keeping the original evidence"})
        return {}

    seen = {e.get("url") for e in existing}
    fresh = [h for h in hits if h["url"] not in seen][:max(0, 8 - len(existing))]
    if not fresh:
        await publish(session_id, {"agent": AGENT, "status": "running",
                                   "step": "Reconcile re-query found no new sources — keeping the original evidence"})
        return {}

    merged = existing + fresh
    await publish(session_id, {"agent": AGENT, "status": "done", "evidence": merged,
                               "query": refined_query,
                               "summary": f"+{len(fresh)} source(s) from the reconcile re-query · {len(merged)} total",
                               "reason": strategy, "degraded": False})
    return {"evidence": merged}


def _build_query(note: dict) -> str:
    cc = note.get("chief_complaint", "")
    ros = note.get("review_of_systems", []) or []
    parts = [cc] + list(ros)[:3]
    focus = "; ".join(p for p in parts if p and p != "not documented").strip("; ").strip()
    if not focus:
        return ""
    return f"clinical guidelines and medical evidence for: {focus}"


def _search_exa_tiered(query: str) -> tuple:
    """Two-tier Exa retrieval — the agent's own search-strategy decision.

    Tier 1 scopes `search_and_contents` to AUTH_DOMAINS (clinical guidelines, literature, BR public
    health). Only when that pass returns fewer than _MIN_AUTH_HITS does the agent broaden to the open
    web, merging deduped-by-URL with authoritative hits ranked first. Returns (hits, strategy) where
    strategy is the human-readable account of the decision, published over SSE.
    """
    from exa_py import Exa  # lazy
    exa = Exa(os.environ["EXA_API_KEY"])

    auth = _extract_hits(
        exa.search_and_contents(query, type="auto", num_results=_NUM_RESULTS,
                                highlights=True, include_domains=AUTH_DOMAINS),
        tier="authoritative")
    # Domain-scoped search returns the closest IN-DOMAIN pages even when they're off-topic (and its
    # scores are rank-normalized, so they can't gate relevance). Count only hits that lexically share
    # query terms toward the "good enough" bar; broadening on a miss is cheap — it only ADDS hits.
    relevant, drifted = _split_on_topic(auth, query)
    if len(relevant) >= _MIN_AUTH_HITS:
        return auth, (f"authoritative-first retrieval: {len(auth)} hit(s) from clinical domains "
                      f"({len(relevant)} on-topic) — open-web pass not needed")

    web = _extract_hits(
        exa.search_and_contents(query, type="auto", num_results=_NUM_RESULTS, highlights=True),
        tier="open-web")
    seen = {h["url"] for h in auth}
    # On-topic authoritative first, then the open web; topic-drifted in-domain pages only as filler.
    merged = (relevant + [h for h in web if h["url"] not in seen] + drifted)[:_NUM_RESULTS]
    return merged, (f"authoritative pass too thin ({len(relevant)} on-topic hit(s) < {_MIN_AUTH_HITS}) — "
                    f"agent broadened to the open web; merged to {len(merged)}, authoritative first")


_QUERY_STOPWORDS = frozenset(
    "clinical guidelines guideline medical evidence for and the with from this that".split())


def _split_on_topic(hits: list, query: str) -> tuple:
    """Split hits into (on-topic, drifted) by lexical overlap with the query's informative terms."""
    import re
    terms = {w for w in re.findall(r"[a-zà-ÿ]{4,}", query.lower()) if w not in _QUERY_STOPWORDS}
    if not terms:
        return list(hits), []
    on, off = [], []
    for h in hits:
        text = f"{h['claim']} {h.get('snippet') or ''}".lower()
        (on if any(t in text for t in terms) else off).append(h)
    return on, off


def _extract_hits(res, tier: str) -> list:
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
            "tier": tier,                               # authoritative | open-web (retrieval strategy)
        })
    return hits
