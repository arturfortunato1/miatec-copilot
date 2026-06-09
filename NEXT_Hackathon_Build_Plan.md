# NEXT Hackathon — Build Plan & Runbook

**Project codename:** *Anamnese* (working name — the medical term for history-taking; rename freely. For an international judging room, an English-legible product name like **ScribeLoop** or **miatec Copilot** also works.)

**One-liner:** The doctor just talks. A team of agents transcribes, structures, grounds it in real evidence, and writes the finished record straight into miatec — with one human approval gate in the middle.

**Build window:** 12:00pm 9 June → **submission 11:59pm 10 June** (NOT the 11th — the 11th is only finalist announcement + recorded-demo pitches). Deck + demo video must be *done* inside this window.

**The bet:** This rubric scores your *agents*, not product polish. Everyone can build a chatbot. Almost no team will have a **real hospital system to write into**. Build one bulletproof loop expressed as a legible multi-agent system, and deliberately nail the three criteria most teams skip — orchestration you can narrate, human-in-the-loop, and failure handling.

---

## 1. Scope — what it is and what it does

### What it is
An **ambient, agentic clinical scribe + decision support layer** that sits on top of miatec. During a consultation it listens, and by the time the doctor looks up, the structured clinical note, the supporting evidence, and the record inside miatec are all done.

### What it does (the loop)
1. **Listens** to the consultation (mic / uploaded audio), transcribes it, and separates doctor from patient.
2. **Structures** the conversation into a clinical note (SOAP + discrete fields: complaint, history, vitals, meds, allergies).
3. **Grounds** it — pulls relevant guidelines/literature from the live web and attaches citations.
4. **Ranks considerations** — surfaces a ranked list of differential considerations, each with supporting signals and linked evidence (decision *support*, never autonomous diagnosis).
5. **Pauses for the doctor** — the doctor reviews, edits, dismisses, and approves. This is the human-in-the-loop gate.
6. **Writes** the approved record into miatec via its API.
7. *(Optional)* **Bills** — turns the finished encounter into an invoice/charge via Stripe (only if a private-clinic context applies).

### Explicit non-goals (say these out loud — they read as maturity)
- Not autonomous diagnosis. The AI ranks considerations; the clinician decides.
- Not a treatment-prescribing engine (roadmap, not v1).
- Not a replacement for miatec — it's an intelligence layer that *feeds* miatec.

---

## 2. Architecture — the agents

Six agents + an orchestrator. Each agent maps to a named judging dimension, which is the entire point of structuring it this way.

| Agent | Job | Real tools/APIs it uses | Scores under |
|---|---|---|---|
| **Scribe** | Audio → diarized transcript with confidence | AWS Transcribe (pt-BR, speaker labels) | Actions & Tool Use |
| **Structuring** | Transcript → validated SOAP JSON | Claude (tool-calling / JSON schema) | Autonomy & Decision-Making |
| **Evidence** | Symptoms → cited guidelines/literature | **Exa** (search + contents) | Tool Use + **Exa prize** |
| **Considerations** | Note + evidence → ranked differentials w/ rationale | Claude (reasoning over structured state) | Autonomy & Decision-Making |
| **Record** | Approved note → written into miatec | **miatec API** (REST, ideally MCP-wrapped) | Actions & Tool Use — **your moat** |
| **Billing** *(optional)* | Encounter → invoice/charge | **Stripe** (Payment Intents / Invoices) | Tool Use + **Stripe prize** |
| **Orchestrator** | Coordinates order, passes state, owns the HITL gate, handles failures | LangGraph state graph | **Orchestration** + Failure Handling |

### Data flow (the orchestrator's shared state)
```
audio
  └─ Scribe ──▶ transcript[] (speaker, text, confidence)
        └─ Structuring ──▶ note{} (SOAP + discrete fields, validated)
              ├─ Evidence ──▶ evidence[] (claim, source, url)
              └─ Considerations ──▶ considerations[] (label, rationale, confidence, evidence_refs)
                    └─ ⏸ HUMAN-IN-THE-LOOP: doctor edits / dismisses / approves
                          └─ Record ──▶ miatec_write_result{} (encounter_id, status)
                                └─ Billing (optional) ──▶ invoice{}
```
The state object is a single typed dict that flows through the LangGraph nodes. **Show this graph in your slides** — it directly answers "how do your agents coordinate."

