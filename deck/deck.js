// miatec copilot — NEXT Hackathon pitch deck (10 slides, 16:9, cockpit-dark theme)
const pptxgen = require("pptxgenjs");

const P = new pptxgen();
P.layout = "LAYOUT_16x9"; // 10 x 5.625 in
P.author = "miatec copilot";
P.title = "miatec copilot — NEXT Hackathon";

// ── cockpit palette ───────────────────────────────────────────────────────────
const BG = "0B0F14", PANEL = "131A23", EDGE = "223041";
const TXT = "E8EEF5", MUT = "8FA0B3", FAINT = "7E8FA3";
const TEAL = "2DD4BF", AMBER = "FBBF24", ROSE = "FB7185", BLUE = "38BDF8";
const GREEN = "34D399", CYAN = "22D3EE", PURPLE = "A78BFA", FUCHSIA = "E879F9";
const HEAD = "Trebuchet MS", BODY = "Calibri", MONO = "Consolas";

const kicker = (s, text, color = TEAL) =>
  s.addText(text.toUpperCase(), { x: 0.5, y: 0.34, w: 9, h: 0.3, fontFace: MONO, fontSize: 11,
    color, charSpacing: 4, margin: 0 });
const title = (s, text, opts = {}) =>
  s.addText(text, { x: 0.5, y: 0.62, w: 9, h: 0.75, fontFace: HEAD, fontSize: 30, bold: true,
    color: TXT, margin: 0, ...opts });
const card = (s, x, y, w, h, accent) => {
  s.addShape(P.shapes.RECTANGLE, { x, y, w, h, fill: { color: PANEL }, line: { color: EDGE, width: 0.75 } });
  s.addShape(P.shapes.RECTANGLE, { x, y, w: 0.06, h, fill: { color: accent } });
};
const frame = (s, img, x, y, w, h) => {
  s.addShape(P.shapes.RECTANGLE, { x: x - 0.04, y: y - 0.04, w: w + 0.08, h: h + 0.08,
    fill: { color: PANEL }, line: { color: EDGE, width: 1 } });
  s.addImage({ path: img, x, y, w, h });
};
const newSlide = () => { const s = P.addSlide(); s.background = { color: BG }; return s; };

// ════════ 1 · TITLE ═══════════════════════════════════════════════════════════
{
  const s = newSlide();
  s.addText("NEXT HACKATHON · SUPERAI · JUNE 2026", { x: 0.5, y: 0.45, w: 5.5, h: 0.3,
    fontFace: MONO, fontSize: 10, color: FAINT, charSpacing: 4, margin: 0 });
  s.addText("miatec copilot", { x: 0.5, y: 1.5, w: 5.4, h: 0.95, fontFace: HEAD, fontSize: 47,
    bold: true, color: TXT, margin: 0 });
  s.addText("The doctor just talks.", { x: 0.5, y: 2.5, w: 5.4, h: 0.6, fontFace: HEAD,
    fontSize: 25, bold: true, color: TEAL, margin: 0 });
  s.addText(
    "Eight agents turn one consultation into an approved, written clinical record — transcribed, translated, structured, evidence-grounded, verified, and gated by the clinician.",
    { x: 0.5, y: 3.25, w: 5.0, h: 1.1, fontFace: BODY, fontSize: 13.5, color: MUT, margin: 0 });
  s.addText("⚕ Decision support — the clinician owns every write.", { x: 0.5, y: 4.85, w: 5.2,
    h: 0.3, fontFace: MONO, fontSize: 10, color: FAINT, margin: 0 });
  frame(s, "assets/shot-gate.png", 6.15, 1.05, 3.45, 1.94);
  frame(s, "assets/shot-midrun.png", 6.15, 3.25, 3.45, 1.94);
}

