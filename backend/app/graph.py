"""LangGraph orchestration — the WHOLE agent system as one legible StateGraph.

A single compiled graph runs the full encounter and PAUSES for the clinician via LangGraph's native
human-in-the-loop interrupt (`interrupt_before=["record"]`) backed by a `MemorySaver` checkpointer
keyed by `thread_id = session_id`. `/ingest` runs the graph to the approval interrupt; `/write`
resumes it (`graph.ainvoke(None, config)`) so the irreversible Record write only fires after approval.

Two conditional edges route on the agents' own confidence signals. After Roles, low-confidence
speaker attribution is routed through a review path before structuring. After the Verifier — which
cross-checks the retrieved evidence against the note's assessment — weak or contradicting evidence is
routed through a **reconcile loop**: re-query the literature with a refined assessment-focused query,
re-verify the merged evidence, and only then let Considerations rank (hedging if alignment is still
weak). Routing is decided by the scores the agents emit, so the system corrects itself exactly when
it's unsure. Show THIS graph on the orchestration slide; the entire loop (including the pause) lives
in one compiled artifact.

    START → scribe → translate → roles ─(needs_review)─► roles_review ─┐
                                   └──────(confident)──────────────────► structuring → evidence → verifier
       verifier ─(weak/contradicting evidence)─► reconcile ─┐
                 └──────────(evidence supports)─────────────► considerations
                                 → ⏸ approval gate (interrupt_before record) → record → END
"""
from __future__ import annotations

from typing import Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END

from app.agents.scribe import run_scribe
from app.agents.translator import run_translate
from app.agents.roles import run_roles
from app.agents.structuring import run_structuring
from app.agents.evidence import run_evidence, run_evidence_requery
from app.agents.verifier import run_verifier
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
    verification: dict
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


async def run_reconcile(state: dict) -> dict:
    """Conditional CORRECTIVE LOOP — the Verifier found the evidence weakly supports (or contradicts)
    the note, so the system goes back to the literature before ranking.

    Routed here when verification['needs_caution']. The node ACTS: it builds a refined,
    assessment-focused query from the note + the Verifier's top concern, re-queries Exa (tiered, like
    the Evidence agent), re-runs the Verifier over the merged evidence, and narrates the before/after
    alignment. Considerations then reads the FINAL verification — recovered → it ranks normally;
    still weak → it hedges. Bounded by construction: the graph is acyclic, one pass, no cycles.
    With well-supported notes this node never runs.
    """
    session_id = state["session_id"]
    v = state.get("verification", {}) or {}
    pct = round(float(v.get("alignment", 0.0)) * 100)
    concern = str((v.get("concerns") or [v.get("summary") or "evidence weakly supports the note"])[0])
    await publish(session_id, {
        "agent": "verifier", "status": "review",
        "step": f"⚠ low evidence↔note alignment ({pct}%) — re-querying the literature before ranking",
        "reason": concern[:120],
    })

    note = state.get("note", {}) or {}
    assessment = note.get("assessment") or ""
    focus = assessment if assessment and assessment != "not documented" else note.get("chief_complaint", "")
    refined = f"clinical evidence for: {focus[:160]}; addressing: {concern[:120]}" if focus else ""

    upd = await run_evidence_requery(state, refined)
    if not upd.get("evidence"):
        await publish(session_id, {
            "agent": "verifier", "status": "review",
            "step": f"no stronger sources found — Considerations will stay conservative ({pct}%)",
            "reason": concern[:120],
        })
        return {}

    reverified = await run_verifier({**state, **upd})
    nv = reverified.get("verification", {}) or {}
    new_pct = round(float(nv.get("alignment", 0.0)) * 100)
    outcome = ("alignment recovered — Considerations ranks normally"
               if not nv.get("needs_caution") else "still weak — Considerations will hedge")
    await publish(session_id, {
        "agent": "verifier", "status": "review",
        "step": f"reconcile loop: alignment {pct}% → {new_pct}% after the re-query — {outcome}",
        "reason": "the system corrected its own evidence base before ranking differentials",
    })
    return {**upd, **reverified}


def _route_after_verify(state: dict) -> str:
    return "caution" if (state.get("verification") or {}).get("needs_caution") else "ok"


def build_graph():
    g = StateGraph(State)
    g.add_node("scribe", run_scribe)
    g.add_node("translate", run_translate)
    g.add_node("roles", run_roles)
    g.add_node("roles_review", run_roles_review)
    g.add_node("structuring", run_structuring)
    g.add_node("evidence", run_evidence)
    g.add_node("verifier", run_verifier)
    g.add_node("reconcile", run_reconcile)
    g.add_node("considerations", run_considerations)
    g.add_node("record", run_record)

    g.add_edge(START, "scribe")
    g.add_edge("scribe", "translate")             # pt-BR capture → clinical-English normalization
    g.add_edge("translate", "roles")              # diarized spk_0/spk_1 → assign doctor/patient
    g.add_conditional_edges("roles", _route_after_roles,
                            {"review": "roles_review", "ok": "structuring"})
    g.add_edge("roles_review", "structuring")
    g.add_edge("structuring", "evidence")          # Evidence grounds the structured note...
    g.add_edge("evidence", "verifier")             # ...the Verifier checks evidence↔note alignment...
    g.add_conditional_edges("verifier", _route_after_verify,   # ...low alignment → reconcile (caution)...
                            {"caution": "reconcile", "ok": "considerations"})
    g.add_edge("reconcile", "considerations")
    g.add_edge("considerations", "record")         # ...then Considerations ranks differentials; record last,
    g.add_edge("record", END)

    # Native HITL: pause BEFORE the irreversible miatec write. /ingest runs to here; /write resumes.
    return g.compile(checkpointer=MemorySaver(), interrupt_before=["record"])


encounter_graph = build_graph()
