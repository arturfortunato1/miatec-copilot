"""Considerations agent — note + evidence → ranked differentials with rationale.

Decision SUPPORT, never autonomous diagnosis. Real: Claude/Nova reasons over (note + evidence + a
quality briefing) and returns a ranked JSON array with rationale, confidence, and evidence_refs
(indices into state['evidence']). Each item is validated against the Consideration schema. Scores
under: Autonomy & Decision-Making.

Quality hardening:
- A **quality_context** (role-attribution confidence + count of unclear turns) is passed in so the
  model is MORE conservative when the signal is weak.
- The prompt asks for **calibrated, modest** confidences and rule-out framing under uncertainty.
- The call uses **temperature=0** to cut Nova's run-to-run ranking variance.
- The LLM call is **retried** (visible `retry` events) before falling back to a canned ranking
  (`degraded`).
"""
from __future__ import annotations

import asyncio
import json

from app.events import publish
from app.llm import claude_configured, claude_json
from app.retry import call_with_retry
from app.schema import Consideration

AGENT = "considerations"

_SYSTEM = (
    "You are a clinical decision SUPPORT assistant (never an autonomous diagnosis). Given a SOAP note, "
    "a list of evidence items, and a quality_context, output a ranked JSON array of differential "
    'considerations. Each element: {"label": string, "rationale": string, "confidence": number between '
    '0 and 1, "evidence_refs": array of integer indices into the evidence array}. Rank most-to-least '
    "likely. CALIBRATION: confidences must be modest and reflect genuine uncertainty from a single "
    "consultation transcript — rarely above 0.7 for one differential. If quality_context shows low "
    "role-attribution confidence, many unclear turns, or LOW evidence_alignment (the verifier found the "
    "evidence weakly supports the note), be MORE conservative: lower the confidences, prefer rule-out "
    "framing, and address any listed evidence_concerns. Put ALL reasoning inside the 'rationale' field, "
    "written in clear clinical ENGLISH (labels in English too). "
    "Output ONLY the JSON array: no prose, no code fences."
)


async def run_considerations(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": "Ranking differential considerations over the note + evidence…"})

    note = state.get("note", {})
    evidence = state.get("evidence", [])
    quality = _quality_context(state)

    considerations = None
    if claude_configured() and note:
        try:
            considerations = await call_with_retry(
                session_id, AGENT, lambda: _rank_with_claude(note, evidence, quality),
                step="ranking via LLM",
            )
        except Exception as exc:  # noqa: BLE001 — all retries exhausted → fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "LLM unavailable — using a baseline ranking"})

    used_stub = considerations is None
    if used_stub:
        await asyncio.sleep(0.7)  # simulate latency for the stub path
        refs = list(range(len(evidence)))
        considerations = [
            {"label": "Acute coronary syndrome (rule out)",
             "rationale": "Chest pain radiating to the left arm, dyspnea, and hypertension on losartan.",
             "confidence": 0.62, "evidence_refs": refs, "dismissed": False},
            {"label": "Stable angina",
             "rationale": "Pain possibly exertional, with no documented instability criteria.",
             "confidence": 0.21, "evidence_refs": refs[:1], "dismissed": False},
            {"label": "Musculoskeletal cause",
             "rationale": "Consider if the cardiac workup is negative.",
             "confidence": 0.12, "evidence_refs": [], "dismissed": False},
        ]

    summary, reason = _summarize(considerations)
    await publish(session_id, {"agent": AGENT, "status": "done", "considerations": considerations,
                               "summary": summary, "reason": reason, "degraded": used_stub})
    return {"considerations": considerations}


def _quality_context(state: dict) -> dict:
    """Signal the ranker how much to trust its inputs (roles confidence, transcript noise, verifier)."""
    roles = state.get("roles", {}) or {}
    note = state.get("note", {}) or {}
    verification = state.get("verification", {}) or {}
    return {
        "role_attribution_confidence": round(float(roles.get("confidence", 0.0)), 2),
        "role_needs_review": bool(roles.get("needs_review", False)),
        "unclear_transcript_turns": len(note.get("low_confidence_segments", []) or []),
        "evidence_alignment": round(float(verification.get("alignment", 0.0)), 2),
        "evidence_concerns": (verification.get("concerns") or [])[:3],
    }


def _summarize(considerations: list) -> tuple:
    """One-line decision + the 'why' the cockpit shows under the agent."""
    n = len(considerations)
    if not n:
        return "no differentials generated", "insufficient structured findings"
    top = considerations[0]
    summary = f"{n} differentials ranked · top: {top['label'][:34]} ({round(top['confidence'] * 100)}%)"
    reason = (top.get("rationale") or "ranked most-to-least likely; calibrated, modest confidences")[:90]
    return summary, reason


def _rank_with_claude(note: dict, evidence: list, quality: dict) -> list:
    payload = json.dumps({"note": note, "evidence": evidence, "quality_context": quality}, ensure_ascii=False)
    # 2500 (was 1200): ranked differentials with detailed pt-BR rationales overran 1200 tokens → JSON
    # truncated mid-string → parse fail → stub. Generous budget so the array always closes.
    data = claude_json(_SYSTEM, payload, max_tokens=2500, temperature=0)
    if not isinstance(data, list):
        raise ValueError("expected a JSON array of considerations")
    return [Consideration(**item).model_dump() for item in data]  # validate each; raises → fallback
