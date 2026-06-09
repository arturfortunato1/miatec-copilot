"""FastAPI app — exposes the agent loop to the cockpit over REST + SSE.

The human-in-the-loop gate lives here: /ingest runs the agents up to the pause, the frontend renders
the note/evidence/considerations, the doctor edits + approves via /approve, and only then does
/write run the Record agent into miatec. /roles lets the doctor confirm/swap speaker attribution,
which re-derives the note. In-memory session store is intentional — fine for the demo.
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
from app.graph import post_approval_graph, pre_approval_graph
from app.schema import ClinicalNote

load_dotenv(find_dotenv(usecwd=True))  # walks up from cwd → finds repo-root .env

app = FastAPI(title="miatec-copilot", version="0.1.0",
              description="Agentic clinical scribe → miatec write-back, with a human approval gate.")

# Wide-open CORS for the demo; lock to FRONTEND_ORIGIN before anything real.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory encounter store. Swap for Redis/Postgres later; in-memory is fine for a 36h build.
SESSIONS: dict[str, dict] = {}


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
    """Run Scribe → Roles → Structuring → Evidence → Considerations, then pause at the HITL gate."""
    # No explicit audio posted → fall back to DEFAULT_AUDIO_REF (the real consult in S3). If that's
    # also unset, Scribe uses its canned pt-BR sample, so the demo always runs.
    audio_ref = req.audio_ref or os.getenv("DEFAULT_AUDIO_REF") or None
    initial = {
        "session_id": req.session_id,
        "audio_ref": audio_ref,
        "approved": False,
    }
    state = await pre_approval_graph.ainvoke(initial)
    SESSIONS[req.session_id] = dict(state)
    await publish(req.session_id, {"agent": "human_gate", "status": "waiting"})
    return SESSIONS[req.session_id]


@app.get("/state/{session_id}")
async def get_state(session_id: str) -> dict:
    state = SESSIONS.get(session_id)
    if state is None:
        raise HTTPException(404, "unknown session")
    return state


@app.post("/roles")
async def update_roles(req: RolesUpdate) -> dict:
    """Human-in-the-loop speaker correction: swap or set doctor/patient, then re-derive the note."""
    state = SESSIONS.get(req.session_id)
    if state is None:
        raise HTTPException(404, "unknown session")

    roles = state.get("roles", {}) or {}
    mapping = dict(roles.get("mapping", {}))
    if req.mapping:
        mapping = req.mapping
    elif req.swap:
        flip = {"doctor": "patient", "patient": "doctor"}
        mapping = {label: flip.get(role, role) for label, role in mapping.items()}

    for seg in state.get("transcript", []):
        label = seg.get("speaker_label") or seg.get("speaker")
        if label in mapping:
            seg["speaker"] = mapping[label]

    roles.update({"mapping": mapping, "source": "manual", "confidence": 1.0, "needs_review": False})
    state["roles"] = roles
    await publish(req.session_id, {"agent": "roles", "status": "done", "roles": roles})

    # Roles changed → re-derive the note + considerations from the corrected transcript.
    state.update(await run_structuring(state))
    state.update(await run_evidence(state))
    state.update(await run_considerations(state))
    SESSIONS[req.session_id] = state
    return {"roles": roles, "note": state["note"], "considerations": state["considerations"]}


@app.post("/approve")
async def approve(req: ApproveRequest) -> dict:
    """Apply the doctor's edits + approval and return a miatec dry-run preview (nothing is written yet)."""
    state = SESSIONS.get(req.session_id)
    if state is None:
        raise HTTPException(404, "unknown session")

    state["note"] = req.note.model_dump()
    for idx in req.dismissed_considerations:
        if 0 <= idx < len(state.get("considerations", [])):
            state["considerations"][idx]["dismissed"] = True
    state["approved"] = True
    SESSIONS[req.session_id] = state

    await publish(req.session_id, {"agent": "human_gate", "status": "done"})
    preview = {
        "encounter": state["note"],
        "considerations": [c for c in state.get("considerations", []) if not c.get("dismissed")],
    }
    return {"approved": True, "miatec_preview": preview}


@app.post("/write/{session_id}")
async def write(session_id: str) -> dict:
    """Record agent writes the approved note into miatec."""
    state = SESSIONS.get(session_id)
    if state is None:
        raise HTTPException(404, "unknown session")
    if not state.get("approved"):
        raise HTTPException(409, "note not approved by clinician")

    # Final safety gate: never write a malformed note into miatec (the irreversible action).
    try:
        ClinicalNote(**(state.get("note") or {}))
    except Exception as exc:  # noqa: BLE001 — surface as a clear client error, don't write
        raise HTTPException(422, f"approved note failed validation: {exc}")

    state = await post_approval_graph.ainvoke(state)
    SESSIONS[session_id] = dict(state)
    return SESSIONS[session_id]


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
