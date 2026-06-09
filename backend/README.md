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
| POST | `/ingest` | Runs Scribe → Structuring → Evidence → Considerations, pauses at the HITL gate |
| GET | `/stream/{session}` | SSE — agents lighting up live (feed the cockpit) |
| GET | `/state/{session}` | Current encounter state (note, evidence, considerations) |
| POST | `/approve` | Doctor's edited + approved note (+ dismissed considerations); returns a miatec **dry-run preview** |
| POST | `/write/{session}` | Record agent writes into miatec, then optional Billing |

## Where to plug real APIs

Every agent ships a runnable stub returning canned pt-BR data. Search **`TODO(real)`** and replace:

| File | Real integration |
|---|---|
| `app/agents/scribe.py` | AWS Transcribe (pt-BR, speaker labels) |
| `app/agents/structuring.py` | Claude tool-calling + Pydantic validation |
| `app/agents/evidence.py` | Exa search + contents |
| `app/agents/considerations.py` | Claude reasoning over note + evidence |
| `app/agents/record.py` | miatec REST (idempotency key + retry) |
| `app/agents/billing.py` | Stripe (optional) |

`app/graph.py` is the orchestration artifact — screenshot it for the slide. `app/schema.py` is the
typed contract every agent reads/writes.

> Targets Python 3.9+ so it runs on this machine; the build plan recommends 3.12 for the deploy image.
