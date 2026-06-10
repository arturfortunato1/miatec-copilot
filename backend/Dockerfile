# miatec-copilot backend — FastAPI + LangGraph agent loop.
# Container target is AWS compute (ECS Fargate / Lightsail container / EC2 docker).
# App Runner is blocked by the workshop SCP on this account — do not target it.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

# curl is only for the container HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Core deps + the real integration SDKs (boto3 → Transcribe batch/S3/Bedrock,
# amazon-transcribe → Transcribe streaming, exa-py → Evidence, anthropic + openai → the LLM layer
# incl. the Vercel AI Gateway path).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "boto3>=1.34" "amazon-transcribe>=0.6" "exa-py>=1.8" "anthropic>=0.40" "openai>=1.40"

COPY app ./app

# Run as a non-root user (ECS/Fargate + general hardening).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8000

# Container health check; an ALB/target-group also health-checks /health independently.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

# IMPORTANT: single worker. State lives in an in-process LangGraph MemorySaver checkpointer and an
# in-memory SSE pub/sub (app/events.py) — multiple workers would not share sessions or the stream.
# Scale path = DynamoDB checkpointer + Redis pub/sub (see README "Notes").
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75"]
