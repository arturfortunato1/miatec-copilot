"use client";
// A persistent artifact panel. Always on screen; its content never hides. When its agent holds the
// focus the panel lights in that agent's accent; before it has data it dims. The header carries the
// rubric lanyard(s) + the real sponsor surface so a judge maps it to their scorecard at a glance.
import { RUBRIC_META } from "@/lib/rubric";
import type { RubricDim, Status } from "@/lib/stageTypes";
import { rampColor, pct } from "@/lib/ui";

export function Panel({
  area,
  num,
  title,
  sub,
  accent,
  status,
  active,
  hasData,
  dims,
  sponsor,
  degraded,
  metric,
  flush,
  children,
}: {
  area: string;
  num: string;
  title: string;
  sub?: string;
  accent: string;
  status: Status;
  active: boolean;
  hasData: boolean;
  dims: RubricDim[];
  sponsor?: string;
  degraded?: boolean;
  metric?: { label: string; value: number } | null;
  flush?: boolean;
  children: React.ReactNode;
}) {
  const dim = !hasData && !active;
  return (
    <section
      className={`panel panel-${area} ${active ? "active" : ""} ${dim ? "dim" : ""}`}
      style={{ ["--accent" as string]: accent }}
    >
      <div className="panel-head">
        <span className="panel-num">{num}</span>
        <span className="panel-status" data-s={status} />
        <span className="panel-title">{title}</span>
        {sub && <span className="panel-sub">{sub}</span>}
        {metric && (
          <span className="panel-metric" style={{ color: rampColor(metric.value) }}>
            {pct(metric.value)}% {metric.label}
          </span>
        )}
        <span className="panel-tags">
          {dims.map((d) => (
            <span key={d} className="lanyard" style={{ ["--ink" as string]: RUBRIC_META[d].ink }} title={`Scores under: ${RUBRIC_META[d].label}`}>
              {RUBRIC_META[d].short}
            </span>
          ))}
          {sponsor && (
            <span className="sponsor-tag"><span className="spark" />{sponsor}</span>
          )}
          {degraded && <span className="fallback-pill" title="ran on a stub / fallback">↻ fallback</span>}
        </span>
      </div>
      <div className={`panel-body scroll-area ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}
