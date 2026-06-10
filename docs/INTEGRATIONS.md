# Integrations — chosen stack

Decisions made during the build for wiring the real agents. Updated 2026-06-10.

## LLM (Roles + Structuring + Verifier + Considerations) → one interface, three providers
All four LLM agents call the same helpers (`claude_messages` / `claude_json` in `backend/app/llm.py`),
which fall through on missing keys **and on runtime failure**:

1. **Vercel AI Gateway** — the deployed primary. OpenAI-SDK-compatible endpoint
   (`https://ai-gateway.vercel.sh/v1`); `AI_GATEWAY_API_KEY` + `GATEWAY_MODEL` (live:
   `anthropic/claude-sonnet-4.6`; swap to `anthropic/claude-opus-4.8` for max quality at higher cost).
   **Gotcha:** premium models (Sonnet/Opus) 403 while the gateway balance is *free* credit — an
   anti-abuse guard that neither the Pro plan nor BYOK bypasses; purchasing gateway credit lifts it.
2. **Anthropic API** direct — `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, default `claude-sonnet-4-6`).
3. **Amazon Nova Pro** via the Bedrock **Converse** API (`BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0`).
   **Workshop constraint (probed empirically):** `ws-dont-modify-policy-0` allows Bedrock only for
   **Amazon's own models** and denies every third-party provider — Anthropic, Meta, Mistral, Cohere,
   DeepSeek — in all regions. Nova is verified working from Fargate via the task role.
4. **Stub** — canned pt-BR output, so the loop never breaks.

- **Two model tiers:** the mechanical agents (Translate, Roles, Verifier) run on the **fast tier**
  (`GATEWAY_MODEL_FAST`, default `anthropic/claude-haiku-4.5`) — translation batches run in
  parallel — while Structuring and Considerations keep the full model. `claude_json` **self-repairs**
  malformed/truncated JSON: the model is shown its own broken output + the parser error and re-emits,
  once, before the caller's retry/fallback chain takes over.
- **Env:** `AI_GATEWAY_API_KEY` + `GATEWAY_MODEL` (+ `GATEWAY_MODEL_FAST`) (preferred) · `ANTHROPIC_API_KEY` · `BEDROCK_MODEL_ID` (Nova).
- **Code:** `backend/app/llm.py`, `agents/roles.py`, `agents/structuring.py`, `agents/verifier.py`, `agents/considerations.py`.

## Speech-to-text (Scribe) → AWS Transcribe (pt-BR)
**AWS Transcribe batch**, `LanguageCode=pt-BR`, speaker labels. Batch on a clean clip is the reliable
choice for the recorded demo (vs streaming). Audio lives in S3.
- **Custom vocabulary:** pt-BR clinical terms (meds, exams, conditions) boost accuracy —
  `backend/app/vocab.py`; provision once with `python -m app.vocab` (`TRANSCRIBE_VOCABULARY_NAME`).
- **Env:** AWS creds + region (or the Fargate task role), `S3_AUDIO_BUCKET`; `SCRIBE_CACHE=1` reuses
  parsed transcripts under `.cache/scribe/`.
- **Input:** `POST /ingest {"session_id": "...", "audio_ref": "s3://bucket/clip.wav"}` — a local path
  also works and is uploaded to `S3_AUDIO_BUCKET` first.
- **Code:** `backend/app/agents/scribe.py` — **implemented**; falls back to a canned pt-BR transcript
  when AWS isn't configured, so the loop always runs.

## Speaker attribution (doctor vs patient) → the Roles agent
Transcribe diarizes anonymously (spk_0/spk_1); the **Roles agent** (`agents/roles.py`) assigns
doctor/patient as a reasoned LLM step with a **confidence + rationale**, and low confidence trips the
human-in-the-loop confirm/swap (`POST /roles`, which re-derives the note). Production hardening =
dual-channel capture (`ChannelIdentification`). Full write-up + presentation framing:
[`SPEAKER_ATTRIBUTION.md`](./SPEAKER_ATTRIBUTION.md).

## miatec write (Record) → DynamoDB staging store (real write)
miatec exposes no public REST API yet, so the **Record agent performs a real write** to a DynamoDB
staging table (`MIATEC_TABLE`, default `miatec-encounters`): a **conditional `put_item`** with the
idempotency key (`{session_id}:record`) as the partition key — `attribute_not_exists(pk)` means a
retry after a timeout can never double-write; a matched key is reported as idempotent success. The
item carries the approved note, the non-dismissed considerations, and the evidence↔note alignment.
Entry into the miatec app follows from the staged record; a direct miatec REST write slots into
`record.py` unchanged once an API exists.
- **Provision once:** `scripts/provision_miatec_table.sh` — creates the table (on-demand billing),
  grants `dynamodb:PutItem/GetItem` to `miatecTaskRole`, and adds `MIATEC_TABLE` to the task def.
- **Env:** `MIATEC_TABLE` + AWS creds (or the Fargate task role). Unset → a clearly labeled
  *simulated* write (`degraded: true`), so the loop still plays.
- **Code:** `backend/app/agents/record.py`.

## Evidence → Exa (separate key, not AWS) — tiered retrieval strategy
**Implemented** — `search_and_contents` (`type=auto`, highlights) over a query built from the note's
chief complaint + review of systems, with a **two-tier strategy the agent decides per query**:
1. **Authoritative pass** — `include_domains` scoped to clinical guideline bodies, PubMed/NCBI,
   UpToDate, NICE, WHO, SBC, and BR ministry-of-health domains.
2. **Broaden** — domain-scoped search returns the closest *in-domain* pages even when off-topic (its
   scores are rank-normalized, so they can't gate relevance), so hits only count toward the
   "good-enough" bar when they lexically overlap the query; fewer than 3 on-topic → the agent
   broadens to the open web and merges (deduped, on-topic authoritative first).

The chosen strategy is narrated over SSE (visible in the cockpit's Evidence panel) and each card
carries its tier badge. Returns **"no strong evidence found"** instead of a hallucinated citation.
Unkeyed it falls back to canned authoritative hits so the loop still plays.
- **Env:** `EXA_API_KEY`. **Code:** `backend/app/agents/evidence.py`.

---

## Deployment — the live stack

Backend on **AWS ECS Fargate**, HTTPS via **CloudFront** (`https://d1g2v6wxyaxkjl.cloudfront.net`),
frontend on **Vercel** (`https://frontend-jose-fortunatos-projects.vercel.app`), LLM through the
**Vercel AI Gateway**. Verified end-to-end: a live `/ingest` produced a 69-turn real transcript.

