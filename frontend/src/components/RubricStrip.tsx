"use client";
// The judges' scorecard as a persistent bottom strip — always on screen. Each of the seven scoring
// dimensions is dim until an on-stage moment earns it, then lights in its ink. Click for the detailed
// "what earned it" view.
import { RUBRIC } from "@/lib/rubric";
import type { RubricDim } from "@/lib/stageTypes";

export function RubricStrip({
  satisfied,
  onOpen,
}: {
  satisfied: Set<RubricDim>;
  onOpen: () => void;
}) {
  const lit = RUBRIC.filter((r) => satisfied.has(r.key)).length;
  return (
    <div className="rubric-strip" onClick={onOpen} title="Open the detailed scorecard (R)" style={{ cursor: "pointer" }}>
      <span className="rstrip-label">Scorecard {lit}/{RUBRIC.length}</span>
      {RUBRIC.map((r) => (
        <span
          key={r.key}
          className={`rstrip-cell ${satisfied.has(r.key) ? "lit" : ""}`}
          style={{ ["--ink" as string]: r.ink }}
          title={r.earnedBy}
        >
          <span className="rdot" />
          {r.label}
        </span>
      ))}
    </div>
  );
}
