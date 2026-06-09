"use client";

import { useEffect, useRef, useState } from "react";
import {
  API_BASE,
  approve,
  ingest,
  swapRoles,
  writeToMiatec,
  type ClinicalNote,
  type Consideration,
  type Evidence,
  type MiatecWriteResult,
  type SpeakerRoles,
  type TranscriptSegment,
  type Verification,
} from "@/lib/api";

type AgentKey =
  | "scribe"
  | "roles"
  | "structuring"
  | "evidence"
  | "verifier"
  | "considerations"
  | "human_gate"
  | "record";

type Status = "idle" | "running" | "done" | "waiting" | "retry" | "error";

type AgentEvent = {
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

type Caption = { line?: string; reason?: string; done?: boolean; degraded?: boolean };
type Activity = { id: number; time: string; agent: AgentKey; kind: Status; text: string; reason?: string };

const AGENTS: { key: AgentKey; label: string; sub: string }[] = [
  { key: "scribe", label: "Scribe", sub: "audio → diarized transcript" },
  { key: "roles", label: "Roles", sub: "doctor vs. patient" },
  { key: "structuring", label: "Structuring", sub: "transcript → SOAP" },
  { key: "evidence", label: "Evidence", sub: "Exa citations" },
  { key: "verifier", label: "Verifier", sub: "evidence ↔ note check" },
  { key: "considerations", label: "Considerations", sub: "ranked differentials" },
  { key: "human_gate", label: "Human gate", sub: "doctor approves" },
  { key: "record", label: "Record", sub: "write → miatec" },
];

// One accent per agent so the timeline + rail read as a colour-coded pipeline.
const AGENT_COLOR: Record<AgentKey, { text: string; badge: string; dot: string }> = {
  scribe: { text: "text-violet-300", badge: "border-violet-500/30 bg-violet-500/10 text-violet-200", dot: "bg-violet-400" },
  roles: { text: "text-sky-300", badge: "border-sky-500/30 bg-sky-500/10 text-sky-200", dot: "bg-sky-400" },
  structuring: { text: "text-emerald-300", badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", dot: "bg-emerald-400" },
  evidence: { text: "text-amber-300", badge: "border-amber-500/30 bg-amber-500/10 text-amber-200", dot: "bg-amber-400" },
  verifier: { text: "text-rose-300", badge: "border-rose-500/30 bg-rose-500/10 text-rose-200", dot: "bg-rose-400" },
  considerations: { text: "text-fuchsia-300", badge: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200", dot: "bg-fuchsia-400" },
  human_gate: { text: "text-blue-300", badge: "border-blue-500/30 bg-blue-500/10 text-blue-200", dot: "bg-blue-400" },
  record: { text: "text-teal-300", badge: "border-teal-500/30 bg-teal-500/10 text-teal-200", dot: "bg-teal-400" },
};

const STATUS_STYLES: Record<Status, string> = {
  idle: "border-zinc-800 bg-zinc-900/40",
  running: "border-amber-500/50 bg-amber-500/5 shadow-[0_0_0_1px] shadow-amber-500/20",
  done: "border-emerald-500/40 bg-emerald-500/5",
  waiting: "border-sky-500/50 bg-sky-500/5 shadow-[0_0_0_1px] shadow-sky-500/20",
  retry: "border-orange-500/50 bg-orange-500/5",
  error: "border-red-500/50 bg-red-500/5",
};

const INITIAL_STATUS: Record<AgentKey, Status> = {
  scribe: "idle", roles: "idle", structuring: "idle", evidence: "idle",
  verifier: "idle", considerations: "idle", human_gate: "idle", record: "idle",
};
const EMPTY_CAPTIONS: Record<AgentKey, Caption> = {
  scribe: {}, roles: {}, structuring: {}, evidence: {},
  verifier: {}, considerations: {}, human_gate: {}, record: {},
};

export default function Cockpit() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<AgentKey, Status>>(INITIAL_STATUS);
  const [captions, setCaptions] = useState<Record<AgentKey, Caption>>(EMPTY_CAPTIONS);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [roles, setRoles] = useState<SpeakerRoles | null>(null);
  const [note, setNote] = useState<ClinicalNote | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [evidenceNote, setEvidenceNote] = useState<string | null>(null);
  const [evidenceQuery, setEvidenceQuery] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [considerations, setConsiderations] = useState<Consideration[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [writeResult, setWriteResult] = useState<MiatecWriteResult | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<{ name?: string; source?: string; vocabulary?: boolean }>({});
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const actId = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest line in view as the transcript streams in (live-capture feel).
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  function pushActivity(agent: AgentKey, kind: Status, text: string, reason?: string) {
    const time = new Date().toLocaleTimeString();
    setActivity((a) => [{ id: actId.current++, time, agent, kind, text, reason }, ...a].slice(0, 60));
  }

  function applyEvent(ev: AgentEvent) {
    // Non-blocking "review" notices from a conditional gate (low-confidence roles, or the verifier's
    // caution/reconcile branch) — log to the activity feed without disturbing the agent rail.
    if ((ev.status as string) === "review") {
      pushActivity(ev.agent, "retry", ev.step ?? "flagged for review", ev.reason);
      return;
    }
    // Scribe streaming the transcript in line-by-line (live-capture effect): append the growing
    // transcript + show progress, keep the rail spinning, don't flood the activity feed.
    if ((ev.status as string) === "streaming") {
      if (ev.transcript) setTranscript(ev.transcript);
      setStatuses((s) => ({ ...s, [ev.agent]: "running" }));
      setCaptions((c) => ({ ...c, [ev.agent]: { line: ev.step ?? "Transcrevendo…", done: false } }));
      return;
    }
    setStatuses((s) => ({ ...s, [ev.agent]: ev.status }));

    // Per-agent caption: what it's doing now → its decision when done.
    setCaptions((c) => {
      const next = { ...c };
      if (ev.status === "running") next[ev.agent] = { line: ev.step ?? "working…", done: false };
      else if (ev.status === "done") next[ev.agent] = { line: ev.summary ?? "done", reason: ev.reason, done: true, degraded: ev.degraded };
      else if (ev.status === "waiting") next[ev.agent] = { line: "Awaiting your review & approval", done: false };
      else if (ev.status === "retry" || ev.status === "error")
        next[ev.agent] = { line: ev.step ?? ev.error ?? ev.status, reason: ev.reason, done: false };
      return next;
    });

    // Activity timeline entry (skip noisy running frames without a step).
    if (ev.status === "done") pushActivity(ev.agent, "done", ev.summary ?? "done", ev.reason);
    else if (ev.status === "waiting") pushActivity(ev.agent, "waiting", "Awaiting clinician review & approval");
    else if (ev.status === "retry" || ev.status === "error")
      pushActivity(ev.agent, ev.status, ev.step ?? ev.error ?? ev.status, ev.reason);
    else if (ev.step) pushActivity(ev.agent, "running", ev.step);

    if (ev.agent === "scribe") {
      if (ev.audio) setAudio((a) => ({ ...a, name: ev.audio }));
      if (ev.source) setAudio((a) => ({ ...a, source: ev.source }));
      if (typeof ev.vocabulary === "boolean") setAudio((a) => ({ ...a, vocabulary: ev.vocabulary }));
      if (typeof ev.quality_score === "number") setQualityScore(ev.quality_score);
      if (ev.transcript) setTranscript(ev.transcript);
    }
    if (ev.agent === "roles" && ev.roles) setRoles(ev.roles);
    if (ev.agent === "structuring" && ev.note && typeof ev.note !== "string") setNote(ev.note);
    if (ev.agent === "evidence") {
      if (ev.evidence) setEvidence(ev.evidence);
      if (typeof ev.query === "string") setEvidenceQuery(ev.query);
      if (typeof ev.note === "string") setEvidenceNote(ev.note);
      else if (ev.evidence && ev.evidence.length) setEvidenceNote(null);
    }
    if (ev.agent === "verifier" && ev.verification) setVerification(ev.verification);
    if (ev.agent === "considerations" && ev.considerations) setConsiderations(ev.considerations);
    if (ev.agent === "record" && (ev.status === "done" || ev.status === "error")) {
      setWriteResult({ encounter_id: ev.encounter_id ?? null, status: ev.status === "done" ? "success" : "error", detail: ev.detail ?? null });
    }
  }

  function handleConnected(id: string) {
    ingest(id)
      .then((state) => {
        // Backstop the live SSE updates so panels are populated even if a frame was missed.
        setTranscript(state.transcript);
        setRoles(state.roles ?? null);
        setNote(state.note);
        setEvidence(state.evidence);
        setVerification(state.verification ?? null);
        setConsiderations(state.considerations);
        if (typeof state.quality_score === "number") setQualityScore(state.quality_score);
      })
      .catch((e: unknown) => pushActivity("scribe", "error", `ingest error: ${String(e)}`));
  }

  function start() {
    const id = crypto.randomUUID();
    esRef.current?.close();
    setSessionId(id);
    setStatuses(INITIAL_STATUS);
    setCaptions(EMPTY_CAPTIONS);
    setActivity([]);
    setTranscript([]);
    setRoles(null);
    setNote(null);
    setEvidence([]);
    setEvidenceNote(null);
    setEvidenceQuery(null);
    setVerification(null);
    setConsiderations([]);
    setDismissed(new Set());
    setWriteResult(null);
    setApproved(false);
    setAudio({});
    setQualityScore(null);

    const es = new EventSource(`${API_BASE}/stream/${id}`);
    esRef.current = es;
    es.addEventListener("connected", () => handleConnected(id));
    es.addEventListener("agent", (e) => {
      try {
        applyEvent(JSON.parse((e as MessageEvent).data) as AgentEvent);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onerror = () => pushActivity("scribe", "error", `stream error (is the backend running on ${API_BASE}?)`);
  }

  function toggleDismiss(i: number) {
    setDismissed((d) => {
      const next = new Set(d);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function onSwapRoles() {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await swapRoles(sessionId);
      setRoles(res.roles);
      setNote(res.note);
      setVerification(res.verification);
      setConsiderations(res.considerations);
      pushActivity("roles", "done", "Roles swapped by clinician — note re-derived", "human-in-the-loop correction");
    } catch (e: unknown) {
      pushActivity("roles", "error", `roles swap error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onApproveAndWrite() {
    if (!sessionId || !note) return;
    setBusy(true);
    try {
      await approve(sessionId, note, Array.from(dismissed));
      setApproved(true);
      setStatuses((s) => ({ ...s, human_gate: "done" }));
      setCaptions((c) => ({ ...c, human_gate: { line: "Approved by clinician", done: true } }));
      pushActivity("human_gate", "done", "Clinician approved the note", "nothing writes to miatec until this gate");
      const state = await writeToMiatec(sessionId);
      const wr = state.miatec_write_result ?? null;
      setWriteResult(wr);
      // Backstop the SSE so the Record card reflects the write outcome even if its done frame is missed.
      const ok = wr?.status === "success";
      setStatuses((s) => ({ ...s, record: ok ? "done" : "error" }));
      setCaptions((c) => ({
        ...c,
        record: {
          line: ok ? `Encounter written to miatec · ${wr?.encounter_id ?? ""}` : "Write failed",
          reason: ok ? "idempotency-keyed write succeeded" : wr?.detail ?? undefined,
          done: ok,
        },
      }));
      pushActivity("record", ok ? "done" : "error",
        ok ? `Encounter written to miatec · ${wr?.encounter_id ?? ""}` : "write failed",
        ok ? "idempotency-keyed write" : wr?.detail ?? undefined);
    } catch (e: unknown) {
      pushActivity("record", "error", `approve/write error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const started = sessionId !== null;
  const latest = activity[0];
  const realAudio = audio.source === "s3" || audio.source === "cache";

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px] shadow-emerald-400/70" />
          <h1 className="text-lg font-semibold tracking-tight">
            miatec <span className="text-zinc-400">copilot</span>
          </h1>
          <span className="hidden text-xs text-zinc-500 sm:inline">clinician cockpit · agentic scribe → miatec</span>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          {audio.name && (
            <code className={`rounded px-2 py-1 ${realAudio ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-900 text-zinc-400"}`}>
              ♪ {audio.name}{realAudio ? " · real audio" : ""}
            </code>
          )}
          {sessionId && <code className="hidden rounded bg-zinc-900 px-2 py-1 sm:inline">session {sessionId.slice(0, 8)}</code>}
          <button
            onClick={start}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-400"
          >
            {started ? "Restart consultation" : "Start consultation"}
          </button>
        </div>
      </header>

      {/* Live "now happening" banner — a single focal point as the loop runs. */}
      {started && latest && (
        <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-6 py-2 text-sm">
          <span className={`h-2 w-2 shrink-0 rounded-full ${AGENT_COLOR[latest.agent].dot} ${latest.kind === "running" ? "animate-pulse" : ""}`} />
          <span className={`shrink-0 font-medium ${AGENT_COLOR[latest.agent].text}`}>{labelFor(latest.agent)}</span>
          <span className="truncate text-zinc-300">{latest.text}</span>
          {latest.reason && <span className="hidden truncate text-zinc-500 md:inline">— {latest.reason}</span>}
        </div>
      )}

      <div className="grid gap-px bg-zinc-800 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-3 bg-zinc-950 p-4">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Agent pipeline</p>
          <div className="space-y-2">
            {AGENTS.map((a, i) => {
              const st = statuses[a.key];
              const cap = captions[a.key];
              const color = AGENT_COLOR[a.key];
              return (
                <div key={a.key} className={`rounded-lg border px-3 py-2.5 transition-colors ${STATUS_STYLES[st]}`}>
                  <div className="flex items-center gap-2.5">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${color.badge}`}>
                      {i + 1}
                    </span>
                    <span className={`text-sm font-medium ${st === "idle" ? "text-zinc-400" : color.text}`}>{a.label}</span>
                    {cap.degraded && (
                      <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300" title="ran on stub / fallback data">
                        stub
                      </span>
                    )}
                    <span className="ml-auto"><StatusIcon status={st} /></span>
                  </div>
                  {cap.line ? (
                    <div className="mt-1.5 pl-[1.875rem]">
                      <p className={`text-xs leading-snug ${cap.done ? "text-zinc-200" : "text-zinc-300"}`}>
                        {!cap.done && st === "running" && <span className="mr-1 text-amber-300">▸</span>}
                        {cap.done && <span className="mr-1 text-emerald-400">✓</span>}
                        {cap.line}
                      </p>
                      {cap.reason && <p className="mt-0.5 line-clamp-2 text-[11px] italic leading-snug text-zinc-500">why: {cap.reason}</p>}
                    </div>
                  ) : (
                    <p className="mt-0.5 pl-[1.875rem] text-[11px] text-zinc-600">{a.sub}</p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pt-2">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">Activity</p>
            <div className="max-h-72 space-y-1.5 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
              {activity.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-zinc-600">— idle —</p>
              ) : (
                activity.map((ac) => (
                  <div key={ac.id} className="flex gap-2 text-[11px] leading-snug">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_COLOR[ac.agent].dot}`} />
                    <div className="min-w-0 flex-1">
                      <span className={`font-medium ${AGENT_COLOR[ac.agent].text}`}>{labelFor(ac.agent)}</span>{" "}
                      <span className={ac.kind === "error" || ac.kind === "retry" ? "text-orange-300" : "text-zinc-300"}>{ac.text}</span>
                      {ac.reason && <span className="block text-zinc-500">{ac.reason}</span>}
                    </div>
                    <span className="shrink-0 text-zinc-600">{ac.time.slice(0, 8)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <main className="space-y-6 bg-zinc-950 p-6">
          {!started && (
            <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-zinc-500">
              Press <span className="text-zinc-300">Start consultation</span> to run the agent loop on the recorded pt-BR encounter.
              <br />
              Backend must be running:{" "}
              <code className="text-zinc-400">uvicorn app.main:app --reload --port 8000</code>
            </div>
          )}

          {started && (
            <>
              {roles && (
                <section
                  className={`rounded-xl border p-4 ${roles.needs_review ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/40"}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-sm font-semibold text-zinc-300">Speaker roles</h2>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${roles.needs_review ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}
                    >
                      {Math.round(roles.confidence * 100)}% confidence
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">via {roles.source}</span>
                    {roles.needs_review && (
                      <span className="text-[11px] text-amber-300">⚠ low confidence — please confirm</span>
                    )}
                    <button
                      onClick={onSwapRoles}
                      disabled={busy}
                      className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Swap doctor ↔ patient
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {Object.entries(roles.mapping).map(([label, role]) => (
                      <span key={label} className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">
                        {label} → <span className={role === "doctor" ? "text-sky-400" : "text-zinc-100"}>{role}</span>
                      </span>
                    ))}
                  </div>
                  {roles.rationale && <p className="mt-2 text-xs text-zinc-500"><span className="text-zinc-600">why:</span> {roles.rationale}</p>}
                </section>
              )}

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-300">Transcript</h2>
                  {audio.name && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${realAudio ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                      {realAudio ? `${audio.name} · AWS Transcribe${audio.vocabulary ? " + clinical vocab" : ""}` : "sample transcript"}
                    </span>
                  )}
                  {transcript.length > 0 && <span className="text-[11px] text-zinc-500">{transcript.length} turns</span>}
                  {qualityScore != null && <span className="ml-auto"><QualityGauge score={qualityScore} /></span>}
                </div>
                <div ref={transcriptRef} className="max-h-96 divide-y divide-zinc-800 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {transcript.length === 0 && <p className="p-4 text-sm text-zinc-600">listening…</p>}
                  {transcript.map((seg, i) => {
                    const low = seg.confidence < 0.7;
                    return (
                      <div key={i} className="flex gap-3 p-3 text-sm">
                        <span className={`shrink-0 font-medium ${seg.speaker === "doctor" ? "text-sky-400" : seg.speaker === "patient" ? "text-zinc-200" : "text-zinc-500"}`}>
                          {seg.speaker}
                        </span>
                        <span className="flex-1 text-zinc-200">{seg.text}</span>
                        <span
                          className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] ${low ? "bg-red-500/15 text-red-300" : "bg-zinc-800 text-zinc-500"}`}
                        >
                          {(seg.confidence * 100).toFixed(0)}%{low ? " ⚠" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              {note && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-zinc-300">
                    Clinical note (SOAP) · <span className="text-zinc-500">editable</span>
                  </h2>
                  <div className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:grid-cols-2">
                    <Field label="Chief complaint" value={note.chief_complaint} onChange={(v) => setNote({ ...note, chief_complaint: v })} />
                    <Field label="HPI" value={note.hpi} onChange={(v) => setNote({ ...note, hpi: v })} />
                    <ReadOnly label="Medications" value={note.current_medications.join(", ") || "—"} />
                    <ReadOnly label="Allergies" value={note.allergies.join(", ") || "—"} />
                    <Field label="Assessment" value={note.assessment} onChange={(v) => setNote({ ...note, assessment: v })} />
                    <Field label="Plan" value={note.plan} onChange={(v) => setNote({ ...note, plan: v })} />
                  </div>
                  {note.low_confidence_segments.length > 0 && (
                    <p className="mt-2 text-xs text-red-300">
                      ⚠ {note.low_confidence_segments.length} low-confidence segment(s) flagged for review (failure handling).
                    </p>
                  )}
                </section>
              )}

              {verification && (
                <section
                  className={`rounded-xl border p-4 ${verification.needs_caution ? "border-rose-500/40 bg-rose-500/5" : "border-zinc-800 bg-zinc-900/40"}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-sm font-semibold text-zinc-300">
                      Verifier <span className="text-zinc-500">· evidence ↔ note</span>
                    </h2>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${verification.alignment >= 0.7 ? "bg-emerald-500/15 text-emerald-300" : verification.alignment >= 0.5 ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/15 text-rose-300"}`}
                    >
                      {Math.round(verification.alignment * 100)}% aligned
                    </span>
                    {verification.needs_caution && (
                      <span className="text-[11px] text-rose-300">⚠ weak support — considerations hedged</span>
                    )}
                    {verification.source === "stub" && (
                      <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] uppercase text-amber-300">stub</span>
                    )}
                  </div>
                  {verification.summary && <p className="mt-2 text-xs text-zinc-400">{verification.summary}</p>}
                  {verification.verdicts.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                      {verification.verdicts.map((v, i) => (
                        <span
                          key={i}
                          title={v.note}
                          className={`rounded px-1.5 py-0.5 ${v.stance === "supports" ? "bg-emerald-500/15 text-emerald-300" : v.stance === "contradicts" ? "bg-rose-500/15 text-rose-300" : "bg-zinc-800 text-zinc-400"}`}
                        >
                          [{v.index}] {v.stance === "supports" ? "✓" : v.stance === "contradicts" ? "✗" : "•"} {v.stance}
                        </span>
                      ))}
                    </div>
                  )}
                  {verification.concerns.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {verification.concerns.map((c, i) => (
                        <li key={i} className="text-[11px] text-rose-300/90">⚠ {c}</li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              <div className="grid gap-6 lg:grid-cols-2">
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-zinc-300">
                    Evidence <span className="text-zinc-500">· Exa</span>
                  </h2>
                  {evidenceQuery && (
                    <p className="mb-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400">
                      <span className="text-zinc-600">searched:</span> {evidenceQuery}
                    </p>
                  )}
                  <div className="space-y-2">
                    {evidenceNote && (
                      <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-amber-300">{evidenceNote}</p>
                    )}
                    {evidence.map((e, i) => (
                      <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
                        <p className="text-zinc-200">{e.claim}</p>
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-block text-xs text-sky-400 hover:underline"
                        >
                          [{i}] {e.source}
                        </a>
                      </div>
                    ))}
                    {evidence.length === 0 && !evidenceNote && <p className="text-sm text-zinc-600">grounding…</p>}
                  </div>
                </section>

                <section>
                  <h2 className="mb-2 text-sm font-semibold text-zinc-300">
                    Considerations <span className="text-zinc-500">· decision support</span>
                  </h2>
                  <div className="space-y-2">
                    {considerations.map((c, i) => {
                      const isDismissed = dismissed.has(i);
                      return (
                        <div
                          key={i}
                          className={`rounded-lg border p-3 text-sm ${isDismissed ? "border-zinc-800 bg-zinc-900/20 opacity-50" : "border-zinc-800 bg-zinc-900/40"}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`font-medium ${isDismissed ? "text-zinc-500 line-through" : "text-zinc-100"}`}>{c.label}</span>
                            <button onClick={() => toggleDismiss(i)} className="text-[11px] text-zinc-500 hover:text-red-300">
                              {isDismissed ? "restore" : "dismiss"}
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-zinc-400"><span className="text-zinc-600">why:</span> {c.rationale}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-zinc-800">
                              <div className="h-1.5 rounded-full bg-sky-500" style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-zinc-500">{Math.round(c.confidence * 100)}%</span>
                            {c.evidence_refs.length > 0 && <span className="text-[10px] text-zinc-500">ev {c.evidence_refs.join(",")}</span>}
                          </div>
                        </div>
                      );
                    })}
                    {considerations.length === 0 && <p className="text-sm text-zinc-600">reasoning…</p>}
                  </div>
                </section>
              </div>

              <section className="flex flex-wrap items-center gap-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm font-semibold text-sky-200">Human-in-the-loop gate</p>
                  <p className="text-xs text-zinc-400">
                    Review and edit the note, dismiss considerations, then approve. Nothing writes to miatec until you do.
                  </p>
                </div>
                <button
                  onClick={onApproveAndWrite}
                  disabled={busy || !note || approved}
                  className="rounded-md bg-sky-500 px-5 py-2.5 text-sm font-semibold text-sky-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {approved ? "Approved ✓" : busy ? "Writing…" : "Approve & Write to miatec"}
                </button>
              </section>

              {writeResult && (
                <section
                  className={`rounded-xl border p-4 ${writeResult.status === "success" ? "border-emerald-500/40 bg-emerald-500/5" : "border-red-500/40 bg-red-500/5"}`}
                >
                  <p className="text-sm font-semibold text-zinc-200">
                    miatec write:{" "}
                    <span className={writeResult.status === "success" ? "text-emerald-300" : "text-red-300"}>{writeResult.status}</span>
                  </p>
                  {writeResult.encounter_id && (
                    <p className="mt-1 text-xs text-zinc-400">
                      encounter_id: <code className="text-emerald-300">{writeResult.encounter_id}</code>
                    </p>
                  )}
                  {writeResult.detail && <p className="mt-1 text-xs text-zinc-500">{writeResult.detail}</p>}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function labelFor(agent: AgentKey): string {
  return AGENTS.find((a) => a.key === agent)?.label ?? agent;
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "running")
    return <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-300" />;
  if (status === "done") return <span className="text-xs text-emerald-400">✓</span>;
  if (status === "waiting") return <span className="text-xs text-sky-300">⏸</span>;
  if (status === "retry") return <span className="text-xs text-orange-300">↻</span>;
  if (status === "error") return <span className="text-xs text-red-400">✕</span>;
  return <span className="block h-2 w-2 rounded-full bg-zinc-700" />;
}

function QualityGauge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const bar = score >= 0.85 ? "bg-emerald-400" : score >= 0.7 ? "bg-amber-400" : "bg-red-400";
  const text = score >= 0.85 ? "text-emerald-300" : score >= 0.7 ? "text-amber-300" : "text-red-300";
  return (
    <span
      className="flex items-center gap-1.5"
      title="mean AWS Transcribe word confidence — the demo's headline failure-handling signal"
    >
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">signal</span>
      <span className="block h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
        <span className={`block h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`text-[10px] font-medium ${text}`}>{pct}%</span>
    </span>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="mt-1 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
      />
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      <p className="mt-1 rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-sm text-zinc-300">{value}</p>
    </div>
  );
}