- **Compute:** ECS cluster `miatec`, service `miatec-copilot` (`us-west-2`); image from ECR, built by
  `backend/Dockerfile` (Python 3.12, non-root). **desired-count 1 + `uvicorn --workers 1`** — the
  MemorySaver checkpointer and the SSE bus are in-process; scaling out needs Redis/Postgres first.
- **Credentials:** the task role carries Transcribe + S3 (no static AWS keys in the container);
  `AI_GATEWAY_API_KEY` / `EXA_API_KEY` are injected from Secrets Manager.
- **HTTPS path:** CloudFront (caching disabled) → ALB (idle timeout raised to 900s for the SSE hold) →
  task `:8000`. The CloudFront URL is the frontend's `NEXT_PUBLIC_API_URL`.
- **CloudFront's 60s origin timeout vs a multi-minute run:** `POST /ingest` is **non-blocking** — it
  spawns the graph as a background task and returns an empty `EncounterState` in under a second; the
  cockpit follows along on `GET /stream` (SSE, 15s pings), and `/approve` + `/write` resume from the
  checkpoint.
- **Why not App Runner:** SCP-blocked on the workshop account — and its 120s response cap would kill
  SSE anyway.
- **Cold cache after redeploy:** a fresh task has an empty Scribe cache, so the first `/ingest` runs a
  real multi-minute Transcribe job. Warm it once before demoing.

**Redeploy after backend changes** (always `--platform linux/amd64` from Apple Silicon):

```bash
docker build --platform linux/amd64 --provenance=false -t miatec-copilot backend/
# tag + push to the ECR repo `miatec-copilot`, then:
aws ecs update-service --cluster miatec --service miatec-copilot --force-new-deployment
aws ecs wait services-stable --cluster miatec --services miatec-copilot
```

**Frontend:** Vercel project `frontend`; set `NEXT_PUBLIC_API_URL` to the CloudFront URL. Disable
Vercel **Deployment Protection** for public/judge access — it 401s anonymous visitors while on.

---

## AWS setup checklist
1. **Install AWS CLI**, then `aws configure` — or put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
   `AWS_REGION` in `.env` (the backend loads `.env` via python-dotenv; boto3 reads the same chain).
2. **Bedrock:** Amazon models (Nova) work out-of-the-box here; third-party models (Claude, Llama, …)
   are denied by the workshop policy. Set `BEDROCK_MODEL_ID` (Nova) — or add `ANTHROPIC_API_KEY` for Claude.
3. **Create an S3 bucket** for audio; set `S3_AUDIO_BUCKET`.
4. **Upload a sample pt-BR consult clip** and test:
   `curl -X POST localhost:8000/ingest -H 'content-type: application/json' -d '{"session_id":"t1","audio_ref":"s3://YOUR_BUCKET/clip.wav"}'`
