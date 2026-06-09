"""Typed clinical-note + encounter-state schema (Pydantic v2).

This is the contract the agents read and write. `ClinicalNote` is validated server-side after the
Structuring agent runs; `EncounterState` documents the single shared object that flows through the
LangGraph nodes. Written to be 3.9-safe (Optional, no PEP-604 unions in evaluated annotations).
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    idle = "idle"
    running = "running"
    done = "done"
    waiting = "waiting"   # human-in-the-loop gate
    retry = "retry"       # failure handling
    error = "error"


class TranscriptSegment(BaseModel):
    speaker: str                       # "doctor" | "patient" | "unknown"
    text: str
    confidence: float = 1.0            # drives failure handling (low-confidence flags)
    start: Optional[float] = None
    end: Optional[float] = None


class Vitals(BaseModel):
    bp: Optional[str] = None
    hr: Optional[str] = None
    temp: Optional[str] = None


class ClinicalNote(BaseModel):
    """SOAP + discrete fields. Missing data is "not documented", never invented."""
    chief_complaint: str = "not documented"
    hpi: str = "not documented"
    review_of_systems: list[str] = Field(default_factory=list)
    vitals: Vitals = Field(default_factory=Vitals)
    current_medications: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    assessment: str = "not documented"
    plan: str = "not documented"
    low_confidence_segments: list[str] = Field(default_factory=list)


class Evidence(BaseModel):
    claim: str
    source: str
    url: str
    snippet: Optional[str] = None
    score: Optional[float] = None


class Consideration(BaseModel):
    """A ranked differential — decision SUPPORT, never an autonomous diagnosis."""
    label: str
    rationale: str
    confidence: float
    evidence_refs: list[int] = Field(default_factory=list)   # indices into EncounterState.evidence
    dismissed: bool = False


class MiatecWriteResult(BaseModel):
    encounter_id: Optional[str] = None
    status: str = "pending"            # pending | success | error
    detail: Optional[str] = None


class Invoice(BaseModel):
    invoice_id: Optional[str] = None
    amount_cents: Optional[int] = None
    status: str = "pending"


class EncounterState(BaseModel):
    """The single shared object that flows through the LangGraph nodes."""
    session_id: str
    audio_ref: Optional[str] = None
    transcript: list[TranscriptSegment] = Field(default_factory=list)
    note: ClinicalNote = Field(default_factory=ClinicalNote)
    evidence: list[Evidence] = Field(default_factory=list)
    considerations: list[Consideration] = Field(default_factory=list)
    approved: bool = False
    enable_billing: bool = False
    miatec_write_result: MiatecWriteResult = Field(default_factory=MiatecWriteResult)
    invoice: Optional[Invoice] = None
    errors: list[str] = Field(default_factory=list)