// ════════ 2 · PROBLEM ═════════════════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "the problem", ROSE);
  title(s, "Doctors document more than they doctor");
  card(s, 0.5, 1.75, 3.9, 3.3, ROSE);
  s.addText("2 h", { x: 0.75, y: 2.1, w: 3.4, h: 1.15, fontFace: HEAD, fontSize: 64, bold: true,
    color: TXT, margin: 0 });
  s.addText("of EHR & desk work for every 1 hour of direct patient care",
    { x: 0.75, y: 3.35, w: 3.4, h: 0.75, fontFace: BODY, fontSize: 14.5, color: MUT, margin: 0 });
  s.addText("Sinsky et al., Annals of Internal Medicine (2016)", { x: 0.75, y: 4.55, w: 3.4,
    h: 0.3, fontFace: MONO, fontSize: 8.5, color: FAINT, margin: 0 });

  const rows = [
    ["After-hours charting", "“Pajama time” documentation is a leading, measurable driver of physician burnout.", AMBER],
    ["The note is the bottleneck", "Structured records, coded fields, evidence trails — none of it happens while the patient is in the room.", BLUE],
    ["Brazil is unserved", "High-volume public-hospital consultations, in Portuguese, writing into miatec — a reality US scribe incumbents don’t touch.", TEAL],
  ];
  rows.forEach(([h, b, a], i) => {
    const y = 1.75 + i * 1.15;
    card(s, 4.7, y, 4.8, 1.0, a);
    s.addText(h, { x: 4.95, y: y + 0.12, w: 4.4, h: 0.3, fontFace: HEAD, fontSize: 14, bold: true, color: TXT, margin: 0 });
    s.addText(b, { x: 4.95, y: y + 0.43, w: 4.4, h: 0.55, fontFace: BODY, fontSize: 10.5, color: MUT, margin: 0 });
  });
}

// ════════ 3 · THE AGENT SYSTEM (architecture) ════════════════════════════════
{
  const s = newSlide();
  kicker(s, "the agent system");
  title(s, "One compiled graph. Eight agents. Two corrective gates.");

  const agents = [
    ["Scribe", "AWS Transcribe", PURPLE], ["Translate", "Claude · fast tier", CYAN],
    ["Roles", "doctor vs patient", BLUE], ["Structuring", "SOAP note", GREEN],
    ["Evidence", "Exa · tiered", AMBER], ["Verifier", "alignment 0–1", ROSE],
    ["Considerations", "differentials", FUCHSIA], ["⏸ Human gate", "interrupt()", "60A5FA"],
    ["Record", "DynamoDB", TEAL],
  ];
  const x0 = 0.42, w = 0.97, gap = 0.045, y = 2.0, h = 0.78;
  agents.forEach(([name, sub, accent], i) => {
    const x = x0 + i * (w + gap);
    s.addShape(P.shapes.RECTANGLE, { x, y, w, h, fill: { color: PANEL }, line: { color: accent, width: 1.2 } });
    s.addText(name, { x, y: y + 0.08, w, h: 0.3, fontFace: HEAD, fontSize: name.length > 12 ? 8.2 : 9.5,
      bold: true, color: TXT, align: "center", margin: 0 });
    s.addText(sub, { x, y: y + 0.4, w, h: 0.3, fontFace: MONO, fontSize: 6.8, color: MUT,
      align: "center", margin: 0 });
    if (i < agents.length - 1)
      s.addText("▸", { x: x + w - 0.02, y: y + 0.26, w: gap + 0.05, h: 0.3, fontFace: BODY,
        fontSize: 10, color: FAINT, align: "center", margin: 0 });
  });

  // conditional gate annotations (the autonomy story) — label sits BELOW its dashed return line
  const loop = (xA, xB, drop, label, accent, labX, labW, labAlign) => {
    s.addShape(P.shapes.LINE, { x: xA, y: y + h, w: 0, h: drop, line: { color: accent, width: 1, dashType: "dash" } });
    s.addShape(P.shapes.LINE, { x: xA, y: y + h + drop, w: xB - xA, h: 0, line: { color: accent, width: 1, dashType: "dash" } });
    s.addShape(P.shapes.LINE, { x: xB, y: y + h, w: 0, h: drop, line: { color: accent, width: 1, dashType: "dash" } });
    s.addText(label, { x: labX, y: y + h + drop + 0.05, w: labW, h: 0.25, fontFace: MONO, fontSize: 8.5,
      color: accent, align: labAlign, margin: 0 });
  };
  const cx = (i) => x0 + i * (w + gap) + w / 2;
  loop(cx(2), cx(3), 0.32, "roles_review · confidence < 75% → confirm with the human", BLUE, cx(2), 5.4, "left");
  loop(cx(5), cx(6), 0.82, "reconcile loop · weak alignment → re-query Exa → re-verify → hedge", ROSE, 4.5, 5.0, "right");

  s.addText([
    { text: "ONE COMPILED LANGGRAPH STATEGRAPH", options: { color: TXT, bold: true } },
    { text: "  ·  native interrupt() before the write  ·  every step narrated live over SSE", options: { color: MUT } },
  ], { x: 0.5, y: 4.62, w: 9.0, h: 0.3, fontFace: MONO, fontSize: 9, margin: 0 });
  s.addText("The graph routes on the agents’ own confidence scores — it corrects itself exactly when it’s unsure.",
    { x: 0.5, y: 5.0, w: 9.0, h: 0.3, fontFace: BODY, fontSize: 11.5, italic: true, color: FAINT, margin: 0 });
}

