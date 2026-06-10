"use client";
// useStageDirector — the single source of truth for the cockpit.
//
// The raw SSE stream is bursty: a `done` can land milliseconds after `running`, and two agents can
// finish back-to-back. If the spotlight followed every frame it would strobe. So the director paces
// the VISUAL active agent with a minimum on-stage dwell (a FIFO queue), while data (transcript, note,
// evidence…) always lands immediately. It also accumulates which rubric dimensions have been earned,
// so the judges' scorecard fills itself in real time.
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ClinicalNote,
  Consideration,
  EncounterState,
  Evidence,
  MiatecWriteResult,
  SpeakerRoles,
  TranscriptSegment,
  Verification,
} from "@/lib/api";
import { AGENT_META } from "@/lib/agents";
import type {
  AgentEvent,
  AgentKey,
  BranchKey,
  Caption,
  Chip,
  RubricDim,
  Status,
  Toast,
} from "@/lib/stageTypes";

const DWELL_MS = 1200; // minimum time an agent holds the spotlight before a hand-off can fire

const KEYS: AgentKey[] = [
  "scribe", "translate", "roles", "structuring", "evidence",
  "verifier", "considerations", "human_gate", "record",
];

const INITIAL_STATUS = Object.fromEntries(KEYS.map((k) => [k, "idle"])) as Record<AgentKey, Status>;
const EMPTY_CAPTIONS = Object.fromEntries(KEYS.map((k) => [k, {}])) as Record<AgentKey, Caption>;

export type Audio = { name?: string; source?: string; vocabulary?: boolean };

/** The self-reported confidence a given agent puts on the marquee arc (null → neutral "complete" ring). */
export function agentConfidence(
  agent: AgentKey | null,
  d: {
    qualityScore: number | null;
    roles: SpeakerRoles | null;
    verification: Verification | null;
    considerations: Consideration[];
  },
): number | null {
  if (!agent) return null;
  switch (AGENT_META[agent].confidence) {
    case "quality":
      return d.qualityScore;
    case "rolesConf":
      return d.roles ? d.roles.confidence : null;
    case "alignment":
      return d.verification ? d.verification.alignment : null;
    case "considerations":
      return d.considerations.length
        ? Math.max(...d.considerations.map((c) => c.confidence))
        : null;
    default:
      return null;
  }
}

