// The rubric layer — the bridge between what a judge SEES and what they SCORE.
// One muted "ink" per scoring dimension (separate from the loud per-agent accents). The same ink
// reappears everywhere that dimension recurs, so coverage is visually provable.
import type { AgentKey, RubricDim } from "@/lib/stageTypes";

export type RubricMeta = {
  key: RubricDim;
  label: string; // exact rubric wording
  short: string; // compact label for the marquee lanyard
  ink: string; // muted, dimension-keyed hex
  earnedBy: string; // one-line caption naming the on-stage moment that lights it
};

// Ordered exactly as the official judging criteria are listed.
export const RUBRIC: RubricMeta[] = [
  {
    key: "overview",
    label: "Agent Overview",
    short: "Agent Overview",
    ink: "#7C8B97",
    earnedBy: "8 named, purposed agents stand on the rail",
  },
  {
    key: "autonomy",
    label: "Autonomy & Decision-Making",
    short: "Autonomy",
    ink: "#9A9AD8",
    earnedBy: "agents reason: structure the note, rank differentials",
  },
  {
    key: "tooluse",
    label: "Actions & Tool Use",
    short: "Tool Use",
    ink: "#54C2B4",
    earnedBy: "real AWS Transcribe audio · real Exa citations",
  },
  {
    key: "orch",
    label: "Orchestration",
    short: "Orchestration",
    ink: "#BD9CD4",
    earnedBy: "one LangGraph routes the agents — and branches when unsure",
  },
  {
    key: "hitl",
    label: "Human-in-the-Loop",
    short: "Human-in-the-Loop",
    ink: "#7FA6D6",
    earnedBy: "nothing writes to miatec until the doctor approves",
  },
  {
    key: "failure",
    label: "Failure Handling",
    short: "Failure Handling",
    ink: "#D6A85C",
    earnedBy: "low confidence flagged, branches fire, fallbacks kick in",
  },
  {
    key: "demo",
    label: "Demo & Presentation",
    short: "Demo",
    ink: "#9A9A96",
    earnedBy: "the encounter is filed end-to-end, live",
  },
];

export const RUBRIC_META: Record<RubricDim, RubricMeta> = Object.fromEntries(
  RUBRIC.map((r) => [r.key, r]),
) as Record<RubricDim, RubricMeta>;

// The gold: each agent → the rubric dimension(s) it earns. Shown as a "lanyard" badge on the marquee
// so a judge maps the live moment straight onto their scorecard.
export const AGENT_RUBRIC: Record<AgentKey, RubricDim[]> = {
  scribe: ["tooluse"],
  translate: ["tooluse"],
  roles: ["autonomy", "failure"],
  structuring: ["autonomy"],
  evidence: ["tooluse"],
  verifier: ["autonomy", "failure"],
  considerations: ["autonomy"],
  human_gate: ["hitl"],
  record: ["tooluse"],
};

export function inkFor(dim: RubricDim): string {
  return RUBRIC_META[dim]?.ink ?? "#8A8A86";
}
