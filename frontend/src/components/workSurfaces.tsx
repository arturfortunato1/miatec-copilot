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

/* ── Inline-editable transcript segment ──────────────────────────────────── */
// Local edit state per segment: the doctor can fix transcription errors before approving.
// Edits are annotations only — the SOAP note (not the raw transcript) is what writes to miatec.
function SegmentText({ displayText, editable, segKey }: { displayText: string; editable: boolean; segKey: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayText);
  const [isEdited, setIsEdited] = useState(false);

  // Reset when language toggles (segKey includes lang suffix) or new session
  useEffect(() => { setValue(displayText); setIsEdited(false); setEditing(false); }, [segKey]);
  // Sync when translation arrives before any edit
  useEffect(() => { if (!isEdited) setValue(displayText); }, [displayText, isEdited]);

  if (!editable) return <span className="txt">{displayText}</span>;

  if (editing) {
    return (
      <textarea
        className="txt seg-textarea"
        autoFocus
        value={value}
        rows={Math.max(1, Math.ceil(value.length / 55))}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { setEditing(false); if (value.trim() !== displayText.trim()) setIsEdited(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setEditing(false); if (value.trim() !== displayText.trim()) setIsEdited(true); }
          if (e.key === "Escape") { setEditing(false); if (!isEdited) setValue(displayText); }
        }}
      />
    );
  }

  return (
    <span
      className={`txt seg-editable${isEdited ? " seg-edited" : ""}`}
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
      {isEdited && <span className="seg-edit-badge">edited</span>}
    </span>
  );
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
  editable,
}: {
  transcript: TranscriptSegment[];
  roles: SpeakerRoles | null;
  onSwap: () => void;
  busy: boolean;
  audioUrl: string | null;
  audioName: string | null;
  editable?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  // Translations STREAM in per batch. Each line plays its rewrite sweep once, the moment its
  // translation lands: `waving` maps segment index → stagger slot within its just-arrived batch.
  const [waving, setWaving] = useState<Map<number, number>>(new Map());
  const seenEnRef = useRef<Set<number>>(new Set());
  const timersRef = useRef<number[]>([]);

  const hasTranslation = transcript.some((s) => !!s.text_en);

  // Detect newly-translated lines on every transcript update (batches arrive in any order) and
  // animate exactly those. A reset (restart) clears the seen-set so the next run replays.
  useEffect(() => {
    if (transcript.length === 0) {
      seenEnRef.current = new Set();
      setWaving(new Map());
      return;
    }
    const fresh: number[] = [];
    transcript.forEach((s, i) => {
      if (s.text_en && !seenEnRef.current.has(i)) fresh.push(i);
    });
    if (fresh.length === 0) return;
    fresh.forEach((i) => seenEnRef.current.add(i));
    setWaving((prev) => {
      const next = new Map(prev);
      fresh.forEach((idx, order) => next.set(idx, order));
      return next;
    });
    const ttl = fresh.length * WAVE_STAGGER_MS + WAVE_TAIL_MS;
    const t = window.setTimeout(() => {
      setWaving((prev) => {
        const next = new Map(prev);
        fresh.forEach((idx) => next.delete(idx));
        return next;
      });
    }, ttl);
    timersRef.current.push(t);
  }, [transcript]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  // Keep the newest line in view while the capture streams.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Toggling language mid-sweep would swap animated spans for static ones mid-flight — any toggle
  // simply ends the in-flight sweeps and shows plain text. Deterministic.
  const endWave = () => setWaving(new Map());

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
      {editable && (
        <div className="transcript-edit-bar">
          <span>✎ click any line to correct before approving</span>
        </div>
      )}
      <div ref={ref} className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 14px 12px" }}>
        {transcript.length === 0 && <p className="panel-empty">listening…</p>}
        {transcript.map((seg, i) => {
          const low = seg.confidence < 0.7;
          const who = resolve(seg.speaker);
          const showEn = !!seg.text_en && !showOriginal;
          const order = waving.get(i);
          const displayText = showEn ? (seg.text_en ?? seg.text) : seg.text;
          return (
            <div key={i} className={`turn ${low ? "low" : ""}`}>
              <span className="who" data-role={roleData(who)}>{who}</span>
              {showEn && order !== undefined && !editable ? (
                <span className="txt rw" style={{ ["--d" as string]: `${order * WAVE_STAGGER_MS}ms` }}>
                  <span className="t-en">{seg.text_en}</span>
                  <span className="t-pt" aria-hidden>{seg.text}</span>
                  <span className="t-sweep" aria-hidden />
                </span>
              ) : (
                <SegmentText
                  displayText={displayText}
                  editable={!!editable}
                  segKey={`${i}-${showEn ? "en" : "pt"}`}
                />
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
      {editable && (
        <div className="soap-edit-bar">
          <span>✎ all fields editable — changes go into the miatec record</span>
        </div>
      )}
      <div className="soap-grid">
        <SoapField label="Chief complaint" value={note.chief_complaint} span editable={editable} onChange={(val) => onChange({ ...note, chief_complaint: val })} />
        <SoapField label="History of present illness" value={note.hpi} span editable={editable} onChange={(val) => onChange({ ...note, hpi: val })} />
        <SoapField label="Medications" value={meds} editable={editable} onChange={(val) => onChange({ ...note, current_medications: val.split(",").map((s) => s.trim()).filter(Boolean) })} />
        <SoapField label="Allergies" value={allergies} editable={editable} onChange={(val) => onChange({ ...note, allergies: val.split(",").map((s) => s.trim()).filter(Boolean) })} />
        <SoapField label="Review of systems" value={ros} editable={editable} onChange={(val) => onChange({ ...note, review_of_systems: val.split(";").map((s) => s.trim()).filter(Boolean) })} />
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
  selected,
  onToggle,
  gateOpen,
}: {
  considerations: Consideration[];
  selected: Set<number>;
  onToggle: (i: number) => void;
  gateOpen: boolean;
}) {
  if (considerations.length === 0) return <p className="panel-empty">reasoning…</p>;
  const anySelected = selected.size > 0;
  return (
    <>
      {gateOpen && (
        <div className="cons-gate-bar">
          {anySelected ? (
            <span className="cons-count">{selected.size} of {considerations.length} confirmed</span>
          ) : (
            <span className="cons-prompt">Select the considerations that match this patient</span>
          )}
          <span className="cons-gate-hint">click a card to confirm</span>
        </div>
      )}
      {considerations.map((c, i) => {
        const isSelected = selected.has(i);
        const unconfirmed = anySelected && !isSelected;
        return (
          <div
            key={i}
            className={`consideration${isSelected ? " confirmed" : ""}${unconfirmed ? " unconfirmed" : ""}${gateOpen ? " selectable" : ""}`}
            onClick={() => gateOpen && onToggle(i)}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="label">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, marginRight: 6, color: isSelected ? "var(--conf-high)" : "var(--text-3)" }}>
                  {isSelected ? "✓" : i + 1}
                </span>
                {c.label}
              </span>
              {gateOpen && (
                <button
                  className={`btn ${isSelected ? "btn-confirmed" : "btn-ghost"}`}
                  style={{ padding: "3px 11px", fontSize: 10, flexShrink: 0 }}
                  onClick={(e) => { e.stopPropagation(); onToggle(i); }}
                >
                  {isSelected ? "✓ Confirmed" : "Confirm"}
                </button>
              )}
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
        <p className="gp">Confirm the relevant considerations and edit the note if needed. Nothing writes to miatec until you approve.</p>
        <button className="btn btn-approve" onClick={onApprove} disabled={busy || approved || !canApprove}>
          {approved ? "Approved ✓" : busy ? "Writing…" : "Approve & Write to miatec"}
        </button>
      </div>
    );
  }
  return <p className="panel-empty">the real write — DynamoDB staging store → miatec — gated behind your approval</p>;
}
