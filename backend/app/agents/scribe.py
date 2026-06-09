"""Scribe agent — audio → diarized transcript with confidence.

Real: AWS Transcribe **batch** (pt-BR, speaker labels). Batch on a clean clip is the reliable choice
for a recorded demo (vs streaming). Audio must live in S3 — a local path is uploaded first. Each
segment carries averaged confidence (drives failure-handling flags) and its RAW diarization label
(spk_0 / spk_1); the downstream Roles agent assigns doctor/patient. Scores under: Actions & Tool Use.

Falls back to a canned pt-BR transcript when AWS isn't configured or no `audio_ref` is supplied, so
the loop always runs. Pass audio via POST /ingest {"audio_ref": "s3://bucket/clip.m4a"} (or a local
path, which gets uploaded to S3_AUDIO_BUCKET).
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid

import httpx

from app.aws import aws_configured, client
from app.events import publish
from app.schema import TranscriptSegment

AGENT = "scribe"
_POLL_TIMEOUT_S = 600  # real consultations run ~10 min; batch transcription needs headroom

# Canned pt-BR consult so the skeleton runs end-to-end without AWS wired up. Anonymous labels
# (spk_0/spk_1) just like real diarization — the Roles agent assigns doctor/patient.
# The deliberately low-confidence segment powers the failure-handling demo.
_MOCK_TRANSCRIPT = [
    {"speaker": "spk_0", "text": "Bom dia, o que a senhora está sentindo?", "confidence": 0.98},
    {"speaker": "spk_1", "text": "Doutor, estou com uma dor no peito desde ontem e falta de ar.", "confidence": 0.93},
    {"speaker": "spk_0", "text": "A dor irradia para o braço? Tem histórico de pressão alta?", "confidence": 0.97},
    {"speaker": "spk_1", "text": "Irradia um pouco para o braço esquerdo. Tomo losartana pra pressão.", "confidence": 0.61},
    {"speaker": "spk_0", "text": "Vou pedir um eletrocardiograma e marcadores cardíacos.", "confidence": 0.96},
]


async def run_scribe(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running"})

    audio_ref = state.get("audio_ref")
    segments = None
    if audio_ref and aws_configured():
        try:
            # Transcribe is blocking + slow; run it off the event loop.
            segments = await asyncio.to_thread(_transcribe_batch, audio_ref)
        except Exception as exc:  # noqa: BLE001 — surface, then fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc)})

    if not segments:
        await asyncio.sleep(0.5)  # simulate latency for the stub path
        segments = [
            TranscriptSegment(speaker=s["speaker"], speaker_label=s["speaker"],
                              text=s["text"], confidence=s["confidence"]).model_dump()
            for s in _MOCK_TRANSCRIPT
        ]

    await publish(session_id, {"agent": AGENT, "status": "done", "transcript": segments})
    return {"transcript": segments}


def _transcribe_batch(audio_ref: str) -> list:
    """Start an AWS Transcribe pt-BR batch job with diarization, poll it, parse the result."""
    s3_uri = _ensure_in_s3(audio_ref)
    job_name = f"miatec-scribe-{uuid.uuid4().hex[:12]}"

    tc = client("transcribe")
    tc.start_transcription_job(
        TranscriptionJobName=job_name,
        LanguageCode="pt-BR",
        Media={"MediaFileUri": s3_uri},  # MediaFormat omitted → Transcribe auto-detects (m4a, mp3, wav, …)
        Settings={"ShowSpeakerLabels": True, "MaxSpeakerLabels": 2},
    )

    deadline = time.monotonic() + _POLL_TIMEOUT_S
    while True:
        job = tc.get_transcription_job(TranscriptionJobName=job_name)["TranscriptionJob"]
        status = job["TranscriptionJobStatus"]
        if status in ("COMPLETED", "FAILED"):
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"transcription job {job_name} timed out")
        time.sleep(2)

    if status == "FAILED":
        raise RuntimeError(job.get("FailureReason", "transcription failed"))

    transcript_url = job["Transcript"]["TranscriptFileUri"]
    data = httpx.get(transcript_url, timeout=30).json()
    return _parse_transcript(data)


def _ensure_in_s3(audio_ref: str) -> str:
    """Return an s3:// URI for the audio, uploading a local file if needed."""
    if audio_ref.startswith("s3://"):
        return audio_ref
    bucket = os.getenv("S3_AUDIO_BUCKET")
    if not bucket:
        raise RuntimeError("S3_AUDIO_BUCKET not set; cannot upload local audio for Transcribe")
    key = f"scribe/{uuid.uuid4().hex}/{os.path.basename(audio_ref)}"
    client("s3").upload_file(audio_ref, bucket, key)
    return f"s3://{bucket}/{key}"


def _parse_transcript(data: dict) -> list:
    """Map AWS Transcribe diarized output → TranscriptSegment dicts.

    Speakers keep their RAW diarization labels (spk_0/spk_1); the Roles agent assigns doctor/patient
    downstream as an explicit, reasoned step. Confidence is the mean over the words in each turn.
    """
    results = data.get("results", {})
    by_start = {
        it["start_time"]: it
        for it in results.get("items", [])
        if it.get("type") == "pronunciation" and it.get("start_time")
    }

    segments = []
    for seg in results.get("speaker_labels", {}).get("segments", []):
        label = seg.get("speaker_label", "spk_0")
        words, scores = [], []
        for w in seg.get("items", []):
            it = by_start.get(w.get("start_time"))
            if not it:
                continue
            alt = (it.get("alternatives") or [{}])[0]
            words.append(alt.get("content", ""))
            try:
                scores.append(float(alt.get("confidence", "1")))
            except (TypeError, ValueError):
                scores.append(1.0)
        if not words:
            continue
        segments.append(
            TranscriptSegment(
                speaker=label,
                speaker_label=label,
                text=" ".join(words),
                confidence=round(sum(scores) / len(scores), 2) if scores else 1.0,
                start=float(seg["start_time"]) if seg.get("start_time") else None,
                end=float(seg["end_time"]) if seg.get("end_time") else None,
            ).model_dump()
        )
    return segments
