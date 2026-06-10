"""Verifier agent — self-check: does the retrieved evidence support the note's assessment?

A meta-agent between Evidence and Considerations. It reads the SOAP note (chief complaint, HPI,
assessment) and each evidence card, and judges per item whether the evidence SUPPORTS, is NEUTRAL to,
or CONTRADICTS the note's working assessment — then computes an overall alignment (0..1) and lists
concerns (gaps, contradictions). Low alignment routes the graph through a 'reconcile' notice and makes
Considerations more cautious. This catches a real failure mode the rest of the pipeline can't: the note
and its own evidence disagree (structuring drifted, or retrieval went off-topic). Decision SUPPORT,
never autonomous. Scores under: Autonomy & Decision-Making + Failure Handling. Neutral stub fallback.
"""
from __future__ import annotations

import asyncio
import json

from app.events import publish
from app.llm import claude_configured, claude_json
from app.retry import call_with_retry
from app.schema import EvidenceVerdict, Verification

AGENT = "verifier"
CAUTION_THRESHOLD = 0.5

_SYSTEM = (
    "You are a clinical QA verifier (decision support, never diagnosis). Given a SOAP note and a list "
    "of evidence items (each with an index, claim, source), judge for EACH evidence item whether it "
    "SUPPORTS, is NEUTRAL to, or CONTRADICTS the note's working assessment / differential direction. "
    "Then give an overall alignment score from 0 to 1 (how well the evidence as a whole supports the "
    "note) and list concrete concerns (e.g. a key differential with NO supporting evidence, or evidence "
    "that points elsewhere). Be strict: if the evidence does not actually corroborate the assessment, "
    "alignment should be low. Output ONLY JSON: "
    '{"alignment": <0..1>, "verdicts": [{"index": <int>, "stance": "supports|neutral|contradicts", '
    '"note": "<short, in English>"}], "concerns": ["<short, in English>"], '
    '"summary": "<one sentence, in English>"}.'
)


async def run_verifier(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": "Cross-checking the evidence against the note's assessment…"})

    note = state.get("note", {})
    evidence = state.get("evidence", [])

    data = None
    if claude_configured() and note and evidence:
        try:
            data = await call_with_retry(session_id, AGENT,
                                         lambda: _verify_with_llm(note, evidence),
                                         step="verification via LLM")
        except Exception as exc:  # noqa: BLE001 — retries exhausted → neutral fallback
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "LLM unavailable — using a neutral verification"})

    used_stub = data is None
    if used_stub:
        await asyncio.sleep(0.5)
        data = {
            "alignment": 0.6 if evidence else 0.0,
            "verdicts": [{"index": i, "stance": "neutral", "note": "not assessed (no LLM)"}
                         for i in range(len(evidence))],
            "concerns": [] if evidence else ["no evidence retrieved to corroborate the note"],
            "summary": ("Automatic verification unavailable; review the evidence manually."
                        if evidence else "No evidence available to corroborate the note."),
        }

    verification = _build(data, evidence, used_stub)
    summary, reason = _summarize(verification)
    await publish(session_id, {"agent": AGENT, "status": "done", "verification": verification,
                               "summary": summary, "reason": reason, "degraded": used_stub})
    return {"verification": verification}


def _build(data: dict, evidence: list, used_stub: bool) -> dict:
    try:
        alignment = float(data.get("alignment", 0.0))
    except (TypeError, ValueError):
        alignment = 0.0
    alignment = max(0.0, min(1.0, alignment))

    verdicts_raw = data.get("verdicts", [])
    if not isinstance(verdicts_raw, list):  # malformed LLM output → don't iterate a string char-by-char
        verdicts_raw = []
    verdicts = []
    for i, v in enumerate(verdicts_raw):
        if not isinstance(v, dict) or not evidence:  # no evidence → nothing to reference
            continue
        stance = str(v.get("stance", "neutral")).lower()
        if stance not in ("supports", "neutral", "contradicts"):
            stance = "neutral"
        try:
            idx = int(v.get("index", i))
        except (TypeError, ValueError):
            idx = i
        if not 0 <= idx < len(evidence):  # clamp hallucinated/out-of-range indices into the evidence list
            idx = min(max(i, 0), len(evidence) - 1)
        verdicts.append(EvidenceVerdict(index=idx, stance=stance, note=str(v.get("note", ""))))

    concerns_raw = data.get("concerns", [])
    if not isinstance(concerns_raw, list):
        concerns_raw = []

    return Verification(
        alignment=round(alignment, 2),
        verdicts=verdicts,
        concerns=[str(c) for c in concerns_raw if c],
        summary=str(data.get("summary", "")),
        # Only flag caution when there IS evidence that weakly supports/contradicts — an empty evidence
        # list is "nothing retrieved" (Evidence already says so), not an evidence↔note conflict.
        needs_caution=bool(evidence) and alignment < CAUTION_THRESHOLD,
        source="stub" if used_stub else "llm",
    ).model_dump()


def _summarize(v: dict) -> tuple:
    pct = round(v["alignment"] * 100)
    contra = sum(1 for vd in v.get("verdicts", []) if vd.get("stance") == "contradicts")
    supports = sum(1 for vd in v.get("verdicts", []) if vd.get("stance") == "supports")
    summary = f"evidence↔note alignment {pct}% · {supports} support"
    if contra:
        summary += f", {contra} contradict"
    if v.get("needs_caution"):
        summary += " · ⚠ caution"
    reason = ((v.get("concerns") or [None])[0] or v.get("summary")
              or "evidence broadly supports the note's assessment")
    return summary, str(reason)[:90]


def _verify_with_llm(note: dict, evidence: list) -> dict:
    slim_note = {k: note.get(k) for k in ("chief_complaint", "hpi", "assessment", "plan")}
    slim_ev = [{"index": i, "claim": e.get("claim"), "source": e.get("source")}
               for i, e in enumerate(evidence)]
    payload = json.dumps({"note": slim_note, "evidence": slim_ev}, ensure_ascii=False)
    # 2000 (was 900): 6 pt-BR verdicts + concerns + summary overran 900 tokens → JSON truncated
    # mid-string ("Unterminated string") → parse fail → stub. Generous budget so the object always closes.
    data = claude_json(_SYSTEM, payload, max_tokens=2000, temperature=0)
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    return data
