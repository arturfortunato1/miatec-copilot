"use client";
// "Control Room" — the whole agent system on one screen. A live LangGraph across the top, every
// agent's artifact in a persistent panel below. Nothing hides; the FOCUS (a highlight) travels as
// control flows through the graph. The page owns the SSE connection + the HITL actions and feeds
// every frame through useStageDirector.
import { useCallback, useEffect, useRef, useState } from "react";

import { FlowGraph } from "@/components/FlowGraph";
import { Panel } from "@/components/Panel";
import { RubricStrip } from "@/components/RubricStrip";
import { ScorecardOverlay } from "@/components/ScorecardOverlay";
import { TopBar } from "@/components/TopBar";
import {
  ConsiderationsBody,
  EvidenceBody,
  RecordGateBody,
  SoapBody,
  TranscriptBody,
  VerifierBody,
} from "@/components/workSurfaces";
import { API_BASE, approve, ingest, swapRoles, writeToMiatec, type ClinicalNote } from "@/lib/api";
import { AGENT_META } from "@/lib/agents";
import { useStageDirector } from "@/lib/stage";
import type { AgentEvent, Status } from "@/lib/stageTypes";

const DEFAULT_ACCENT = "#A78BFA";

export default function ControlRoom() {
  const dir = useStageDirector();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [rubricOpen, setRubricOpen] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const started = sessionId !== null;
  const active = dir.activeAgent;
  const accent = active ? AGENT_META[active].accent : DEFAULT_ACCENT;

  useEffect(() => {
    document.documentElement.style.setProperty("--stage-accent", accent);
  }, [accent]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      if (e.key === "r" || e.key === "R") setRubricOpen((o) => !o);
      if (e.key === "Escape") setRubricOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  // Backstop for missed SSE frames: when the pipeline reaches the gate, reconcile against the
  // checkpointed /state snapshot so every panel (incl. the translated transcript) is populated.
  const gateWaiting = dir.statuses.human_gate === "waiting";
  const { backfill } = dir;
  useEffect(() => {
    if (!gateWaiting || !sessionId) return;
    fetch(`${API_BASE}/state/${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && backfill(s))
      .catch(() => {});
  }, [gateWaiting, sessionId, backfill]);

  const handleConnected = useCallback((id: string) => {
    ingest(id).catch((e: unknown) =>
      dir.applyEvent({ agent: "scribe", status: "error", step: "could not start the pipeline", error: String(e) } as AgentEvent),
    );
  }, [dir]);

  const start = useCallback(() => {
    const id = crypto.randomUUID();
    esRef.current?.close();
    dir.reset();
    setSessionId(id);
    setBusy(false);
    setDismissed(new Set());

    const es = new EventSource(`${API_BASE}/stream/${id}`);
    esRef.current = es;
    es.addEventListener("connected", () => handleConnected(id));
    es.addEventListener("agent", (e) => {
      try {
        dir.applyEvent(JSON.parse((e as MessageEvent).data) as AgentEvent);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED)
        dir.applyEvent({ agent: "scribe", status: "error", step: `stream closed — is the backend on ${API_BASE}?` } as AgentEvent);
    };
  }, [dir, handleConnected]);

  const toggleDismiss = useCallback((i: number) => {
    setDismissed((d) => {
      const next = new Set(d);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const onSwapRoles = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await swapRoles(sessionId);
      dir.applyRolesSwap(res);
    } catch (e: unknown) {
      dir.applyEvent({ agent: "roles", status: "error", step: `roles swap failed: ${String(e)}` } as AgentEvent);
    } finally {
      setBusy(false);
    }
  }, [dir, sessionId]);

  const onApproveAndWrite = useCallback(async () => {
    if (!sessionId || !dir.note) return;
    setBusy(true);
    try {
      await approve(sessionId, dir.note, Array.from(dismissed));
      const state = await writeToMiatec(sessionId);
      // Mark approved only once the write lands — a transient write failure leaves the button
      // enabled so the clinician can simply retry (the backend write is idempotency-keyed).
      dir.applyApproved();
      dir.applyWriteResult(state.miatec_write_result ?? null);
    } catch (e: unknown) {
      dir.applyEvent({ agent: "record", status: "error", step: "approve / write failed", detail: String(e) } as AgentEvent);
    } finally {
      setBusy(false);
    }
  }, [dir, dismissed, sessionId]);

  const setNote = useCallback((n: ClinicalNote) => dir.setNote(n), [dir]);

  const s = dir.statuses;
  const topConsideration = dir.considerations.length ? Math.max(...dir.considerations.map((c) => c.confidence)) : null;
  const gateOpen = s.human_gate === "waiting" && !dir.approved && !dir.writeResult;
  const recordStatus: Status = s.record !== "idle" ? s.record : s.human_gate;
  // The capture panel hosts three pipeline stages: latest non-idle one drives its status dot.
  const transcriptStatus: Status =
    s.roles !== "idle" ? s.roles : s.translate !== "idle" ? s.translate : s.scribe;
  const transcriptAccent =
    active === "roles" ? AGENT_META.roles.accent
    : active === "translate" ? AGENT_META.translate.accent
    : AGENT_META.scribe.accent;
  // Only offer the recording when Scribe ran on real S3/cached audio (not the stub path).
  const realAudio = dir.audio.source === "s3" || dir.audio.source === "cache";
  const audioUrl = realAudio && sessionId ? `${API_BASE}/audio/${sessionId}` : null;

  return (
    <div className="cr-shell">
      <TopBar
        audio={dir.audio}
        sessionId={sessionId}
        qualityScore={dir.qualityScore}
        started={started}
        onStart={start}
        onToggleRubric={() => setRubricOpen((o) => !o)}
      />

      {!started && (
        <div className="cold-open">
          <span className="kicker">Agentic clinical scribe · live system view</span>
          <h1>Eight agents. One consultation. Watch the whole graph think.</h1>
          <p>
            Transcribe · translate to clinical English · attribute speakers · structure the note · ground it
            in real evidence · verify · rank differentials · pause for the doctor · write into miatec.
            Everything stays on screen — the highlight follows whichever agent the LangGraph is running.
            Decision support; the clinician owns every write.
          </p>
          <button className="btn btn-primary" style={{ fontSize: 15, padding: "13px 24px" }} onClick={start}>
            Start consultation
          </button>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>press R for the detailed scorecard</span>
        </div>
      )}

      {started && (
        <>
          <FlowGraph statuses={s} activeAgent={active} captions={dir.captions} branch={dir.branch} />

          <div className="panels">
            <Panel
              area="transcript" num="01–03" title="Transcript" sub="Scribe · Translate · Roles"
              accent={transcriptAccent}
              status={transcriptStatus}
              active={active === "scribe" || active === "translate" || active === "roles"}
              hasData={dir.transcript.length > 0} dims={["tooluse"]} sponsor="AWS Transcribe"
              degraded={dir.captions.scribe.degraded}
              metric={dir.qualityScore != null ? { label: "signal", value: dir.qualityScore } : null}
              flush
            >
              <TranscriptBody transcript={dir.transcript} roles={dir.roles} onSwap={onSwapRoles} busy={busy} audioUrl={audioUrl} audioName={dir.audio.name ?? null} />
            </Panel>

            <Panel
              area="soap" num="04" title="Clinical note" sub="Structuring · SOAP"
              accent={AGENT_META.structuring.accent}
              status={s.structuring} active={active === "structuring"}
              hasData={!!dir.note} dims={["autonomy"]} sponsor="Claude · AI Gateway"
              degraded={dir.captions.structuring.degraded}
            >
              <SoapBody note={dir.note} editable={gateOpen} onChange={setNote} />
            </Panel>

            <Panel
              area="evidence" num="05" title="Evidence" sub="Exa"
              accent={AGENT_META.evidence.accent}
              status={s.evidence} active={active === "evidence"}
              hasData={dir.evidence.length > 0 || !!dir.evidenceNote} dims={["tooluse"]} sponsor="Exa"
              degraded={dir.captions.evidence.degraded}
            >
              <EvidenceBody evidence={dir.evidence} query={dir.evidenceQuery} note={dir.evidenceNote} />
            </Panel>

            <Panel
              area="verifier" num="06" title="Verifier" sub="evidence ↔ note"
              accent={AGENT_META.verifier.accent}
              status={s.verifier} active={active === "verifier"}
              hasData={!!dir.verification} dims={["autonomy", "failure"]} sponsor="Claude · AI Gateway"
              degraded={dir.verification?.source === "stub" || dir.captions.verifier.degraded}
              metric={dir.verification ? { label: "align", value: dir.verification.alignment } : null}
            >
              <VerifierBody verification={dir.verification} />
            </Panel>

            <Panel
              area="record" num="08·09" title="Gate → Record" sub="HITL · miatec"
              accent={active === "human_gate" ? AGENT_META.human_gate.accent : AGENT_META.record.accent}
              status={recordStatus} active={active === "human_gate" || active === "record"}
              hasData={!!dir.writeResult || s.human_gate !== "idle"} dims={["hitl"]} sponsor="miatec"
              flush
            >
              <RecordGateBody
                waiting={gateOpen}
                busy={busy}
                approved={dir.approved}
                canApprove={!!dir.note}
                onApprove={onApproveAndWrite}
                result={dir.writeResult}
              />
            </Panel>

            <Panel
              area="considerations" num="07" title="Considerations" sub="ranked differentials"
              accent={AGENT_META.considerations.accent}
              status={s.considerations} active={active === "considerations"}
              hasData={dir.considerations.length > 0} dims={["autonomy"]} sponsor="Claude · AI Gateway"
              degraded={dir.captions.considerations.degraded}
              metric={topConsideration != null ? { label: "top", value: topConsideration } : null}
            >
              <ConsiderationsBody considerations={dir.considerations} dismissed={dismissed} onToggle={toggleDismiss} />
            </Panel>
          </div>

          <RubricStrip satisfied={dir.satisfied} onOpen={() => setRubricOpen(true)} />
        </>
      )}

      {dir.toast && (
        <div className="branch-toast">
          <span className="arr">⤳</span>
          {dir.toast.text}
        </div>
      )}

      <ScorecardOverlay open={rubricOpen} satisfied={dir.satisfied} onClose={() => setRubricOpen(false)} />
    </div>
  );
}