// ════════ 4 · DEMO VIDEO ═════════════════════════════════════════════════════
{
  const s = newSlide();
  s.addImage({ path: "assets/shot-midrun.png", x: 0, y: 0, w: 10, h: 5.625, transparency: 88 });
  kicker(s, "demo · recorded live on the deployed stack");
  s.addShape(P.shapes.ROUNDED_RECTANGLE, { x: 2.6, y: 1.45, w: 4.8, h: 2.7, rectRadius: 0.12,
    fill: { color: PANEL }, line: { color: TEAL, width: 1.5 } });
  s.addText("▶", { x: 4.45, y: 2.0, w: 1.1, h: 1.0, fontFace: BODY, fontSize: 52, color: TEAL,
    align: "center", margin: 0 });
  s.addText("DEMO — 2.5 MIN", { x: 2.6, y: 3.15, w: 4.8, h: 0.4, fontFace: HEAD, fontSize: 18,
    bold: true, color: TXT, align: "center", margin: 0 });
  s.addText("drop demo.mp4 here:  Insert → Video → This Device…  (delete this box)",
    { x: 2.6, y: 3.6, w: 4.8, h: 0.3, fontFace: MONO, fontSize: 9.5, color: AMBER, align: "center", margin: 0 });
  s.addText("One real pt-BR consultation · full pipeline ≈ 64 s · the reconcile loop fires on camera",
    { x: 1.5, y: 4.5, w: 7, h: 0.3, fontFace: BODY, fontSize: 12, color: MUT, align: "center", margin: 0 });
}

// ════════ 5 · AUTONOMY & TOOL USE ════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "autonomy & tool use");
  title(s, "Agents that decide — on real surfaces");

  s.addText("WHAT THE AGENTS DECIDE", { x: 0.5, y: 1.62, w: 4.5, h: 0.28, fontFace: MONO,
    fontSize: 10, color: FAINT, charSpacing: 2, margin: 0 });
  const left = [
    ["Evidence", "picks its retrieval strategy: authoritative clinical domains first; broadens only when the on-topic yield is thin", AMBER],
    ["Verifier", "scores evidence↔note alignment per source — weak → it triggers the reconcile loop", ROSE],
    ["Reconcile loop", "re-queries the literature with an assessment-focused query, re-verifies, and narrates the alignment before → after", ROSE],
    ["Considerations", "reads the FINAL verdict — recovered → ranks normally; still weak → hedges every confidence", FUCHSIA],
  ];
  left.forEach(([h, b, a], i) => {
    const y = 1.95 + i * 0.82;
    card(s, 0.5, y, 4.5, 0.72, a);
    s.addText(h, { x: 0.72, y: y + 0.07, w: 4.1, h: 0.25, fontFace: HEAD, fontSize: 12, bold: true, color: TXT, margin: 0 });
    s.addText(b, { x: 0.72, y: y + 0.31, w: 4.15, h: 0.4, fontFace: BODY, fontSize: 9, color: MUT, margin: 0 });
  });

  s.addText("REAL TOOLS · REAL ACTIONS", { x: 5.3, y: 1.62, w: 4.2, h: 0.28, fontFace: MONO,
    fontSize: 10, color: FAINT, charSpacing: 2, margin: 0 });
  const right = [
    ["AWS Transcribe", "pt-BR batch + custom clinical vocabulary, speaker-diarized with per-turn confidence", PURPLE],
    ["Claude via Vercel AI Gateway", "two tiers: Sonnet for clinical depth, Haiku for speed — translation batches run in parallel", CYAN],
    ["Exa search_and_contents", "tiered neural retrieval; every card carries its provenance badge", AMBER],
    ["AWS DynamoDB — the write", "conditional put, idempotency key as partition key: retries can never double-write", TEAL],
  ];
  right.forEach(([h, b, a], i) => {
    const y = 1.95 + i * 0.82;
    card(s, 5.3, y, 4.2, 0.72, a);
    s.addText(h, { x: 5.52, y: y + 0.07, w: 3.8, h: 0.25, fontFace: HEAD, fontSize: 12, bold: true, color: TXT, margin: 0 });
    s.addText(b, { x: 5.52, y: y + 0.31, w: 3.85, h: 0.4, fontFace: BODY, fontSize: 9, color: MUT, margin: 0 });
  });
}

