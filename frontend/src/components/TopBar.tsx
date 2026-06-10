"use client";
// The top bar: identity, the standing "running on AWS" infra anchor, audio provenance (so a judge can
// verify real AWS Transcribe vs the sample), the live SIGNAL gauge, the session, and the single
// primary action. Quiet instrumentation around a loud stage.
import type { Audio } from "@/lib/stage";
import { rampColor, pct } from "@/lib/ui";

function SignalGauge({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <span className="signal" title="mean AWS Transcribe word confidence">
        <span className="cap">signal</span>
        <span className="track"><span style={{ width: "0%" }} /></span>
      </span>
    );
  }
  const color = rampColor(score);
  return (
    <span className="signal" title="mean AWS Transcribe word confidence — the headline failure-handling signal">
      <span className="cap">signal</span>
      <span className="track"><span style={{ width: `${pct(score)}%`, background: color }} /></span>
      <span className="num" style={{ color }}>{pct(score)}%</span>
    </span>
  );
}

export function TopBar({
  audio,
  sessionId,
  qualityScore,
  started,
  onStart,
  onToggleRubric,
}: {
  audio: Audio;
  sessionId: string | null;
  qualityScore: number | null;
  started: boolean;
  onStart: () => void;
  onToggleRubric: () => void;
}) {
  const realAudio = audio.source === "s3" || audio.source === "cache";
  return (
    <header className="topbar">
      <div className="wordmark">
        <span className="live-dot" />
        miatec <span className="sub">copilot</span>
      </div>
      <span className="infra">running on AWS · ECS Fargate + CloudFront</span>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
        {audio.name && (
          <span className={`prov-pill ${realAudio ? "real" : ""}`}>
            ♪ {audio.name}
            {realAudio ? ` · AWS Transcribe${audio.vocabulary ? " + clinical vocab" : ""}` : " · sample"}
          </span>
        )}
        {(started || qualityScore != null) && <SignalGauge score={qualityScore} />}
        {sessionId && <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>session {sessionId.slice(0, 8)}</span>}
        <button className="btn btn-ghost" style={{ padding: "9px 14px", fontSize: 12 }} onClick={onToggleRubric} title="Toggle scorecard (R)">
          Scorecard
        </button>
        <button className="btn btn-primary" onClick={onStart}>
          {started ? "Restart" : "Start consultation"}
        </button>
      </div>
    </header>
  );
}
