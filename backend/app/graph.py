"""LangGraph orchestration — the agent system, expressed as a graph.

The full loop has a human-in-the-loop interrupt in the middle, so it's modelled as TWO compiled
graphs with the approval gate between them (the API holds state across the pause):

    ┌──────────────── pre-approval graph ────────────────┐                  ┌── post-approval ──┐
    scribe → structuring → evidence → considerations  →  ⏸ HUMAN GATE  →  record → (billing?)
    └────────────────────────────────────────────────────┘                  └───────────────────┘

Splitting at the gate keeps the demo dead-simple and avoids checkpointer plumbing. When you want
native pause/resume, collapse these into one StateGraph compiled with a checkpointer +
`interrupt_before=["record"]` — same shape, fancier resume. Show this graph on the orchestration slide.
"""
from __future__ import annotations

from typing import Optional, TypedDict

from langgraph.graph import StateGraph, START, END

from app.agents.scribe import run_scribe
from app.agents.structuring import run_structuring
from app.agents.evidence import run_evidence
from app.agents.considerations import run_considerations
from app.agents.record import run_record
from app.agents.billing import run_billing


# LangGraph state schema. Nodes return partial dicts that merge by key; mirrors EncounterState.
class State(TypedDict, total=False):
    session_id: str
    audio_ref: Optional[str]
    transcript: list
    note: dict
    evidence: list
    considerations: list
    approved: bool
    enable_billing: bool
    miatec_write_result: dict
    invoice: dict


def build_pre_approval_graph():
    g = StateGraph(State)
    g.add_node("scribe", run_scribe)
    g.add_node("structuring", run_structuring)
    g.add_node("evidence", run_evidence)
    g.add_node("considerations", run_considerations)
    g.add_edge(START, "scribe")
    g.add_edge("scribe", "structuring")
    g.add_edge("structuring", "evidence")          # Evidence grounds the structured note...
    g.add_edge("evidence", "considerations")       # ...then Considerations ranks differentials citing it.
    g.add_edge("considerations", END)
    return g.compile()


def _maybe_bill(state: State) -> str:
    return "billing" if state.get("enable_billing") else "end"


def build_post_approval_graph():
    g = StateGraph(State)
    g.add_node("record", run_record)
    g.add_node("billing", run_billing)
    g.add_edge(START, "record")
    g.add_conditional_edges("record", _maybe_bill, {"billing": "billing", "end": END})
    g.add_edge("billing", END)
    return g.compile()


pre_approval_graph = build_pre_approval_graph()
post_approval_graph = build_post_approval_graph()