// ════════ 6 · HUMAN-IN-THE-LOOP ══════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "human-in-the-loop", BLUE);
  title(s, "Nothing writes until the doctor approves");
  frame(s, "assets/shot-staged.png", 5.05, 1.55, 4.45, 2.5);
  s.addText("“Staged for miatec · miatec-enc-…” — a real, queryable record in AWS DynamoDB.",
    { x: 5.05, y: 4.18, w: 4.45, h: 0.5, fontFace: BODY, fontSize: 10.5, italic: true, color: MUT, margin: 0 });

  const rows = [
    ["Native interrupt", "The compiled graph PAUSES before Record (interrupt_before) — approval resumes it from the checkpoint.", BLUE],
    ["Confirm & correct", "Swap doctor↔patient, edit any SOAP field, confirm which considerations apply — the note re-derives from the correction.", GREEN],
    ["Guarded write", "Schema validation at the gate; per-session locks; idempotency-keyed put — a failed write is safely retryable.", TEAL],
  ];
  rows.forEach(([h, b, a], i) => {
    const y = 1.55 + i * 1.15;
    card(s, 0.5, y, 4.25, 1.0, a);
    s.addText(h, { x: 0.72, y: y + 0.12, w: 3.85, h: 0.28, fontFace: HEAD, fontSize: 13.5, bold: true, color: TXT, margin: 0 });
    s.addText(b, { x: 0.72, y: y + 0.42, w: 3.9, h: 0.55, fontFace: BODY, fontSize: 10, color: MUT, margin: 0 });
  });
  s.addText("Low-confidence speaker attribution routes to the human BEFORE structuring — asking for help is a graph-level decision.",
    { x: 0.5, y: 5.05, w: 9, h: 0.3, fontFace: BODY, fontSize: 11, italic: true, color: FAINT, margin: 0 });
}

// ════════ 7 · FAILURE HANDLING ═══════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "failure handling", ROSE);
  title(s, "Built to fail loudly — and recover");
  const cells = [
    ["LOW-CONFIDENCE MASKING", "Sub-70% transcript turns are masked to “[inaudible]” before the note is structured — garbage never enters.", PURPLE],
    ["ROLE REVIEW GATE", "Speaker confidence below 75% routes to the human confirm/swap path before anything downstream runs.", BLUE],
    ["RECONCILE LOOP", "Evidence doesn’t support the note? Re-query → re-verify → hedge if still weak. Narrated on stage.", ROSE],
    ["VISIBLE RETRIES", "LLM, Exa and Transcribe calls retry with backoff — every attempt is an SSE event the cockpit animates.", AMBER],
    ["JSON SELF-REPAIR", "The model is shown its own truncated output + the parser error and corrects it. One bounded pass.", CYAN],
    ["HONEST WRITE FAILURES", "A failed write says so — “Write failed” + the real error — and the idempotency key makes retry safe.", TEAL],
  ];
  cells.forEach(([h, b, a], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.5 + col * 3.13, y = 1.7 + row * 1.62, w = 2.93, hh = 1.45;
    card(s, x, y, w, hh, a);
    s.addText(h, { x: x + 0.2, y: y + 0.13, w: w - 0.35, h: 0.3, fontFace: MONO, fontSize: 10.5,
      bold: true, color: a, charSpacing: 1, margin: 0 });
    s.addText(b, { x: x + 0.2, y: y + 0.47, w: w - 0.38, h: 0.9, fontFace: BODY, fontSize: 9.5, color: MUT, margin: 0 });
  });
  s.addText("Every degradation is labeled in the UI — stubs say they’re stubs; failures say they failed.",
    { x: 0.5, y: 5.08, w: 9, h: 0.3, fontFace: BODY, fontSize: 11, italic: true, color: FAINT, margin: 0 });
}

