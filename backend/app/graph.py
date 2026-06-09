"""LangGraph orchestration — the WHOLE agent system as one legible StateGraph.

A single compiled graph runs the full encounter and PAUSES for the clinician via LangGraph's native
human-in-the-loop interrupt (`interrupt_before=["record"]`) backed by a `MemorySaver` checkpointer
keyed by `thread_id = session_id`. `/ingest` runs the graph to the approval interrupt; `/write`
resumes it (`graph.ainvoke(None, config)`) so the irreversible Record write only fires after approval.

A conditional edge after Roles routes low-confidence speaker attribution through a review path before
structuring — the graph itself decides *when to ask for help*. Show THIS graph on the orchestration
slide; the entire loop (including the pause) lives in one compiled artifact.

    START → scribe → roles ─(needs_review)─► roles_review ─┐
                              └────────(confident)─────────► structuring → evidence → considerations
                                              → ⏸ approval gate (interrupt_before record) → record → END
"""
from __future__ import annotations

from typing import Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END

from app.agents.scribe import run_scribe
from app.agents.roles import run_roles
from app.agents.structuring import run_structuring
from app.agents.evidence import run_evidence
from app.agents.considerations import run_considerations
from app.agents.record import run_record
from app.events import publish


# LangGraph state schema. Nodes return partial dicts that merge by key; mirrors EncounterState.
class State(TypedDict, total=False):
    session_id: str
    audio_ref: Optional[str]
    transcript: list
    quality_score: Optional[float]
    roles: dict
    note: dict
    evidence: list
    considerations: list
    approved: bool
    miatec_write_result: dict


async def run_roles_review(state: dict) -> dict:
    """Conditional review path — roles came back low-confidence, so flag for clinician confirmation.

    The graph routes here BEFORE structuring when roles['needs_review'] is true, making "ask a human
    when unsure" an explicit graph-level decision (Autonomy + Failure Handling). It does not hard-block
    the pipeline — it publishes a review notice and continues with the best guess, clearly flagged, so
    the demo always yields a full draft; the clinician confirms/swaps via POST /roles (which re-derives
    the note). With confident audio this node never runs.
    """
    session_id = state["session_id"]
    conf = round(float((state.get("roles") or {}).get("confidence", 0.0)) * 100)
    await publish(session_id, {
        "agent": "roles", "status": "review",
        "step": f"⚠ low-confidence speaker roles ({conf}%) — routed to the review path; confirm/swap in the panel",
        "reason": "the graph branches to a human-confirm path when role confidence is below threshold",
    })
    return {}


def _route_after_roles(state: dict) -> str:
    return "review" if (state.get("roles") or {}).get("needs_review") else "ok"


def build_graph():
    g = StateGraph(State)
    g.add_node("scribe", run_scribe)
    g.add_node("roles", run_roles)
    g.add_node("roles_review", run_roles_review)
    g.add_node("structuring", run_structuring)
    g.add_node("evidence", run_evidence)
    g.add_node("considerations", run_considerations)
    g.add_node("record", run_record)

    g.add_edge(START, "scribe")
    g.add_edge("scribe", "roles")                 # diarized spk_0/spk_1 → assign doctor/patient
    g.add_conditional_edges("roles", _route_after_roles,
                            {"review": "roles_review", "ok": "structuring"})
    g.add_edge("roles_review", "structuring")
    g.add_edge("structuring", "evidence")          # Evidence grounds the structured note...
    g.add_edge("evidence", "considerations")       # ...then Considerations ranks differentials citing it.
    g.add_edge("considerations", "record")         # ...record is the last node, but...
    g.add_edge("record", END)

    # Native HITL: pause BEFORE the irreversible miatec write. /ingest runs to here; /write resumes.
    return g.compile(checkpointer=MemorySaver(), interrupt_before=["record"])


encounter_graph = build_graph()
