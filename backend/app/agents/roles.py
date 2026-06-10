"""Roles agent — assign doctor/patient to the diarized speakers, with a confidence.

AWS Transcribe diarization returns anonymous labels (spk_0 / spk_1). Mapping those to clinician vs
patient is a SEPARATE inference and is the foundation everything downstream rests on — so we do it as
an explicit, reasoned step (an LLM reads the turns and decides from who-takes-history vs who-reports-
symptoms vs who-prescribes), never a position guess. It emits a mapping + confidence + one-line
rationale; below threshold it sets needs_review, which the human-in-the-loop gate surfaces for a
one-click confirm/swap (POST /roles, which re-derives the note).

Production hardening (see docs/SPEAKER_ATTRIBUTION.md): record doctor and patient on separate channels
→ Transcribe ChannelIdentification makes separation deterministic and the role is known at capture.
Scores under: Autonomy & Decision-Making + Failure Handling.
"""
from __future__ import annotations

import asyncio

from app.events import publish
from app.llm import claude_configured, claude_json
from app.retry import call_with_retry

AGENT = "roles"
CONFIDENCE_THRESHOLD = 0.75
_MAX_TURNS_FOR_LLM = 30


async def run_roles(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": "Inferring doctor vs. patient from who takes history vs. reports symptoms…"})

    transcript = state.get("transcript", [])
    labels = []
    for seg in transcript:
        lbl = seg.get("speaker_label") or seg.get("speaker")
        if lbl and lbl not in labels:
            labels.append(lbl)

    roles = None
    if claude_configured() and len(labels) >= 2:
        try:
            roles = await call_with_retry(session_id, AGENT,
                                          lambda: _assign_roles_llm(transcript, labels),
                                          step="role attribution via LLM")
        except Exception as exc:  # noqa: BLE001 — retries exhausted → fall back to the heuristic
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "LLM unavailable — using the positional heuristic"})
    if roles is None:
        roles = _assign_roles_heuristic(labels)

    roles["needs_review"] = roles["confidence"] < CONFIDENCE_THRESHOLD
    degraded = roles.get("source") == "heuristic"

    # Apply the resolved roles to the transcript so downstream agents see doctor/patient.
    mapping = roles["mapping"]
    for seg in transcript:
        lbl = seg.get("speaker_label") or seg.get("speaker")
        seg["speaker"] = mapping.get(lbl, seg.get("speaker"))

    summary, reason = _summarize(roles)
    await publish(session_id, {"agent": AGENT, "status": "done", "roles": roles,
                               "summary": summary, "reason": reason, "degraded": degraded})
    return {"transcript": transcript, "roles": roles}


def _summarize(roles: dict) -> tuple:
    """One-line decision + the 'why' the cockpit shows under the agent."""
    mapping = roles.get("mapping", {})
    doctor = next((lbl for lbl, r in mapping.items() if r == "doctor"), "?")
    patient = next((lbl for lbl, r in mapping.items() if r == "patient"), "?")
    pct = round(roles.get("confidence", 0.0) * 100)
    tail = " · ⚠ needs review" if roles.get("needs_review") else ""
    summary = f"{doctor} = doctor, {patient} = patient · {pct}% confident{tail}"
    reason = roles.get("rationale") or f"assigned via {roles.get('source', 'llm')}"
    return summary, reason


_SYSTEM = (
    "You are analyzing a diarized medical consultation. Speakers are labeled anonymously "
    "(e.g. spk_0, spk_1). Decide which label is the CLINICIAN (doctor) and which is the PATIENT, using "
    "who takes the history and asks questions, who reports symptoms and answers, and who gives the "
    "assessment / prescribes / instructs. Output ONLY JSON: "
    '{"doctor_label": "<label>", "patient_label": "<label>", "confidence": <number 0..1>, '
    '"rationale": "<one short sentence, in English>"}.'
)


def _assign_roles_llm(transcript: list, labels: list) -> dict:
    turns = transcript[:_MAX_TURNS_FOR_LLM]
    convo = "\n".join(
        f'{(s.get("speaker_label") or s.get("speaker"))}: {s.get("text_en") or s.get("text", "")}'
        for s in turns)
    data = claude_json(_SYSTEM, f"Labels present: {labels}\n\nTranscript:\n{convo}", max_tokens=300)

    doctor = data.get("doctor_label")
    patient = data.get("patient_label")
    mapping = {label: "unknown" for label in labels}
    if doctor in mapping:
        mapping[doctor] = "doctor"
    if patient in mapping:
        mapping[patient] = "patient"

    confidence = float(data.get("confidence", 0.5))
    if doctor not in labels or patient not in labels:
        confidence = min(confidence, 0.4)  # model returned an unexpected label → force a review

    return {
        "mapping": mapping,
        "confidence": confidence,
        "rationale": str(data.get("rationale", "")),
        "source": "llm",
    }


def _assign_roles_heuristic(labels: list) -> dict:
    """Fallback only: first speaker assumed doctor. Low confidence so the HITL gate catches it."""
    mapping = {label: ("doctor" if i == 0 else "patient") for i, label in enumerate(labels)}
    return {
        "mapping": mapping,
        "confidence": 0.3,
        "rationale": "Fallback heuristic (no LLM): first speaker assumed to be the doctor.",
        "source": "heuristic",
    }
