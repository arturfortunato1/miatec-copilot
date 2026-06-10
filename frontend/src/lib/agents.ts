// Per-agent metadata: identity, accent, the real sponsor surface it runs on, and where its
// self-reported confidence comes from. One accent per agent (kept from the original design), used
// only as glow/ring/marquee tint — exactly one is "live" on stage at a time.
import type { AgentKey } from "@/lib/stageTypes";

export type ConfidenceSource =
  | "quality" // Scribe — mean AWS Transcribe word confidence
  | "rolesConf" // Roles — LLM role-attribution confidence
  | "alignment" // Verifier — evidence↔note alignment
  | "considerations" // Considerations — top differential confidence
  | null; // no self-confidence → neutral "complete" ring

export type AgentMeta = {
  key: AgentKey;
  num: number; // 1-based position on the wings rail
  label: string;
  sub: string; // one-line purpose
  step: string; // default "what it's doing" line before the first SSE step lands
  accent: string; // hex, projector-bright
  sponsor: string | null; // the real tool/API surfaced under the marquee
  confidence: ConfidenceSource;
  note?: string; // optional explainer surfaced as a tooltip on the flow node
};

export const AGENTS: AgentMeta[] = [
  {
    key: "scribe",
    num: 1,
    label: "Scribe",
    sub: "audio → diarized transcript",
    step: "Transcribing the consultation…",
    accent: "#A78BFA",
    sponsor: "AWS Transcribe · clinical vocab",
    confidence: "quality",
  },
  {
    key: "translate",
    num: 2,
    label: "Translate",
    sub: "pt-BR → clinical English",
    step: "Translating the consultation into clinical English…",
    accent: "#22D3EE",
    sponsor: "Claude · AI Gateway",
    confidence: null,
    note: "A real agent in the graph — here so you can follow this pt-BR recording. In a same-language clinic it's a pass-through, not needed day-to-day.",
  },
  {
    key: "roles",
    num: 3,
    label: "Roles",
    sub: "doctor vs. patient",
    step: "Inferring doctor vs. patient…",
    accent: "#38BDF8",
    sponsor: "Claude · AI Gateway",
    confidence: "rolesConf",
  },
  {
    key: "structuring",
    num: 4,
    label: "Structuring",
    sub: "transcript → SOAP note",
    step: "Mapping the transcript into a SOAP note…",
    accent: "#34D399",
    sponsor: "Claude · AI Gateway",
    confidence: null,
  },
  {
    key: "evidence",
    num: 5,
    label: "Evidence",
    sub: "cited guidelines",
    step: "Searching guidelines to ground the note…",
    accent: "#FBBF24",
    sponsor: "Exa · search_and_contents",
    confidence: null,
  },
  {
    key: "verifier",
    num: 6,
    label: "Verifier",
    sub: "evidence ↔ note check",
    step: "Cross-checking the evidence against the note…",
    accent: "#FB7185",
    sponsor: "Claude · AI Gateway",
    confidence: "alignment",
  },
  {
    key: "considerations",
    num: 7,
    label: "Considerations",
    sub: "ranked differentials",
    step: "Ranking differential considerations…",
    accent: "#E879F9",
    sponsor: "Claude · AI Gateway",
    confidence: "considerations",
  },
  {
    key: "human_gate",
    num: 8,
    label: "Human gate",
    sub: "the doctor approves",
    step: "Awaiting your review & approval",
    accent: "#60A5FA",
    sponsor: "LangGraph · interrupt()",
    confidence: null,
  },
  {
    key: "record",
    num: 9,
    label: "Record",
    sub: "write → miatec staging",
    step: "Writing the encounter to the miatec staging store…",
    accent: "#2DD4BF",
    sponsor: "AWS DynamoDB → miatec",
    confidence: null,
  },
];

export const AGENT_META: Record<AgentKey, AgentMeta> = Object.fromEntries(
  AGENTS.map((a) => [a.key, a]),
) as Record<AgentKey, AgentMeta>;

export const AGENT_INDEX: Record<AgentKey, number> = Object.fromEntries(
  AGENTS.map((a, i) => [a.key, i]),
) as Record<AgentKey, number>;

export function labelFor(agent: AgentKey): string {
  return AGENT_META[agent]?.label ?? agent;
}
