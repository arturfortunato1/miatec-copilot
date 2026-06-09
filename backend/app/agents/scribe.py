"""Scribe agent — audio → diarized transcript with confidence.

Real: AWS Transcribe (pt-BR streaming, speaker labels). Store per-segment confidence; it drives
failure handling downstream. Scores under: Actions & Tool Use.
"""
from __future__ import annotations

import asyncio

from app.events import publish
from app.schema import TranscriptSegment

AGENT = "scribe"

# Canned pt-BR consult so the skeleton runs end-to-end without AWS wired up.
# Note the deliberately low-confidence segment — it powers the failure-handling demo.
_MOCK_TRANSCRIPT = [
    {"speaker": "doctor", "text": "Bom dia, o que a senhora está sentindo?", "confidence": 0.98},
    {"speaker": "patient", "text": "Doutor, estou com uma dor no peito desde ontem e falta de ar.", "confidence": 0.93},
    {"speaker": "doctor", "text": "A dor irradia para o braço? Tem histórico de pressão alta?", "confidence": 0.97},
    {"speaker": "patient", "text": "Irradia um pouco para o braço esquerdo. Tomo losartana pra pressão.", "confidence": 0.61},
    {"speaker": "doctor", "text": "Vou pedir um eletrocardiograma e marcadores cardíacos.", "confidence": 0.96},
]


async def run_scribe(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})
    await asyncio.sleep(0.6)  # simulate streaming latency

    # TODO(real): stream audio (state["audio_ref"], e.g. an S3 key) to AWS Transcribe pt-BR;
    # collect segments with speaker labels + per-segment confidence.
    segments = [TranscriptSegment(**s).model_dump() for s in _MOCK_TRANSCRIPT]

    await publish(session_id, {"agent": AGENT, "status": "done", "transcript": segments})
    return {"transcript": segments}