---

## 3. Tech stack — every tool, and why

### Orchestration
- **LangGraph (Python)** — primary. Graph-based, explicit state, and you can literally screenshot the graph for the "orchestration" slide. Add **LangSmith** for traces — showing the agent reasoning trace in your video is free points on Autonomy.
- *Alt:* **Vercel AI SDK (TypeScript)** if your team is JS-only — simpler single-deploy story, multi-step tool-calling built in.
- *Speed path:* **Dify Pro** (free 1-month sub provided) — low-code visual agent builder. Use it if you value speed over control, or to stand up a non-core agent fast.

### Backend
- **Python 3.12 + FastAPI + Uvicorn**, deployed on **AWS App Runner** (simplest container deploy) or **ECS Fargate**. This satisfies the "deployed on AWS" finalist requirement with compute, not just API calls.
- **Pydantic** for the clinical-note schema and hard validation.

### Frontend (the doctor cockpit)
- **Next.js 15 (App Router) + React + Tailwind + shadcn/ui**, deployed on **Vercel** (satisfies the Vercel requirement).
- **v0** ($50 credits provided) to scaffold the UI fast — generate it *during* the hack, not before.
- **Server-Sent Events (SSE)** so the UI shows agents lighting up live as they work — this is what makes the demo video feel alive.

### LLM
- **Claude (Anthropic)** — best fit for clinical reasoning, structured output, and tool use. Two routing options:
  - **Via Amazon Bedrock** → counts as AWS tool use (sponsor alignment), single cloud bill.
  - **Direct Anthropic API** or **Vercel AI Gateway** → simpler, faster to wire.

### Speech-to-text (ASR)
- **AWS Transcribe** (streaming, `pt-BR`, speaker partitioning) — primary, sponsor-aligned. Note: *Transcribe Medical* is English-only, so use **general Transcribe with pt-BR**, not the Medical variant.
- *Fallback:* **Deepgram Nova** or **AssemblyAI** if Transcribe latency/quality on pt-BR disappoints. For the recorded demo, **batch** transcription of a clean clip is more reliable than live streaming.

### Search / grounding
- **Exa API** — `search` + `get contents`. Construct the query from extracted symptoms; restrict to authoritative domains (PubMed, guideline bodies, Brazilian MoH / specialty societies); pass clean contents to Claude for a one-line grounded finding + citation.

### Payments (optional)
- **Stripe** — Payment Intents or Invoices. Only wire this if miatec serves a private-pay/clinic context; a charge in a public-hospital (SUS) flow reads as forced and won't win the track anyway.

### Storage & infra
- **S3** — audio files (AWS alignment).
- **Postgres (AWS RDS)** or **Supabase** for state — or **in-memory/SQLite** for the demo. Don't over-invest; the encounter state can live in memory for a 36h build.
- **Auth:** skip real auth for the demo — hardcoded session or a magic link. Don't burn time here.

### miatec integration
- **miatec REST API** — the Record agent maps the structured JSON to miatec's encounter/prontuário model and POSTs it.
- **Strongly consider wrapping miatec as an MCP server** (FastMCP or the official MCP Python SDK). At an AI conference, exposing your real hospital system as agent-callable MCP tools is a *very* on-theme narrative and genuinely clean engineering. If time-constrained, plain typed REST tool functions are the safe baseline — same outcome, less flash.

---

## 4. Integration details — how the pieces connect

- **Frontend ↔ backend:** REST for actions (`/ingest`, `/approve`, `/write`) + an **SSE stream** (`/stream/{session}`) pushing each agent's status and partial outputs so the cockpit updates live.
- **Scribe → state:** Transcribe returns segments with speaker labels + per-segment confidence. Store confidence; it drives failure handling.
- **Structuring → state:** Claude called with a strict JSON schema (tool-calling). Pydantic validates server-side; missing required fields are marked `"not documented"`, never invented.
- **Evidence → Exa:** build query from `note.symptoms + chief_complaint`; call Exa search (domain + recency filters) → `get contents` on top hits → Claude summarizes each to one cited line. If top result score is below threshold → return `"no strong evidence found"`.
- **Considerations → state:** Claude reasons over `note + evidence`, emits ranked list with `rationale`, `confidence`, and `evidence_refs` pointing back to Evidence items so the UI can link them.
- **HITL gate:** the LangGraph graph **interrupts** after Considerations. Nothing writes until the frontend posts `approved: true` with the (possibly edited) note. This interrupt *is* your human-in-the-loop story — make it a visible node.
- **Record → miatec:** map fields → miatec schema; run a **dry-run preview** the doctor sees before write; use an **idempotency key**; on success store `encounter_id`. The UI then shows the actual miatec record.
- **Billing (optional) → Stripe:** on a finalized private encounter, create an Invoice/PaymentIntent; surface the receipt in the UI.

