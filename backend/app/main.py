"""FastAPI app — exposes the agent loop to the cockpit over REST + SSE.

The whole encounter is ONE LangGraph (`app.graph.encounter_graph`) with a native human-in-the-loop
interrupt before the Record node and a MemorySaver checkpointer keyed by `thread_id = session_id`:

  /ingest  → graph.ainvoke(initial, thread)         runs to the approval interrupt (before record)
  /roles   → re-derive note from corrected speakers, persist via aupdate_state   (HITL correction)
  /approve → aupdate_state(note + dismissed + approved=True)                      (HITL gate)
  /write   → graph.ainvoke(None, thread)            resumes past the interrupt → Record → END

State lives in the checkpointer (no side store). The agents publish() to an SSE channel that /stream
forwards, so the cockpit animates the same graph live.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app.agents.considerations import run_considerations
from app.agents.evidence import run_evidence
from app.agents.structuring import run_structuring
from app.events import publish, subscribe, unsubscribe
from app.graph import encounter_graph
from app.schema import ClinicalNote

load_dotenv(find_dotenv(usecwd=True))  # walks up from cwd → finds repo-root .env

app = FastAPI(title="miatec-copilot", version="0.2.0",
              description="Agentic clinical scribe → miatec write-back, with a native HITL interrupt.")

# Wide-open CORS for the demo; lock to FRONTEND_ORIGIN before anything real.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cfg(session_id: str) -> dict:
    """LangGraph thread config — the session is the checkpointer thread."""
    return {"configurable": {"thread_id": session_id}}


async def _values(session_id: str) -> Optional[dict]:
    """Current checkpointed state values for a session (None if the thread is unknown)."""
    snap = await encounter_graph.aget_state(_cfg(session_id))
    return dict(snap.values) if snap and snap.values else None


class IngestRequest(BaseModel):
    session_id: str
    audio_ref: Optional[str] = None


class ApproveRequest(BaseModel):
    session_id: str
    note: ClinicalNote
    dismissed_considerations: list[int] = []


class RolesUpdate(BaseModel):
    session_id: str
    swap: bool = False                       # flip doctor <-> patient
    mapping: Optional[dict] = None           # or set an explicit raw-label -> role mapping


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "miatec-copilot"}


@app.post("/ingest")
async def ingest(req: IngestRequest) -> dict:
    """Run the graph (Scribe → Roles → Structuring → Evidence → Considerations) to the approval interrupt."""
    # No explicit audio posted → fall back to DEFAULT_AUDIO_REF (the real consult in S3). If that's
    # also unset, Scribe uses its canned pt-BR sample, so the demo always runs.
    audio_ref = req.audio_ref or os.getenv("DEFAULT_AUDIO_REF") or None
    initial = {"session_id": req.session_id, "audio_ref": audio_ref, "approved": False}
    state = await encounter_graph.ainvoke(initial, _cfg(req.session_id))  # pauses before record
    await publish(req.session_id, {"agent": "human_gate", "status": "waiting"})
    return state


@app.get("/state/{session_id}")
async def get_state(session_id: str) -> dict:
    state = await _values(session_id)
    if state is None:
        raise HTTPException(404, "unknown session")
    return state


@app.post("/roles")
async def update_roles(req: RolesUpdate) -> dict:
    """Human-in-the-loop speaker correction: swap or set doctor/patient, then re-derive the note."""
    state = await _values(req.session_id)
    if state is None:
        raise HTTPException(404, "unknown session")

    roles = dict(state.get("roles", {}) or {})
    mapping = dict(roles.get("mapping", {}))
    if req.mapping:
        mapping = req.mapping
    elif req.swap:
        flip = {"doctor": "patient", "patient": "doctor"}
        mapping = {label: flip.get(role, role) for label, role in mapping.items()}

    transcript = [dict(seg) for seg in state.get("transcript", [])]
    for seg in transcript:
        label = seg.get("speaker_label") or seg.get("speaker")
        if label in mapping:
            seg["speaker"] = mapping[label]

    roles.update({"mapping": mapping, "source": "manual", "confidence": 1.0, "needs_review": False})
    state["roles"] = roles
    state["transcript"] = transcript
    doctor = next((l for l, r in mapping.items() if r == "doctor"), "?")
    patient = next((l for l, r in mapping.items() if r == "patient"), "?")
    await publish(req.session_id, {"agent": "roles", "status": "done", "roles": roles, "degraded": False,
                                   "summary": f"{doctor} = doctor, {patient} = patient · clinician-set (100%)",
                                   "reason": "human-in-the-loop correction — note re-derived"})

    # Roles changed → re-derive the note + evidence + considerations from the corrected transcript.
    state.update(await run_structuring(state))
    state.update(await run_evidence(state))
    state.update(await run_considerations(state))
    await encounter_graph.aupdate_state(_cfg(req.session_id), {
        "roles": roles, "transcript": transcript, "note": state["note"],
        "evidence": state["evidence"], "considerations": state["considerations"],
    })
    return {"roles": roles, "note": state["note"], "considerations": state["considerations"]}


@app.post("/approve")
async def approve(req: ApproveRequest) -> dict:
    """Apply the doctor's edits + approval into the checkpoint (nothing is written until /write)."""
    state = await _values(req.session_id)
    if state is None:
        raise HTTPException(404, "unknown session")

    note = req.note.model_dump()
    considerations = [dict(c) for c in state.get("considerations", [])]
    for idx in req.dismissed_considerations:
        if 0 <= idx < len(considerations):
            considerations[idx]["dismissed"] = True

    await encounter_graph.aupdate_state(_cfg(req.session_id),
                                        {"note": note, "considerations": considerations, "approved": True})
    await publish(req.session_id, {"agent": "human_gate", "status": "done"})
    preview = {
        "encounter": note,
        "considerations": [c for c in considerations if not c.get("dismissed")],
    }
    return {"approved": True, "miatec_preview": preview}


@app.post("/write/{session_id}")
async def write(session_id: str) -> dict:
    """Resume the graph past the approval interrupt — the Record agent writes the note into miatec."""
    state = await _values(session_id)
    if state is None:
        raise HTTPException(404, "unknown session")
    if not state.get("approved"):
        raise HTTPException(409, "note not approved by clinician")

    # Final safety gate: never write a malformed note into miatec (the irreversible action).
    try:
        ClinicalNote(**(state.get("note") or {}))
    except Exception as exc:  # noqa: BLE001 — surface as a clear client error, don't write
        raise HTTPException(422, f"approved note failed validation: {exc}")

    state = await encounter_graph.ainvoke(None, _cfg(session_id))  # resume → record → END
    return state


@app.get("/stream/{session_id}")
async def stream(session_id: str) -> EventSourceResponse:
    """SSE: agents lighting up live. The cockpit listens here to animate the pipeline."""
    q = subscribe(session_id)

    async def gen():
        try:
            yield {"event": "connected", "data": session_id}
            while True:
                event = await q.get()
                yield {"event": "agent", "data": json.dumps(event)}
        finally:
            unsubscribe(session_id, q)

    return EventSourceResponse(gen())
