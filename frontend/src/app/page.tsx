"use client";

import { useRef, useState } from "react";
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
} from "@/lib/api";

type AgentKey =
  | "scribe"
  | "roles"
  | "structuring"
  | "evidence"
  | "considerations"
  | "human_gate"
  | "record";

type Status = "idle" | "running" | "done" | "waiting" | "retry" | "error";

type AgentEvent = {
  agent: AgentKey;
  status: Status;
  transcript?: TranscriptSegment[];
  roles?: SpeakerRoles;
  note?: ClinicalNote | string;
  evidence?: Evidence[];
  considerations?: Consideration[];
  encounter_id?: string | null;
  detail?: string | null;
};

const AGENTS: { key: AgentKey; label: string; sub: string }[] = [
  { key: "scribe", label: "Scribe", sub: "audio → transcript" },
  { key: "roles", label: "Roles", sub: "doctor vs patient" },
  { key: "structuring", label: "Structuring", sub: "transcript → SOAP" },
  { key: "evidence", label: "Evidence", sub: "Exa citations" },
  { key: "considerations", label: "Considerations", sub: "ranked differentials" },
  { key: "human_gate", label: "Human gate", sub: "doctor approves" },
  { key: "record", label: "Record", sub: "write → miatec" },
];

const STATUS_STYLES: Record<Status, string> = {
  idle: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
  running: "border-amber-500/40 bg-amber-500/10 text-amber-300 animate-pulse",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  waiting: "border-sky-500/40 bg-sky-500/10 text-sky-300 animate-pulse",
  retry: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  error: "border-red-500/40 bg-red-500/10 text-red-300",
};

const INITIAL_STATUS: Record<AgentKey, Status> = {
  scribe: "idle",
  roles: "idle",
  structuring: "idle",
  evidence: "idle",
  considerations: "idle",
  human_gate: "idle",
  record: "idle",
};

export default function Cockpit() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<AgentKey, Status>>(INITIAL_STATUS);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [roles, setRoles] = useState<SpeakerRoles | null>(null);
  const [note, setNote] = useState<ClinicalNote | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [evidenceNote, setEvidenceNote] = useState<string | null>(null);
  const [considerations, setConsiderations] = useState<Consideration[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [writeResult, setWriteResult] = useState<MiatecWriteResult | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);

  function pushLog(line: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));
  }

  function applyEvent(ev: AgentEvent) {
    setStatuses((s) => ({ ...s, [ev.agent]: ev.status }));
    pushLog(`${ev.agent} → ${ev.status}`);

    if (ev.agent === "scribe" && ev.transcript) setTranscript(ev.transcript);
    if (ev.agent === "roles" && ev.roles) setRoles(ev.roles);
    if (ev.agent === "structuring" && ev.note && typeof ev.note !== "string") setNote(ev.note);
    if (ev.agent === "evidence") {
      if (ev.evidence) setEvidence(ev.evidence);
      if (typeof ev.note === "string") setEvidenceNote(ev.note);
    }
    if (ev.agent === "considerations" && ev.considerations) setConsiderations(ev.considerations);
    if (ev.agent === "record" && (ev.status === "done" || ev.status === "error")) {
      setWriteResult({ encounter_id: ev.encounter_id ?? null, status: ev.status, detail: ev.detail ?? null });
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
        setConsiderations(state.considerations);
      })
      .catch((e: unknown) => pushLog(`ingest error: ${String(e)}`));
  }

  function start() {
    const id = crypto.randomUUID();
    esRef.current?.close();
    setSessionId(id);
    setStatuses(INITIAL_STATUS);
    setTranscript([]);
    setRoles(null);
    setNote(null);
    setEvidence([]);
    setEvidenceNote(null);
    setConsiderations([]);
    setDismissed(new Set());
    setWriteResult(null);
    setApproved(false);
    setLog([]);

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
    es.onerror = () => pushLog(`stream error (is the backend running on ${API_BASE}?)`);
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
      setConsiderations(res.considerations);
      pushLog("roles swapped → note re-derived");
    } catch (e: unknown) {
      pushLog(`roles swap error: ${String(e)}`);
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
      const state = await writeToMiatec(sessionId);
      setWriteResult(state.miatec_write_result ?? null);
    } catch (e: unknown) {
      pushLog(`approve/write error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const started = sessionId !== null;

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
          {sessionId && <code className="rounded bg-zinc-900 px-2 py-1">session {sessionId.slice(0, 8)}</code>}
          <code className="hidden rounded bg-zinc-900 px-2 py-1 sm:inline">{API_BASE}</code>
          <button
            onClick={start}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-400"
          >
            {started ? "Restart consultation" : "Start consultation"}
          </button>
        </div>
      </header>

      <div className="grid gap-px bg-zinc-800 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-2 bg-zinc-950 p-4">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-zinc-500">Agent pipeline</p>
          {AGENTS.map((a) => (
            <div key={a.key} className={`rounded-lg border px-3 py-2 ${STATUS_STYLES[statuses[a.key]]}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{a.label}</span>
                <span className="text-[10px] uppercase tracking-wide">{statuses[a.key]}</span>
              </div>
              <p className="text-[11px] opacity-70">{a.sub}</p>
            </div>
          ))}
          <div className="pt-4">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">Trace</p>
            <div className="h-40 space-y-0.5 overflow-auto rounded-lg bg-zinc-900 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
              {log.length === 0 ? (
                <p className="text-zinc-600">— idle —</p>
              ) : (
                log.map((l, i) => <div key={i}>{l}</div>)
              )}
            </div>
          </div>
        </aside>

        <main className="space-y-6 bg-zinc-950 p-6">
          {!started && (
            <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-zinc-500">
              Press <span className="text-zinc-300">Start consultation</span> to run the agent loop on a sample pt-BR encounter.
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
                  {roles.rationale && <p className="mt-2 text-xs text-zinc-500">{roles.rationale}</p>}
                </section>
              )}

              <section>
                <h2 className="mb-2 text-sm font-semibold text-zinc-300">Transcript</h2>
                <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {transcript.length === 0 && <p className="p-4 text-sm text-zinc-600">listening…</p>}
                  {transcript.map((seg, i) => {
                    const low = seg.confidence < 0.7;
                    return (
                      <div key={i} className="flex gap-3 p-3 text-sm">
                        <span className={`shrink-0 font-medium ${seg.speaker === "doctor" ? "text-sky-400" : "text-zinc-300"}`}>
                          {seg.speaker}
                        </span>
                        <span className="flex-1 text-zinc-200">{seg.text}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${low ? "bg-red-500/15 text-red-300" : "bg-zinc-800 text-zinc-500"}`}
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

              <div className="grid gap-6 lg:grid-cols-2">
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-zinc-300">
                    Evidence <span className="text-zinc-500">· Exa</span>
                  </h2>
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
                          <p className="mt-1 text-xs text-zinc-400">{c.rationale}</p>
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
