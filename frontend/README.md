# miatec-copilot — frontend (the cockpit)

Next.js + Tailwind single-screen **stage**: all 8 stations (7 agents + the human gate) live on one
screen, animated by the backend's SSE stream. The page *is* the demo — each agent narrates its current
step, confidence ramps tint the panels, and the rubric scorecard accumulates as judging dimensions are
earned.

## Run

```bash
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL — defaults to http://localhost:8000
npm install
npm run dev                        # http://localhost:3000
```

Needs the backend running (`uvicorn app.main:app --port 8000` from `backend/`). With zero API keys the
whole loop still plays end-to-end on the agents' stub fallbacks.

## How it's wired

| Path | Role |
|---|---|
| `src/app/page.tsx` | The whole system on one screen — owns the SSE connection (`/stream/{id}`) and the HITL actions (roles confirm/swap, approve, write) |
| `src/app/layout.tsx` | Fonts (Geist Sans/Mono + Source Serif 4 for the clinical record) + metadata |
| `src/lib/api.ts` | Typed client for the backend contract (`EncounterState`; ingest/roles/approve/write/stream) |
| `src/lib/stage.ts` | `useStageDirector` — paces which agent holds focus (minimum dwell, no strobing) and accumulates the rubric scorecard |
| `src/lib/agents.ts` | Per-agent metadata: label, accent, sponsor surface, where its confidence comes from |
| `src/lib/rubric.ts` | Agent → judging-dimension mapping behind the on-screen scorecard |
| `src/lib/stageTypes.ts` · `src/lib/ui.ts` | Shared stage types · confidence→color ramps |
| `src/components/` | `FlowGraph` (the live LangGraph), `TopBar`, `Panel`, `RubricStrip`, `ScorecardOverlay` (toggle: **R**), `workSurfaces` (transcript / SOAP / evidence / verifier / considerations / record bodies) |

## Deploy

Vercel (`vercel` from this directory). Set `NEXT_PUBLIC_API_URL` to the backend's HTTPS (CloudFront)
URL, and disable Vercel Deployment Protection if the public/judges need access — details in
[`docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md).
