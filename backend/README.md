# miatec-copilot — backend (FastAPI + LangGraph)

Agentic orchestration for the clinical scribe loop. Each LangGraph node is one agent; the API
exposes the loop to the cockpit over REST + SSE, with a human-in-the-loop approval gate in the middle.

## Run (stubbed demo needs zero API keys)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env          # optional — fill keys as you wire real agents
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/docs for the interactive OpenAPI UI.

## The loop / endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/ingest` | Kicks off the graph **in the background** (Scribe → Roles → Structuring → Evidence → Verifier → Considerations) and returns immediately; the run pauses at the HITL gate |
| GET | `/stream/{session}` | SSE — agents lighting up live (feeds the cockpit; 15s pings) |
| GET | `/state/{session}` | Current encounter state (transcript, note, evidence, verification, considerations) |
| POST | `/roles` | HITL speaker correction — confirm or swap doctor↔patient; re-derives the note |
| POST | `/approve` | Applies the doctor's edits + approval into the checkpoint — nothing writes yet |
| POST | `/write/{session}` | Resumes past the interrupt — the Record agent writes the approved note into miatec |
| GET | `/health` | Liveness (used by the container healthcheck) |

## The agents — real integrations, stub fallbacks

Every agent runs its real integration when keys/credentials are present, and silently falls back to a
runnable stub (canned pt-BR data) when they aren't — so the loop always plays:

| File | Live integration |
|---|---|
| `app/agents/scribe.py` | AWS Transcribe batch (pt-BR, diarization, clinical custom vocabulary) |
| `app/agents/roles.py` | LLM doctor/patient attribution + confidence (low → review gate) |
| `app/agents/structuring.py` | LLM strict-JSON SOAP, Pydantic-validated; masks low-confidence turns first |
| `app/agents/evidence.py` | Exa `search_and_contents` — real guideline citations |
| `app/agents/verifier.py` | LLM evidence↔note alignment check (low → caution branch) |
| `app/agents/considerations.py` | LLM ranked differentials, hedging on weak signal |
| `app/agents/record.py` | miatec encounter mapping — the direct REST write is the one remaining `TODO(real)` (entry via the miatec app frontend; see `docs/INTEGRATIONS.md`) |

LLM = one interface (`app/llm.py`): **Vercel AI Gateway → Anthropic API → Bedrock Nova → stub**.

`app/graph.py` is the orchestration artifact — screenshot it for the slide. `app/schema.py` is the
typed contract every agent reads/writes.

> Targets Python 3.9+ locally; the `Dockerfile` deploy image runs **3.12 with a single uvicorn worker**
> (in-process checkpointer + SSE bus). That image is what's live on ECS Fargate — deployment details in
> [`docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md).