// ════════ 8 · WHY THIS WINS ══════════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "why this wins");
  title(s, "A real record, written by agents you can audit");
  const stats = [
    ["REAL WRITE", "miatec-enc-…", "idempotency-keyed encounter in AWS DynamoDB — query it live", TEAL],
    ["FAST", "≈64 s", "full 8-agent pipeline, including translation — demoable in real time", GREEN],
    ["LEGIBLE", "1 graph", "every decision, retry and correction narrated on screen as it happens", BLUE],
    ["DEPLOYED", "live now", "AWS Fargate + Transcribe + DynamoDB · Vercel + AI Gateway · Exa", AMBER],
  ];
  stats.forEach(([k, big, sub, a], i) => {
    const x = 0.5 + (i % 2) * 4.7, y = 1.7 + Math.floor(i / 2) * 1.62;
    card(s, x, y, 4.5, 1.45, a);
    s.addText(k, { x: x + 0.22, y: y + 0.13, w: 4.1, h: 0.25, fontFace: MONO, fontSize: 9.5, color: a, charSpacing: 2, margin: 0 });
    s.addText(big, { x: x + 0.22, y: y + 0.36, w: 4.1, h: 0.55, fontFace: HEAD, fontSize: 26, bold: true, color: TXT, margin: 0 });
    s.addText(sub, { x: x + 0.22, y: y + 0.95, w: 4.1, h: 0.4, fontFace: BODY, fontSize: 10, color: MUT, margin: 0 });
  });
  s.addText("Built for Brazil’s public-health reality: Portuguese consultations, miatec’s install base — a market the US scribe incumbents don’t serve.",
    { x: 0.5, y: 5.02, w: 9, h: 0.35, fontFace: BODY, fontSize: 11.5, italic: true, color: MUT, margin: 0 });
}

// ════════ 9 · ROADMAP ════════════════════════════════════════════════════════
{
  const s = newSlide();
  kicker(s, "roadmap & feasibility", GREEN);
  title(s, "Tonight is the foundation, not the finish");
  const cols = [
    ["NOW · SHIPPED", TEAL, ["8 agents on one compiled LangGraph, deployed on AWS + Vercel",
      "Real consultation → approved record in DynamoDB, end-to-end",
      "Reconcile corrective loop + tiered Exa retrieval, live"]],
    ["NEXT · WEEKS", BLUE, ["Direct miatec REST write — slots into record.py unchanged",
      "Dual-channel capture (ChannelIdentification) for hard diarization",
      "Redis/Postgres checkpointer → multi-clinic scale-out"]],
    ["LATER · QUARTERS", FUCHSIA, ["Treatment-plan suggestions grounded in the same evidence loop",
      "Coding & billing agent on the structured record",
      "Rollout across miatec’s existing clinic install base"]],
  ];
  cols.forEach(([h, a, items], i) => {
    const x = 0.5 + i * 3.13, w = 2.93;
    card(s, x, 1.7, w, 3.15, a);
    s.addText(h, { x: x + 0.2, y: 1.85, w: w - 0.35, h: 0.3, fontFace: MONO, fontSize: 11, bold: true, color: a, charSpacing: 1, margin: 0 });
    s.addText(items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1, color: MUT } })),
      { x: x + 0.2, y: 2.25, w: w - 0.38, h: 2.5, fontFace: BODY, fontSize: 10.5, paraSpaceAfter: 8, margin: 0 });
  });
}

// ════════ 10 · CLOSE ═════════════════════════════════════════════════════════
{
  const s = newSlide();
  s.addText("MIATEC COPILOT", { x: 0.5, y: 1.3, w: 9, h: 0.35, fontFace: MONO, fontSize: 12,
    color: FAINT, charSpacing: 6, align: "center", margin: 0 });
  s.addText("The doctor just talks.", { x: 0.5, y: 1.8, w: 9, h: 0.9, fontFace: HEAD, fontSize: 44,
    bold: true, color: TXT, align: "center", margin: 0 });
  s.addText("The agents do the paperwork. The clinician owns every write.", { x: 0.5, y: 2.8, w: 9,
    h: 0.45, fontFace: HEAD, fontSize: 18, color: TEAL, align: "center", margin: 0 });
  s.addText([
    { text: "live demo", options: { breakLine: true } },
    { text: "api", options: { breakLine: true } },
    { text: "code" },
  ], { x: 1.7, y: 3.65, w: 1.6, h: 1.05, fontFace: MONO, fontSize: 12, color: FAINT,
    align: "right", lineSpacing: 22, margin: 0 });
  s.addText([
    { text: "frontend-jose-fortunatos-projects.vercel.app", options: { breakLine: true } },
    { text: "d1g2v6wxyaxkjl.cloudfront.net/health", options: { breakLine: true } },
    { text: "github.com/arturfortunato1/miatec-copilot" },
  ], { x: 3.5, y: 3.65, w: 5.2, h: 1.05, fontFace: MONO, fontSize: 12, color: TXT,
    align: "left", lineSpacing: 22, margin: 0 });
  s.addText("Thank you — let’s put the pajama time back to sleep.", { x: 0.5, y: 5.0, w: 9, h: 0.35,
    fontFace: BODY, fontSize: 12, italic: true, color: MUT, align: "center", margin: 0 });
}

P.writeFile({ fileName: "miatec-copilot-deck.pptx" }).then(() => console.log("DECK WRITTEN"));
