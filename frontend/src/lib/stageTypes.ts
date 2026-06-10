// Shared types for "The Stage" cockpit. Kept dependency-free (only imports data contracts from
// lib/api) so agents.ts, rubric.ts and the stage director can all import from here without cycles.
import type {
  ClinicalNote,
  Consideration,
  Evidence,
  SpeakerRoles,
  TranscriptSegment,
  Verification,
} from "@/lib/api";

export type AgentKey =
  | "scribe"
  | "translate"
  | "roles"
  | "structuring"
  | "evidence"
  | "verifier"
  | "considerations"
  | "human_gate"
  | "record";

// The live SSE lifecycle. `streaming` (Scribe line-by-line) and `review` (a conditional-gate notice)
// arrive as string statuses and are handled specially by the director.
export type Status =
  | "idle"
  | "running"
  | "streaming"
  | "done"
  | "waiting"
  | "retry"
  | "error"
  | "review";

// The seven rubric dimensions the judges score against. The UI lights each as it is earned.
export type RubricDim =
  | "overview"
  | "autonomy"
  | "tooluse"
  | "orch"
  | "hitl"
  | "failure"
  | "demo";

// Raw event shape published by each backend agent over SSE.
export type AgentEvent = {
  agent: AgentKey;
  status: Status;
  step?: string;
  summary?: string;
  reason?: string;
  source?: string;
  audio?: string;
  query?: string;
  error?: string;
  quality_score?: number | null;
  degraded?: boolean;
  vocabulary?: boolean;
  transcript?: TranscriptSegment[];
  roles?: SpeakerRoles;
  note?: ClinicalNote | string;
  evidence?: Evidence[];
  verification?: Verification;
  considerations?: Consideration[];
  encounter_id?: string | null;
  detail?: string | null;
};

// What an agent is doing now → its decision once done.
export type Caption = {
  step?: string;
  summary?: string;
  reason?: string;
  done?: boolean;
  degraded?: boolean;
};

// A completed agent's decision, docked in the right wing.
export type Chip = {
  id: number;
  agent: AgentKey;
  summary: string;
  reason?: string;
  degraded?: boolean;
};

// Which conditional gate has fired, and the toast describing it.
export type BranchKey = "roles" | "verifier";
export type Toast = { agent: AgentKey; text: string } | null;
