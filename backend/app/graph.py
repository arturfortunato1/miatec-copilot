"""LangGraph orchestration — the agent system, expressed as a graph.

The full loop has a human-in-the-loop interrupt in the middle, so it's modelled as TWO compiled
graphs with the approval gate between them (the API holds state across the pause):

    ┌──────────────────────── pre-approval graph ────────────────────────┐              ┌ post ┐
    scribe → roles → structuring → evidence → considerations  →  ⏸ HUMAN GATE  →        record
    └─────────────────────────────────────────────────────────────────────┘              └──────┘

Scribe diarizes anonymously (spk_0/spk_1); the Roles node assigns doctor/patient (with confidence)
before anything is structured. Splitting at the gate keeps the demo dead-simple and avoids
checkpointer plumbing. Show this graph on the orchestration slide.
"""
from __future__ import annotations

from typing import Optional, TypedDict

from langgraph.graph import StateGraph, START, END

from app.agents.scribe import run_scribe
from app.agents.roles import run_roles
from app.agents.structuring import run_structuring
from app.agents.evidence import run_evidence
from app.agents.considerations import run_considerations
from app.agents.record import run_record


# LangGraph state schema. Nodes return partial dicts that merge by key; mirrors EncounterState.
class State(TypedDict, total=False):
    session_id: str
    audio_ref: Optional[str]
    transcript: list
    roles: dict
    note: dict
    evidence: list
    considerations: list
    approved: bool
    miatec_write_result: dict


def build_pre_approval_graph():
    g = StateGraph(State)
    g.add_node("scribe", run_scribe)
    g.add_node("roles", run_roles)
    g.add_node("structuring", run_structuring)
    g.add_node("evidence", run_evidence)
    g.add_node("considerations", run_considerations)
    g.add_edge(START, "scribe")
    g.add_edge("scribe", "roles")                  # diarized spk_0/spk_1 → assign doctor/patient
    g.add_edge("roles", "structuring")             # structure only after roles are assigned
    g.add_edge("structuring", "evidence")          # Evidence grounds the structured note...
    g.add_edge("evidence", "considerations")       # ...then Considerations ranks differentials citing it.
    g.add_edge("considerations", END)
    return g.compile()


def build_post_approval_graph():
    g = StateGraph(State)
    g.add_node("record", run_record)
    g.add_edge(START, "record")
    g.add_edge("record", END)
    return g.compile()


pre_approval_graph = build_pre_approval_graph()
post_approval_graph = build_post_approval_graph()
