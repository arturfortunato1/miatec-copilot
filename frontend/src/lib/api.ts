// Typed client for the miatec-copilot backend (FastAPI + LangGraph).
// Base URL is injected at build time via NEXT_PUBLIC_API_URL (see .env.local.example).

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type TranscriptSegment = {
  speaker: string;
  text: string; // original utterance as captured (pt-BR)
  text_en?: string | null; // clinical-English translation (Translate agent)
  confidence: number;
};
export type Vitals = { bp: string | null; hr: string | null; temp: string | null };

export type ClinicalNote = {
  chief_complaint: string;
  hpi: string;
  review_of_systems: string[];
  vitals: Vitals;
  current_medications: string[];
  allergies: string[];
  assessment: string;
  plan: string;
  low_confidence_segments: string[];
};

export type Evidence = {
  claim: string;
  source: string;
  url: string;
  snippet?: string | null;
  score?: number | null;
};

export type Consideration = {
  label: string;
  rationale: string;
  confidence: number;
  evidence_refs: number[];
  dismissed: boolean;
};

export type EvidenceVerdict = { index: number; stance: string; note: string };

export type Verification = {
  alignment: number;
  verdicts: EvidenceVerdict[];
  concerns: string[];
  summary: string;
  needs_caution: boolean;
  source: string;
};

export type MiatecWriteResult = {
  encounter_id: string | null;
  status: string;
  detail?: string | null;
};

export type SpeakerRoles = {
  mapping: Record<string, string>;   // raw label -> "doctor" | "patient" | "unknown"
  confidence: number;
  rationale: string;
  source: string;
  needs_review: boolean;
};

export type EncounterState = {
  session_id: string;
  transcript: TranscriptSegment[];
  quality_score?: number | null;
  roles?: SpeakerRoles;
  note: ClinicalNote;
  evidence: Evidence[];
  verification?: Verification;
  considerations: Consideration[];
  approved: boolean;
  miatec_write_result?: MiatecWriteResult;
};

/** Run Scribe → Structuring → Evidence → Considerations, pausing at the HITL gate. */
export async function ingest(sessionId: string) {
  const res = await fetch(`${API_BASE}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
  return (await res.json()) as EncounterState;
}

/** Apply the doctor's edits + approval; returns a miatec dry-run preview (nothing written yet). */
export async function approve(sessionId: string, note: ClinicalNote, dismissed: number[]) {
  const res = await fetch(`${API_BASE}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, note, dismissed_considerations: dismissed }),
  });
  if (!res.ok) throw new Error(`approve failed: ${res.status}`);
  return await res.json();
}

/** Record agent writes the approved note into miatec. */
export async function writeToMiatec(sessionId: string) {
  const res = await fetch(`${API_BASE}/write/${sessionId}`, { method: "POST" });
  if (!res.ok) throw new Error(`write failed: ${res.status}`);
  return (await res.json()) as EncounterState;
}

/** HITL speaker correction: swap doctor↔patient; the backend re-derives the note + considerations. */
export async function swapRoles(sessionId: string) {
  const res = await fetch(`${API_BASE}/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, swap: true }),
  });
  if (!res.ok) throw new Error(`roles update failed: ${res.status}`);
  return (await res.json()) as {
    roles: SpeakerRoles;
    note: ClinicalNote;
    verification: Verification;
    considerations: Consideration[];
  };
}
