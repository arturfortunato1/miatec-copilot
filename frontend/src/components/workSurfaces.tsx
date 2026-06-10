"use client";
// Panel *body* components — the content that lives inside each always-on panel. The Panel wrapper
// supplies the header/status/tags; these render only the artifact each agent produced.
import { useEffect, useRef, useState } from "react";

import { AudioPlayer } from "@/components/AudioPlayer";
import type {
  ClinicalNote,
  Consideration,
  Evidence,
  MiatecWriteResult,
  SpeakerRoles,
  TranscriptSegment,
  Verification,
} from "@/lib/api";
import { rampColor, pct } from "@/lib/ui";

function roleData(speaker: string): "doctor" | "patient" | "other" {
  if (speaker === "doctor") return "doctor";
  if (speaker === "patient") return "patient";
  return "other";
}

/* ── Transcript + roles (the capture stage) ───────────────────────────────── */
// The transcript streams in pt-BR (as captured). When the Translate agent finishes, a "rewriting"
// wave cascades down the well: each line's Portuguese blurs away while its clinical English
// materializes under a cyan sweep — the back-end normalization, made visible. The EN ⇄ PT toggle
// keeps the original one click away.
const WAVE_STAGGER_MS = 45;
const WAVE_TAIL_MS = 1100;

export function TranscriptBody({
  transcript,
  roles,
  onSwap,
  busy,
  audioUrl,
  audioName,
}: {
  transcript: TranscriptSegment[];
  roles: SpeakerRoles | null;
  onSwap: () => void;
  busy: boolean;
  audioUrl: string | null;
  audioName: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [wave, setWave] = useState(false);
  const hadTranslationRef = useRef(false);
  const waveRef = useRef(false);

  const hasTranslation = transcript.some((s) => !!s.text_en);

  // Rising edge of "the transcript is now translated" → play the rewrite wave from the top.
  // Declared BEFORE the autoscroll effect so waveRef is set when that effect runs on the same commit.
  useEffect(() => {
    if (hasTranslation && !hadTranslationRef.current) {
      hadTranslationRef.current = true;
      waveRef.current = true;
      setWave(true);
      if (ref.current) ref.current.scrollTop = 0; // watch the rewrite cascade from the first line
      const total = transcript.length * WAVE_STAGGER_MS + WAVE_TAIL_MS;
      const t = window.setTimeout(() => {
        waveRef.current = false;
        setWave(false);
      }, total);
      return () => clearTimeout(t);
    }
    if (!hasTranslation) hadTranslationRef.current = false; // session restarted
  }, [hasTranslation, transcript.length]);

  // Keep the newest line in view while streaming — but never fight the wave's scroll-to-top.
  useEffect(() => {
    if (waveRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Toggling language mid-wave would swap the animated spans for static ones mid-flight (and the
  // wave never replays) — so any toggle simply ends the wave and shows plain text. Deterministic.
  const endWave = () => {
    if (waveRef.current) {
      waveRef.current = false;
      setWave(false);
    }
  };

  const resolve = (speaker: string) => roles?.mapping?.[speaker] ?? speaker;
  const doctor = roles ? Object.entries(roles.mapping).find(([, r]) => r === "doctor")?.[0] : null;
  const patient = roles ? Object.entries(roles.mapping).find(([, r]) => r === "patient")?.[0] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {audioUrl && <AudioPlayer src={audioUrl} name={audioName} />}
      {hasTranslation && (
        <div className="translate-note">
          <b>Translate</b> is a real agent in the pipeline — shown so you can follow this Portuguese
          recording. In a same-language clinic it&rsquo;s a pass-through, not needed day-to-day.
        </div>
      )}
      {(roles || hasTranslation) && (
        <div className="roles-bar">
          {roles && (
            <>
              <span className="rb-map">
                {doctor ?? "?"} → <b>doctor</b> · {patient ?? "?"} → patient
              </span>
              <span className="rb-conf" style={{ color: rampColor(roles.confidence) }}>{pct(roles.confidence)}%</span>
              <span style={{ color: "var(--text-3)", fontSize: 10, fontFamily: "var(--font-mono)" }}>via {roles.source}</span>
              {roles.needs_review && <span style={{ color: "var(--st-review)", fontSize: 11 }}>⚠ confirm</span>}
            </>
          )}
          {hasTranslation && (
            <span className="lang-toggle" title="The Translate agent normalized the consultation to English; the original capture is preserved">
              <button className={!showOriginal ? "on" : ""} onClick={() => { endWave(); setShowOriginal(false); }}>EN</button>
              <button className={showOriginal ? "on" : ""} onClick={() => { endWave(); setShowOriginal(true); }}>PT-BR original</button>
            </span>
          )}
          {roles && (
            <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={onSwap} disabled={busy}>
              swap ↔
            </button>
          )}
        </div>
      )}
      <div ref={ref} className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 14px 12px" }}>
        {transcript.length === 0 && <p className="panel-empty">listening…</p>}
        {transcript.map((seg, i) => {
          const low = seg.confidence < 0.7;
          const who = resolve(seg.speaker);
          const showEn = !!seg.text_en && !showOriginal;
          return (
            <div key={i} className={`turn ${low ? "low" : ""}`}>
              <span className="who" data-role={roleData(who)}>{who}</span>
              {showEn && wave ? (
                <span className="txt rw" style={{ ["--d" as string]: `${i * WAVE_STAGGER_MS}ms` }}>
                  <span className="t-en">{seg.text_en}</span>
                  <span className="t-pt" aria-hidden>{seg.text}</span>
                  <span className="t-sweep" aria-hidden />
                </span>
              ) : (
                <span className="txt">{showEn ? seg.text_en : seg.text}</span>
              )}
              <span className="conf">{pct(seg.confidence)}%{low ? " ⚠" : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── SOAP (dark, structured) ──────────────────────────────────────────────── */
function SoapField({
  label,
  value,
  span,
  editable,
  onChange,
}: {
  label: string;
  value: string;
  span?: boolean;
  editable?: boolean;
  onChange?: (v: string) => void;
}) {
  return (
    <div className={`soap-field ${span ? "span-2" : ""}`}>
      <span className="soap-label">{label}</span>
      {editable ? (
        <textarea rows={span ? 2 : 1} value={value} onChange={(e) => onChange?.(e.target.value)} />
      ) : (
        <span className={`soap-value ${value === "not documented" ? "muted" : ""}`}>{value}</span>
      )}
    </div>
  );
}

export function SoapBody({
  note,
  editable,
  onChange,
}: {
  note: ClinicalNote | null;
  editable: boolean;
  onChange: (n: ClinicalNote) => void;
}) {
  if (!note) return <p className="panel-empty">awaiting the structured note…</p>;
  const meds = note.current_medications.join(", ") || "not documented";
  const allergies = note.allergies.join(", ") || "not documented";
  const ros = note.review_of_systems.join("; ") || "not documented";
  const v = note.vitals;
  const vitals =
    [v.bp && `BP ${v.bp}`, v.hr && `HR ${v.hr}`, v.temp && `Temp ${v.temp}`].filter(Boolean).join(" · ") ||
    "not documented";

  return (
    <>
      <div className="soap-grid">
        <SoapField label="Chief complaint" value={note.chief_complaint} span editable={editable} onChange={(val) => onChange({ ...note, chief_complaint: val })} />
        <SoapField label="History of present illness" value={note.hpi} span editable={editable} onChange={(val) => onChange({ ...note, hpi: val })} />
        <SoapField label="Medications" value={meds} />
        <SoapField label="Allergies" value={allergies} />
        <SoapField label="Review of systems" value={ros} />
        <SoapField label="Vitals" value={vitals} />
        <SoapField label="Assessment" value={note.assessment} span editable={editable} onChange={(val) => onChange({ ...note, assessment: val })} />
        <SoapField label="Plan" value={note.plan} span editable={editable} onChange={(val) => onChange({ ...note, plan: val })} />
      </div>
      {note.low_confidence_segments.length > 0 && (
        <p className="soap-flag">⚠ {note.low_confidence_segments.length} low-confidence segment(s) masked before structuring — failure handling.</p>
      )}
    </>
  );
}

/* ── Evidence (Exa) ───────────────────────────────────────────────────────── */
export function EvidenceBody({
  evidence,
  query,
  note,
}: {
  evidence: Evidence[];
  query: string | null;
  note: string | null;
}) {
  if (evidence.length === 0 && !note) return <p className="panel-empty">grounding…</p>;
  return (
    <>
      {query && (
        <p className="ev-query"><span className="k">searched: </span>{query}</p>
      )}
      {note && <p className="evidence-card" style={{ color: "var(--st-retry)" }}>{note}</p>}
      {evidence.map((e, i) => (
        <div key={i} className="evidence-card" style={{ animationDelay: `${i * 60}ms` }}>
          <p className="claim">{e.claim}</p>
          <a href={e.url} target="_blank" rel="noopener noreferrer">
            <span className="idx">[{i}]</span> {e.source} ↗
          </a>
          {e.tier === "authoritative" && (
            <span
              title="Found in the authoritative-first Exa pass (clinical guideline / literature domains)"
              style={{
                marginLeft: 8, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase",
                color: "#FBBF24", border: "1px solid currentColor", borderRadius: 3,
                padding: "1px 5px", opacity: 0.9, whiteSpace: "nowrap",
              }}
            >
              authoritative
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/* ── Verifier (evidence ↔ note) ───────────────────────────────────────────── */
export function VerifierBody({ verification }: { verification: Verification | null }) {
  if (!verification) return <p className="panel-empty">cross-checking the evidence…</p>;
  return (
    <>
      {verification.summary && (
        <p style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 10 }}>{verification.summary}</p>
      )}
      {verification.verdicts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {verification.verdicts.map((vd, i) => (
            <span key={i} className="verdict" data-stance={vd.stance} title={vd.note}>
              [{vd.index}] {vd.stance === "supports" ? "✓" : vd.stance === "contradicts" ? "✗" : "•"} {vd.stance}
            </span>
          ))}
        </div>
      )}
      {verification.concerns.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
          {verification.concerns.map((c, i) => (
            <li key={i} style={{ fontSize: 12, color: "var(--conf-low)", lineHeight: 1.45 }}>{c}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ── Considerations (ranked differentials) ────────────────────────────────── */
export function ConsiderationsBody({
  considerations,
  dismissed,
  onToggle,
}: {
  considerations: Consideration[];
  dismissed: Set<number>;
  onToggle: (i: number) => void;
}) {
  if (considerations.length === 0) return <p className="panel-empty">reasoning…</p>;
  return (
    <>
      {considerations.map((c, i) => {
        const isDismissed = dismissed.has(i);
        return (
          <div key={i} className={`consideration ${isDismissed ? "dismissed" : ""}`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="label">
                <span style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 12, marginRight: 6 }}>{i + 1}</span>
                {c.label}
              </span>
              <button className="btn btn-ghost" style={{ padding: "3px 9px", fontSize: 10 }} onClick={() => onToggle(i)}>
                {isDismissed ? "restore" : "dismiss"}
              </button>
            </div>
            <p className="why">{c.rationale}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <div className="conf-bar"><span style={{ width: `${pct(c.confidence)}%`, background: rampColor(c.confidence) }} /></div>
              <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{pct(c.confidence)}%</span>
              {c.evidence_refs.length > 0 && (
                <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>ev [{c.evidence_refs.join(", ")}]</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── Gate → Record (HITL approval, then the miatec receipt) ───────────────── */
export function RecordGateBody({
  waiting,
  busy,
  approved,
  canApprove,
  onApprove,
  result,
}: {
  waiting: boolean;
  busy: boolean;
  approved: boolean;
  canApprove: boolean;
  onApprove: () => void;
  result: MiatecWriteResult | null;
}) {
  if (result) {
    const ok = result.status === "success";
    return (
      <div className="gate-box">
        <div className={`receipt-stamp ${ok ? "" : "fail"}`}>
          <span className="big">{ok ? "Staged for miatec" : "Write failed"}</span>
          {result.encounter_id && <span className="eid">{result.encounter_id}</span>}
        </div>
        <p className="gp">
          {ok
            ? `Idempotency-keyed DynamoDB write — safe to retry, writes once. ${result.detail ?? ""}`
            : result.detail ?? "see logs"}
        </p>
      </div>
    );
  }
  if (waiting) {
    return (
      <div className="gate-box">
        <div className="gh">Your approval is the gate</div>
        <p className="gp">Edit the note and dismiss considerations on the left. Nothing writes to miatec until you approve.</p>
        <button className="btn btn-approve" onClick={onApprove} disabled={busy || approved || !canApprove}>
          {approved ? "Approved ✓" : busy ? "Writing…" : "Approve & Write to miatec"}
        </button>
      </div>
    );
  }
  return <p className="panel-empty">the real write — DynamoDB staging store → miatec — gated behind your approval</p>;
}
