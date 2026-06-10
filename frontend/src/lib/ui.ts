// Tiny pure helpers shared across stage components. The semantic confidence ramp (high/mid/low)
// uses the exact thresholds the backend agents use (0.85 / 0.70) so the colour means one thing.

export function rampColor(v: number): string {
  if (v >= 0.85) return "var(--conf-high)";
  if (v >= 0.7) return "var(--conf-mid)";
  return "var(--conf-low)";
}

export function pct(v: number): number {
  return Math.round(v * 100);
}
