"use client";
// The self-filling scorecard. Press R (or the top-bar affordance) to slide it in. Each of the seven
// judging dimensions is dim until an on-stage moment earns it, then lights in its dimension ink — so
// the judge literally watches their own scorecard assemble as the encounter runs.
import { RUBRIC } from "@/lib/rubric";
import type { RubricDim } from "@/lib/stageTypes";

export function ScorecardOverlay({
  open,
  satisfied,
  onClose,
}: {
  open: boolean;
  satisfied: Set<RubricDim>;
  onClose: () => void;
}) {
  if (!open) return null;
  const lit = RUBRIC.filter((r) => satisfied.has(r.key)).length;

  return (
    <>
      <div className="scorecard-scrim" onClick={onClose} />
      <div className="scorecard scroll-area" role="dialog" aria-label="Judging scorecard">
        <h2>Judging scorecard</h2>
        <p className="lede">
          Each dimension lights the moment an agent earns it on stage. The colour is the dimension&rsquo;s
          ink — watch it reappear wherever that dimension recurs.
        </p>
        {RUBRIC.map((r) => {
          const isLit = satisfied.has(r.key);
          return (
            <div key={r.key} className={`score-row ${isLit ? "lit" : ""}`} style={{ ["--ink" as string]: r.ink }}>
              <span className="tick">{isLit ? "✓" : ""}</span>
              <div>
                <div className="dim-name">{r.label}</div>
                <div className="dim-when">{r.earnedBy}</div>
              </div>
            </div>
          );
        })}
        <div className="progress">{lit} / {RUBRIC.length} dimensions earned · press R or click away to close</div>
      </div>
    </>
  );
}