### The clinical-note schema (starting point)
```json
{
  "chief_complaint": "string",
  "hpi": "string",
  "review_of_systems": ["string"],
  "vitals": { "bp": "string|null", "hr": "string|null", "temp": "string|null" },
  "current_medications": ["string"],
  "allergies": ["string"],
  "assessment": "string",
  "plan": "string",
  "low_confidence_segments": ["string"]
}
```

---

## 5. How it maps to the judging rubric (build to this scorecard)

| Judging dimension | Where you earn it |
|---|---|
| **Agent Overview** | The 6-agent architecture diagram + one-line purpose each |
| **Autonomy & Decision-Making** | Structuring decides field mapping; Considerations ranks differentials; show reasoning traces (LangSmith) |
| **Actions & Tool Use** | Transcribe, Exa, **miatec write**, Stripe — real APIs taking real actions |
| **Orchestration** | The LangGraph state graph; show how state flows and branches |
| **Human-in-the-Loop** | The interrupt/approval gate — doctor edits & approves before any write |
| **Failure Handling** | Low-confidence flags, "no evidence found," miatec write-retry — *demo at least one* |
| **Demo & Presentation** | Tight recorded video + punchy deck + a clear spoken pitch |

**The one most teams skip:** Failure Handling is a *named* criterion. Engineer and *show* it — a mumbled segment flagged for review, or Evidence returning "no strong evidence found" instead of hallucinating. Cheap to add, rare to see.

---

## 6. Build timeline (hour-by-hour)

### Day 1 — 9 June (12:00pm → ~midnight)
- **12:00–13:00** Repo + scaffolding. Next.js (Vercel) + FastAPI (AWS) skeletons. Wire all sponsor keys (Exa, AWS, Anthropic/Bedrock, Stripe). Define the note schema. Stub the LangGraph nodes.
- **13:00–15:00** **Scribe agent** — AWS Transcribe on a sample pt-BR clip → diarized transcript in the UI.
- **15:00–17:00** **Structuring agent** — transcript → validated SOAP JSON via Claude → note renders in UI.
- **17:00–19:00** **miatec write spike (do this EARLY — riskiest integration).** Get the Record agent to write a hardcoded note into miatec and confirm it lands.
- **19:00–20:00** Dinner + stitch Scribe → Structuring → Record happy path. End-to-end skeleton alive.
- **20:00–23:00** **Evidence (Exa)** + **Considerations** agents; wire panels into UI.
- **23:00–00:00** HITL approval screen + orchestrator state passing. Commit. **Also: deploy a "hello world" to AWS + Vercel tonight to de-risk the final deploy.** Sleep.

### Day 2 — 10 June (morning → 11:59pm submission)
- **08:00–10:00** **Failure handling** across agents (confidence flags, Exa-empty, miatec write-retry). Named scoring — don't skip.
- **10:00–12:00** Orchestration polish — make the UI agent-status panel show coordination clearly. *If ahead:* wrap miatec as MCP.
- **12:00–14:00** *(Optional)* Stripe billing agent. Behind schedule? Cut it.
- **14:00–16:00** **Full deploy** — frontend to Vercel, backend to AWS. Test the deployed build. (Deploy always breaks; this is why you smoke-tested last night.)
- **16:00–18:00** UI polish + **record the demo video** (scripted consult, clean takes).
- **18:00–20:00** Build the **deck in `.ppt` or `.keynote`** (Google Slides/Gamma are rejected). Embed the video directly (no YouTube links). Architecture diagram + rubric-aligned talking points.
- **20:00–22:00** Buffer / bugfix / re-record. Write README; push **public** repo (or grant judge access).
- **22:00–23:30** **Submit:** GitHub repo + live URL + slides (.ppt/.keynote on Google Drive). Slides lock at submission — make them stage-ready.
- **23:30–23:59** Triple-check the submission. Done.

