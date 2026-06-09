# Integrations — chosen stack

Decisions made during the build for wiring the real agents. Updated 2026-06-09.

## LLM (Structuring + Considerations) → Amazon Nova on Bedrock, Claude as upgrade
**Workshop constraint (probed empirically):** `ws-dont-modify-policy-0` allows Bedrock only for
**Amazon's own models** and denies every third-party provider — Anthropic, Meta, Mistral, Cohere,
DeepSeek — in all regions (us-east-1 / us-west-2 / ap-southeast-1). So:
- **Active now:** **Amazon Nova Pro** via the Bedrock **Converse** API
  (`BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0`) — runs on the workshop creds, AWS-sponsor-aligned, no extra key.
- **Upgrade path:** set `ANTHROPIC_API_KEY` and `llm.py` automatically prefers **Claude via the direct
  Anthropic API** (stronger clinical reasoning). Bedrock-Claude also works on any account that allows it.
- **Resolution:** `llm.py` → Anthropic API if keyed → else Bedrock Converse (`BEDROCK_MODEL_ID`) → else stub.
- **Env:** `ANTHROPIC_API_KEY` (optional, preferred) · `BEDROCK_MODEL_ID` (Nova) · `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).
- **Code:** `backend/app/llm.py`, `agents/structuring.py`, `agents/considerations.py`.

## Speech-to-text (Scribe) → AWS Transcribe (pt-BR)
**AWS Transcribe batch**, `LanguageCode=pt-BR`, speaker labels. Batch on a clean clip is the reliable
choice for the recorded demo (vs streaming). Audio lives in S3.
- **Env:** AWS creds + region, `S3_AUDIO_BUCKET`.
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

## miatec write (Record) → via the miatec app frontend (deferred)
The approved encounter is entered into miatec through the **miatec app's own frontend**, not a backend
REST call — for now ("fairly simple, leave for later"). The Record agent maps the `ClinicalNote` to
the miatec encounter shape and marks it ready for entry; the direct REST write (idempotency key +
retry) is scaffolded in `record.py` as a later enhancement.
- **TODO:** confirm the miatec frontend entry point + the exact fields to map; wire the handoff
  (e.g. deep-link/prefill into the miatec app, or a small REST endpoint if one becomes available).

## Evidence → Exa (separate key, not AWS)
- **Env:** `EXA_API_KEY`. **Code:** `backend/app/agents/evidence.py` — search `TODO(real)`.

---

## AWS setup checklist
1. **Install AWS CLI**, then `aws configure` — or put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
   `AWS_REGION` in `.env` (the backend loads `.env` via python-dotenv; boto3 reads the same chain).
2. **Bedrock:** Amazon models (Nova) work out-of-the-box here; third-party models (Claude, Llama, …)
   are denied by the workshop policy. Set `BEDROCK_MODEL_ID` (Nova) — or add `ANTHROPIC_API_KEY` for Claude.
3. **Create an S3 bucket** for audio; set `S3_AUDIO_BUCKET`.
4. **Upload a sample pt-BR consult clip** and test:
   `curl -X POST localhost:8000/ingest -H 'content-type: application/json' -d '{"session_id":"t1","audio_ref":"s3://YOUR_BUCKET/clip.wav"}'`
