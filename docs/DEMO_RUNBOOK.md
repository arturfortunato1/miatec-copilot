# Demo runbook — submission night (10 June, lock by 23:59)

Everything below in order. Coding is DONE — this is ship + record + deck.

## 0 · Pre-flight (≈30 min, do first)

1. **Fresh AWS creds** — grab the export block from the Workshop Studio portal, paste into `.env`
   (replace the four `AWS_*` lines). *Note: `~/.aws/config` + `credentials` on this machine contain
   pasted `export` lines and break the CLI — the scripts below bypass them automatically; fix or
   delete those two files when convenient.*
2. **Provision the staging store** (one shot, idempotent):
   ```bash
   ./scripts/provision_miatec_table.sh
   ```
   Creates DynamoDB `miatec-encounters` + grants `miatecTaskRole` write + adds `MIATEC_TABLE` to the
   task def (rolls the service).
3. **Push + deploy:**
   ```bash
   git push origin main
   ./scripts/redeploy_backend.sh          # ECR → ECS, waits for stable
   cd frontend && npx vercel --prod       # cockpit → Vercel
   ```
4. **Make the demo public:** Vercel → project `frontend` → Settings → Deployment Protection →
   **disable Vercel Authentication** (judges hit 401 until this is off).
5. **Warm the Scribe cache** (fresh task = cold cache = a multi-minute first run):
   ```bash
   curl -X POST https://d1g2v6wxyaxkjl.cloudfront.net/ingest \
        -H 'content-type: application/json' -d '{"session_id":"warmup"}'
   ```
   Watch `…/state/warmup` until the note is populated, then run one full approve→write to confirm
   the **real** DynamoDB write:
   ```bash
   aws dynamodb get-item --table-name miatec-encounters --region us-west-2 \
       --key '{"pk":{"S":"warmup:record"}}' --query 'Item.encounter_id'
   ```

## 1 · Record the video (~2.5 min, scripted; live demos are banned)

Use the deployed cockpit (`https://frontend-jose-fortunatos-projects.vercel.app`), warmed session.

| t | Beat | On screen |
|---|---|---|
| 0:00–0:15 | Cold open | Doctor + "patient" talking pt-BR (EN subtitles). No keyboard. |
| 0:15–0:50 | The agents work | Cockpit: transcript streams in pt-BR → **Translate wave rewrites it to clinical English** (toggle PT-BR original once), Roles pins doctor/patient with 99%, SOAP fills. Rail shows the LangGraph with both conditional gates. |
| 0:50–1:20 | Grounding + self-check | Exa evidence cards with real citations → **Verifier** verdicts per source (alignment %); Considerations ranks ACS first with rationale. |
| 1:20–1:45 | HITL beat | Edit one SOAP field, dismiss one consideration, click **Approve & Write to miatec**. Say it: *"nothing writes until the doctor approves — native LangGraph interrupt."* |
| 1:45–2:10 | **The real write** | "Staged for miatec · miatec-enc-…" stamp → cut to a terminal: `aws dynamodb get-item …` showing the encounter **in AWS** → (optional) the record entered in the miatec app. |
| 2:10–2:30 | Failure beat | Show the masked low-confidence segment (strikethrough ⚠) and the Verifier's red concern line. One sentence: *"when the agents are unsure, they say so — and route to a human."* |

Clean takes; record at 1920×1080; keep one spare full take.

## 2 · Deck (.ppt or .keynote — Google Slides/Gamma rejected; embed the video file)

1. **Title** — miatec copilot: the doctor just talks.
2. **Problem** — documentation burden / after-hours charting / burnout (one stat).
3. **The agent system** — the architecture diagram from `backend/app/graph.py` docstring (8 agents +
   orchestrator, native interrupt, 2 confidence gates). Screenshot the cockpit rail.
4. **▶ Embedded demo video.**
5. **Autonomy & tool use** — what each agent decides; real surfaces: AWS Transcribe (+ clinical
   vocab), Claude via **Vercel AI Gateway** (→ Nova fallthrough), **Exa**, **AWS DynamoDB** write.
6. **Human-in-the-loop** — the approval gate; speaker confirm/swap; nothing writes until approved.
7. **Failure handling** — masking, review gate, verifier caution branch, visible retries, honest
   "write failed" (screenshot the WRITE FAILED stamp from the expired-creds run!).
8. **Why this wins** — a real write into the clinic's system of record (staging store → miatec),
   pt-BR + Brazilian public-hospital reality incumbents don't serve.
9. **Roadmap** — direct miatec REST write (slots into `record.py` unchanged), dual-channel capture,
   Redis checkpointer for scale-out.
10. **Close + ask.**

## 3 · Submit (22:00–23:30)

- [ ] Repo **public** (or judge access granted) — `arturfortunato1/miatec-copilot`
- [ ] Live URL works logged-out + on phone: `https://frontend-jose-fortunatos-projects.vercel.app`
- [ ] Backend health: `https://d1g2v6wxyaxkjl.cloudfront.net/health`
- [ ] Gateway dashboard shows the demo run's calls (Vercel qualification proof)
- [ ] Deck (.ppt/.keynote) on Google Drive, video embedded, slides stage-ready
- [ ] README quickstart re-tested once from a clean clone