> **Hard rule:** stop coding by 8pm Day 2. The deck and video are graded deliverables, not afterthoughts.

---

## 7. Team roles (1–4 people)

- **Person 1 — Backend/orchestration:** LangGraph, agents, miatec integration.
- **Person 2 — Frontend:** Next.js cockpit, SSE realtime, v0.
- **Person 3 — AI:** ASR pipeline, Exa/Evidence, Considerations prompts + schema.
- **Person 4 — Infra/story:** AWS + Vercel deploy, demo script, video, deck.

**Solo?** Cut to Scribe → Structuring → Record + Exa evidence. Fold Considerations into the Structuring step. Skip Stripe and MCP. Protect the core loop above all.

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| miatec API auth/docs not ready | Do the write spike in hours 5–7. Fallback: stand up a mock endpoint mirroring miatec's schema (still a real write) — but the real miatec is the moat, so push for it. |
| pt-BR ASR quality/latency | Deepgram/AssemblyAI fallback; use **batch** transcription of a clean clip for the video. |
| AWS deploy hell at the end | Smoke-test a hello-world deploy on Day 1 night, not at 4pm Day 2. |
| Scope creep | Stripe + MCP are *both* optional. Cut on sight if the core loop isn't bulletproof by Day 2 noon. |
| Video/deck rushed | Reserve the last 5–6 hours. Hard stop on coding at 8pm Day 2. |
| "This already exists (Abridge/Nabla)" | Your answer: real EHR write-back + Brazilian public-hospital reality the US incumbents don't serve. |

---

## 9. Demo video script (~2.5 min, recorded — live demos are banned)

1. **0:00–0:15** Cold open: doctor and "patient" talking (pt-BR with EN subtitles, or EN). No keyboard.
2. **0:15–0:50** Cockpit: transcript streams, agents light up in sequence, SOAP note fills in real time.
3. **0:50–1:20** Evidence cards pop with citations; ranked considerations appear with rationale.
4. **1:20–1:45** **HITL beat:** doctor edits one field, dismisses one consideration, clicks **Approve & Write to miatec**.
5. **1:45–2:10** **The money shot:** cut to the actual **miatec** screen — the record is there.
6. **2:10–2:30** **Failure beat:** show a low-confidence segment flagged, or Exa returning "no strong evidence found." *(Optional: Stripe invoice generated.)*

## 10. Slide outline (.ppt/.keynote, visual & punchy)
1. Title + one-liner.
2. Problem: documentation burden / after-visit hours / burnout (one stat).
3. **The agent system** — architecture diagram (6 agents + orchestrator).
4. **Embedded demo video.**
5. Autonomy & tool use — what each agent decides + which real APIs it calls.
6. Human-in-the-loop — the approval gate.
7. Failure handling — the flagged beat.
8. Why this wins — real EHR (miatec), not a copy-paste note; built for Brazil's public-hospital reality.
9. Roadmap + feasibility — treatment recs, miatec install base, business model.
10. Close + ask.

---

## 11. Tonight's pre-kickoff prep (allowed — planning only, NO code/designs/prototypes)

- ✅ Lock the agent map, the note schema, and the one-paragraph pitch (in your head/on paper).
- ✅ Read the Exa, AWS Transcribe, Bedrock, Vercel AI SDK, and Stripe quickstart docs.
- ✅ Have miatec running and know its API endpoints + auth cold (it predates the event — fine).
- ✅ Dev environment installed and logged in: Node, Python 3.12, AWS CLI, Vercel CLI, git.
- ✅ Decide stack + roles with your team; line up your demo "patient" and a 2-min consult script idea.
- ❌ Do NOT write code, build mockups/Figma, or stand up any prototype before noon June 9.

**The miatec line to have ready if asked:** "miatec is my pre-existing commercial hospital product. What I built here is the agentic layer and its integration into miatec." True, clean, and it's exactly what makes the moat legitimate.