export function useStageDirector() {
  const [activeAgent, setActiveAgent] = useState<AgentKey | null>(null);
  const [statuses, setStatuses] = useState<Record<AgentKey, Status>>(INITIAL_STATUS);
  const [captions, setCaptions] = useState<Record<AgentKey, Caption>>(EMPTY_CAPTIONS);

  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [roles, setRoles] = useState<SpeakerRoles | null>(null);
  const [note, setNote] = useState<ClinicalNote | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [evidenceQuery, setEvidenceQuery] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [considerations, setConsiderations] = useState<Consideration[]>([]);
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const [audio, setAudio] = useState<Audio>({});
  const [writeResult, setWriteResult] = useState<MiatecWriteResult | null>(null);
  const [approved, setApproved] = useState(false);

  const [branch, setBranch] = useState<Record<BranchKey, boolean>>({ roles: false, verifier: false });
  const [toast, setToast] = useState<Toast>(null);
  const [satisfied, setSatisfied] = useState<Set<RubricDim>>(new Set<RubricDim>(["overview"]));
  const [chips, setChips] = useState<Chip[]>([]);
  const [encounterConfidence, setEncounterConfidence] = useState<number | null>(null);

  // Pacing state lives in refs (no re-render) — only the promoted activeAgent is state.
  const activeRef = useRef<AgentKey | null>(null);
  const queueRef = useRef<AgentKey[]>([]);
  const lastSwitchRef = useRef<number>(0);
  const lastEnqueuedRef = useRef<AgentKey | null>(null);
  const timerRef = useRef<number | null>(null);
  const chipIdRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  // The pacing loop lives in a ref so it can re-schedule itself; assigned in a mount effect (never
  // during render). It only reads refs + the stable setActiveAgent, so one closure lasts the lifetime.
  const pumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    pumpRef.current = () => {
      if (queueRef.current.length === 0) return;
      const since = Date.now() - lastSwitchRef.current;
      if (activeRef.current !== null && since < DWELL_MS) {
        if (timerRef.current == null) {
          timerRef.current = window.setTimeout(() => { timerRef.current = null; pumpRef.current(); }, DWELL_MS - since);
        }
        return;
      }
      const next = queueRef.current.shift()!;
      activeRef.current = next;
      lastSwitchRef.current = Date.now();
      setActiveAgent(next);
      if (queueRef.current.length > 0 && timerRef.current == null) {
        timerRef.current = window.setTimeout(() => { timerRef.current = null; pumpRef.current(); }, DWELL_MS);
      }
    };
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const mark = useCallback((...dims: RubricDim[]) => {
    setSatisfied((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const d of dims) if (!next.has(d)) { next.add(d); changed = true; }
      return changed ? next : prev;
    });
  }, []);

  const enqueueFocus = useCallback((agent: AgentKey) => {
    if (lastEnqueuedRef.current === agent) return;
    lastEnqueuedRef.current = agent;
    if (activeRef.current === agent && queueRef.current.length === 0) return;
    queueRef.current.push(agent);
    pumpRef.current();
  }, []);

  const fireToast = useCallback((agent: AgentKey, text: string) => {
    setToast({ agent, text });
    if (toastTimerRef.current != null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 5200);
  }, []);

  const reset = useCallback(() => {
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (toastTimerRef.current != null) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null; }
    queueRef.current = [];
    lastEnqueuedRef.current = null;
    activeRef.current = null;
    lastSwitchRef.current = 0;
    chipIdRef.current = 0;
    setActiveAgent(null);
    setStatuses({ ...INITIAL_STATUS });
    setCaptions({ ...EMPTY_CAPTIONS });
    setTranscript([]);
    setRoles(null);
    setNote(null);
    setEvidence([]);
    setEvidenceQuery(null);
    setEvidenceNote(null);
    setVerification(null);
    setConsiderations([]);
    setQualityScore(null);
    setAudio({});
    setWriteResult(null);
    setApproved(false);
    setBranch({ roles: false, verifier: false });
    setToast(null);
    setSatisfied(new Set<RubricDim>(["overview"]));
    setChips([]);
    setEncounterConfidence(null);
  }, []);

  const applyEvent = useCallback((ev: AgentEvent) => {
    const status = ev.status;

    // Conditional-gate notice — ignite the branch; do NOT steal the spotlight.
    if (status === "review") {
      const key: BranchKey | null =
        ev.agent === "roles" ? "roles" : ev.agent === "verifier" ? "verifier" : null;
      if (key) {
        setBranch((b) => (b[key] ? b : { ...b, [key]: true }));
        fireToast(ev.agent, ev.step ?? "conditional branch fired");
        mark("orch", "failure");
      }
      return;
    }

    // Scribe streaming the transcript in line-by-line — keep the rail spinning, pace focus to scribe.
    if (status === "streaming") {
      if (ev.transcript) setTranscript(ev.transcript);
      setStatuses((s) => ({ ...s, [ev.agent]: "streaming" }));
      setCaptions((c) => ({
        ...c,
        [ev.agent]: { ...c[ev.agent], step: ev.step ?? "Transcribing…", done: false },
      }));
      enqueueFocus(ev.agent);
      return;
    }

    setStatuses((s) => ({ ...s, [ev.agent]: status }));

    setCaptions((c) => {
      const next = { ...c };
      const prev = c[ev.agent] ?? {};
      if (status === "running")
        next[ev.agent] = { step: ev.step ?? AGENT_META[ev.agent]?.step ?? "working…", done: false };
      else if (status === "done")
        next[ev.agent] = { step: prev.step, summary: ev.summary ?? "done", reason: ev.reason, done: true, degraded: ev.degraded };
      else if (status === "waiting")
        next[ev.agent] = { step: "Awaiting your review & approval", done: false };
      else if (status === "retry" || status === "error")
        next[ev.agent] = { step: ev.step ?? ev.error ?? status, reason: ev.reason, done: false };
      return next;
    });

    if (status === "running" || status === "waiting" || status === "retry" || status === "error") {
      enqueueFocus(ev.agent);
    }
    // The instant any non-Scribe agent starts, the LangGraph has routed control — orchestration shown.
    if (status === "running" && ev.agent !== "scribe") mark("orch");

    if (status === "done") {
      setChips((prev) => [
        { id: chipIdRef.current++, agent: ev.agent, summary: ev.summary ?? "done", reason: ev.reason, degraded: ev.degraded },
        ...prev,
      ]);
    }

    if (status === "retry" || status === "error") mark("failure");
    if (ev.degraded) mark("failure");

    if (ev.agent === "scribe") {
      if (ev.audio) setAudio((a) => ({ ...a, name: ev.audio }));
      if (ev.source) setAudio((a) => ({ ...a, source: ev.source }));
      if (typeof ev.vocabulary === "boolean") setAudio((a) => ({ ...a, vocabulary: ev.vocabulary }));
      if (typeof ev.quality_score === "number") { setQualityScore(ev.quality_score); setEncounterConfidence(ev.quality_score); }
      if (ev.transcript) setTranscript(ev.transcript);
      if (status === "done") {
        if (ev.source === "s3" || ev.source === "cache") mark("tooluse");
        if (typeof ev.quality_score === "number" && ev.quality_score < 0.85) mark("failure");
        if (ev.transcript?.some((t) => t.confidence < 0.7)) mark("failure");
      }
    }
    // Translate done → the same transcript, now carrying text_en per segment. Replacing the array is
    // what triggers the cockpit's "rewriting" wave.
    if (ev.agent === "translate" && ev.transcript) setTranscript(ev.transcript);
    if (ev.agent === "roles" && ev.roles) {
      setRoles(ev.roles);
      if (typeof ev.roles.confidence === "number") setEncounterConfidence(ev.roles.confidence);
      if (ev.roles.needs_review) { setBranch((b) => (b.roles ? b : { ...b, roles: true })); mark("orch", "failure"); }
    }
    if (ev.agent === "structuring" && ev.note && typeof ev.note !== "string") setNote(ev.note);
    if (ev.agent === "structuring" && status === "done") mark("autonomy");
    if (ev.agent === "evidence") {
      if (ev.evidence) setEvidence(ev.evidence);
      if (typeof ev.query === "string") setEvidenceQuery(ev.query);
      if (typeof ev.note === "string") setEvidenceNote(ev.note);
      else if (ev.evidence && ev.evidence.length) setEvidenceNote(null);
      if (status === "done" && ev.evidence && ev.evidence.length) mark("tooluse");
    }
    if (ev.agent === "verifier" && ev.verification) {
      setVerification(ev.verification);
      if (typeof ev.verification.alignment === "number") setEncounterConfidence(ev.verification.alignment);
      if (ev.verification.needs_caution) { setBranch((b) => (b.verifier ? b : { ...b, verifier: true })); mark("orch", "failure"); }
      if (ev.verification.source === "stub") mark("failure");
    }
    if (ev.agent === "considerations" && ev.considerations) { setConsiderations(ev.considerations); mark("autonomy"); }
    if (ev.agent === "human_gate" && status === "waiting") mark("hitl");
    if (ev.agent === "record" && (status === "done" || status === "error")) {
      setWriteResult({ encounter_id: ev.encounter_id ?? null, status: status === "done" ? "success" : "error", detail: ev.detail ?? null });
      if (status === "done") mark("demo");
    }
  }, [enqueueFocus, fireToast, mark]);

  // HITL: clinician swapped doctor↔patient and the backend re-derived everything downstream.
  const applyRolesSwap = useCallback(
    (res: { roles: SpeakerRoles; note: ClinicalNote; verification: Verification; considerations: Consideration[] }) => {
      setRoles(res.roles);
      setNote(res.note);
      setVerification(res.verification);
      setConsiderations(res.considerations);
      setStatuses((s) => ({ ...s, roles: "done" }));
      setCaptions((c) => ({
        ...c,
        roles: { summary: "Roles corrected by clinician — note re-derived", reason: "human-in-the-loop correction", done: true },
      }));
      setChips((prev) => [
        { id: chipIdRef.current++, agent: "roles", summary: "Roles corrected by clinician", reason: "note re-derived from the fix" },
        ...prev,
      ]);
      mark("hitl");
    },
    [mark],
  );

  // Backstop for missed SSE frames: fill any panel that's still empty from a /state snapshot
  // (e.g. fetched when the pipeline reaches the gate). Never overwrites live data — except the
  // transcript, which is upgraded if the snapshot carries translations the live copy missed.
  const backfill = useCallback((state: Partial<EncounterState>) => {
    if (state.transcript && state.transcript.length) {
      const snap = state.transcript;
      setTranscript((cur) => {
        const snapHasEn = snap.some((s) => !!s.text_en);
        const curHasEn = cur.some((s) => !!s.text_en);
        return cur.length === 0 || (snapHasEn && !curHasEn) ? snap : cur;
      });
    }
    if (state.roles) { const v = state.roles; setRoles((cur) => cur ?? v); }
    if (state.note) { const v = state.note; setNote((cur) => cur ?? v); }
    if (state.evidence && state.evidence.length) { const v = state.evidence; setEvidence((cur) => (cur.length ? cur : v)); }
    if (state.verification) { const v = state.verification; setVerification((cur) => cur ?? v); }
    if (state.considerations && state.considerations.length) { const v = state.considerations; setConsiderations((cur) => (cur.length ? cur : v)); }
    if (typeof state.quality_score === "number") { const v = state.quality_score; setQualityScore((cur) => cur ?? v); }
  }, []);

  const applyApproved = useCallback(() => {
    setApproved(true);
    setStatuses((s) => ({ ...s, human_gate: "done" }));
    setCaptions((c) => ({
      ...c,
      human_gate: { summary: "Approved by clinician", reason: "nothing writes to miatec until this gate", done: true },
    }));
    setChips((prev) => [
      { id: chipIdRef.current++, agent: "human_gate", summary: "Clinician approved the note", reason: "the human-in-the-loop gate" },
      ...prev,
    ]);
    mark("hitl");
  }, [mark]);

  const applyWriteResult = useCallback((wr: MiatecWriteResult | null) => {
    const ok = wr?.status === "success";
    setWriteResult(wr ?? null);
    setStatuses((s) => ({ ...s, record: ok ? "done" : "error" }));
    setCaptions((c) => ({
      ...c,
      record: {
        summary: ok ? `Encounter written to miatec · ${wr?.encounter_id ?? ""}` : "Write failed",
        reason: ok ? "idempotency-keyed write succeeded" : wr?.detail ?? undefined,
        done: ok,
      },
    }));
    enqueueFocus("record");
    if (ok) mark("demo");
  }, [enqueueFocus, mark]);

  return {
    // spotlight
    activeAgent,
    statuses,
    captions,
    // data
    transcript, roles, note, evidence, evidenceQuery, evidenceNote,
    verification, considerations, qualityScore, audio, writeResult, approved,
    // rubric + branches
    branch, toast, satisfied, chips, encounterConfidence,
    // actions
    applyEvent, reset, setNote, applyRolesSwap, applyApproved, applyWriteResult, backfill,
  };
}
