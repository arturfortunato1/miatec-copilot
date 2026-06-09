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
    speaker: str                         # resolved role: "doctor" | "patient" | raw label (pre-Roles)
    speaker_label: Optional[str] = None  # raw diarization label from Transcribe (spk_0 / spk_1)
    text: str
    confidence: float = 1.0              # drives failure handling (low-confidence flags)
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


class SpeakerRoles(BaseModel):
    """Maps raw diarization labels (spk_0/spk_1) → clinical roles, with assertiveness signals."""
    mapping: dict[str, str] = Field(default_factory=dict)   # raw label -> "doctor" | "patient" | "unknown"
    confidence: float = 0.0
    rationale: str = ""
    source: str = "llm"               # llm | heuristic | manual | channel
    needs_review: bool = False        # confidence below threshold -> HITL confirm/swap


class EncounterState(BaseModel):
    """The single shared object that flows through the LangGraph nodes."""
    session_id: str
    audio_ref: Optional[str] = None
    transcript: list[TranscriptSegment] = Field(default_factory=list)
    roles: SpeakerRoles = Field(default_factory=SpeakerRoles)
    note: ClinicalNote = Field(default_factory=ClinicalNote)
    evidence: list[Evidence] = Field(default_factory=list)
    considerations: list[Consideration] = Field(default_factory=list)
    approved: bool = False
    miatec_write_result: MiatecWriteResult = Field(default_factory=MiatecWriteResult)
    errors: list[str] = Field(default_factory=list)
