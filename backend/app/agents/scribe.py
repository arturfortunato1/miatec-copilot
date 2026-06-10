"""Scribe agent — audio → diarized transcript with confidence.

Real: AWS Transcribe **batch** (pt-BR, speaker labels). Batch on a clean clip is the reliable choice
for a recorded demo (vs streaming). Audio must live in S3 — a local path is uploaded first. Each
segment carries averaged confidence (drives failure-handling flags) and its RAW diarization label
(spk_0 / spk_1); the downstream Roles agent assigns doctor/patient. Scores under: Actions & Tool Use.

The agent narrates itself as it works (publishes a `step` for each phase: locate → start job → poll
with elapsed time → parse), so the cockpit can show the long batch job progressing live instead of a
frozen spinner. On success it caches the parsed transcript per audio_ref under backend/.cache so
repeat demos are instant and survive the temporary workshop creds expiring (SCRIBE_CACHE=0 disables).

Falls back to a canned pt-BR transcript when AWS isn't configured or no `audio_ref` is supplied, so
the loop always runs. Pass audio via POST /ingest {"audio_ref": "s3://bucket/clip.m4a"} (or a local
path, which gets uploaded to S3_AUDIO_BUCKET); with no ref it uses DEFAULT_AUDIO_REF.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import pathlib
import time
import uuid

import httpx

from app.aws import aws_configured, client
from app.events import publish
from app.schema import TranscriptSegment
from app.vocab import vocabulary_if_ready

AGENT = "scribe"
_POLL_TIMEOUT_S = 600  # real consultations run ~10 min; batch transcription needs headroom
_CACHE_DIR = pathlib.Path(__file__).resolve().parents[2] / ".cache" / "scribe"
# Visual pacing for the "live capture" effect: seconds between turns as the transcript streams in.
# A DISPLAY rhythm only (not the audio's real duration); set SCRIBE_STREAM_DELAY=0 to disable.
_STREAM_DELAY = float(os.getenv("SCRIBE_STREAM_DELAY", "0.2"))

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


async def _stream_transcript(session_id: str, segments: list, audio_name: str) -> None:
    """Publish the transcript progressively — one turn at a time — so the cockpit fills in line-by-line
    like a live capture. Frames use status "streaming": the UI appends + shows progress, keeps the rail
    spinning, and doesn't flood the activity feed. Paced by _STREAM_DELAY (a display rhythm, NOT the
    audio's real time). run_scribe still returns the whole transcript to the next graph node."""
    if _STREAM_DELAY <= 0 or not segments:
        return
    total = len(segments)
    shown: list = []
    for seg in segments:
        shown.append(seg)
        await publish(session_id, {"agent": AGENT, "status": "streaming", "audio": audio_name,
                                   "step": f"Transcribing the consultation… {len(shown)}/{total} turns",
                                   "transcript": list(shown)})
        await asyncio.sleep(_STREAM_DELAY)


async def run_scribe(state: dict) -> dict:
    session_id = state["session_id"]
    audio_ref = state.get("audio_ref")
    audio_name = os.path.basename(audio_ref) if audio_ref else "sample-consult"

    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": f"Preparing to transcribe {audio_name}…", "audio": audio_name})

    segments, source, vocab = None, "mock", None
    if audio_ref and aws_configured():
        vocab = await asyncio.to_thread(vocabulary_if_ready)  # pt-BR clinical lexicon, if provisioned
        cached = _load_cache(audio_ref, vocab)
        if cached is not None:
            segments, source = cached, "cache"
            await publish(session_id, {"agent": AGENT, "status": "running",
                                       "step": f"Loaded cached transcript ({len(segments)} turns) — skipping re-transcription"})
        else:
            try:
                segments = await _transcribe_live(session_id, audio_ref, vocab)
                source = "s3"
                _save_cache(audio_ref, vocab, segments)
            except Exception as exc:  # noqa: BLE001 — surface, then fall back so the demo survives
                await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                           "step": "Transcribe failed — falling back to the sample transcript"})
                segments = None

    if not segments:
        source = "mock"
        await publish(session_id, {"agent": AGENT, "status": "running",
                                   "step": "No audio/credentials — using the canned pt-BR consult"})
        await asyncio.sleep(0.5)  # simulate latency for the stub path
        segments = [
            TranscriptSegment(speaker=s["speaker"], speaker_label=s["speaker"],
                              text=s["text"], confidence=s["confidence"]).model_dump()
            for s in _MOCK_TRANSCRIPT
        ]

    quality_score = (round(sum(s.get("confidence", 1.0) for s in segments) / len(segments), 3)
                     if segments else None)
    summary, reason = _summarize(segments, source)

    # Stream the transcript in line-by-line for a "live capture" feel before marking the agent done.
    await _stream_transcript(session_id, segments, audio_name)

    await publish(session_id, {"agent": AGENT, "status": "done", "transcript": segments,
                               "summary": summary, "reason": reason, "source": source, "audio": audio_name,
                               "quality_score": quality_score, "degraded": source == "mock",
                               "vocabulary": bool(vocab)})
    return {"transcript": segments, "quality_score": quality_score}


def _summarize(segments: list, source: str) -> tuple:
    """One-line decision + the 'why' the cockpit shows under the agent."""
    n = len(segments)
    speakers = {s.get("speaker_label") or s.get("speaker") for s in segments}
    avg = round(100 * sum(s.get("confidence", 1.0) for s in segments) / n) if n else 0
    low = [s for s in segments if s.get("confidence", 1.0) < 0.7]
    origin = {"s3": "real audio", "cache": "real audio (cached)", "mock": "sample"}.get(source, source)
    summary = f"{n} turns · {len(speakers)} speakers · {avg}% avg confidence · {origin}"
    reason = (f"{len(low)} turn(s) below 70% flagged for review (failure handling)"
              if low else "every turn above the confidence threshold")
    return summary, reason


async def _transcribe_live(session_id: str, audio_ref: str, vocab=None) -> list:
    """Start an AWS Transcribe pt-BR batch job with diarization, poll it (narrating progress), parse."""
    await publish(session_id, {"agent": AGENT, "status": "running", "step": "Locating audio in S3…"})
    s3_uri = await asyncio.to_thread(_ensure_in_s3, audio_ref)

    job_name = f"miatec-scribe-{uuid.uuid4().hex[:12]}"
    vstep = " + pt-BR clinical vocabulary" if vocab else ""
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": f"Starting AWS Transcribe job (pt-BR, speaker diarization{vstep})…"})
    await asyncio.to_thread(_start_job, job_name, s3_uri, vocab)

    start = time.monotonic()
    while True:
        job = await asyncio.to_thread(_get_job, job_name)
        status = job["TranscriptionJobStatus"]
        elapsed = int(time.monotonic() - start)
        if status in ("COMPLETED", "FAILED"):
            break
        if elapsed > _POLL_TIMEOUT_S:
            raise TimeoutError(f"transcription job {job_name} timed out after {elapsed}s")
        await publish(session_id, {"agent": AGENT, "status": "running",
                                   "step": f"Transcribing on AWS… {elapsed}s elapsed (job {status.lower()})"})
        await asyncio.sleep(3)

    if status == "FAILED":
        raise RuntimeError(job.get("FailureReason", "transcription failed"))

    await publish(session_id, {"agent": AGENT, "status": "running", "step": "Parsing diarized transcript…"})
    transcript_url = job["Transcript"]["TranscriptFileUri"]
    data = await asyncio.to_thread(lambda: httpx.get(transcript_url, timeout=30).json())
    return _parse_transcript(data)


def _start_job(job_name: str, s3_uri: str, vocab=None) -> None:
    settings = {"ShowSpeakerLabels": True, "MaxSpeakerLabels": 2}
    if vocab:
        settings["VocabularyName"] = vocab   # bias recognition toward the pt-BR clinical lexicon
    client("transcribe").start_transcription_job(
        TranscriptionJobName=job_name,
        LanguageCode="pt-BR",
        Media={"MediaFileUri": s3_uri},  # MediaFormat omitted → Transcribe auto-detects (m4a, mp3, wav, …)
        Settings=settings,
    )


def _get_job(job_name: str) -> dict:
    return client("transcribe").get_transcription_job(TranscriptionJobName=job_name)["TranscriptionJob"]


# ── transcript cache (per audio_ref) ──────────────────────────────────────────
def _cache_path(audio_ref: str, vocab=None) -> pathlib.Path:
    digest = hashlib.sha1(f"{audio_ref}|vocab={vocab or ''}".encode("utf-8")).hexdigest()[:16]
    return _CACHE_DIR / f"{digest}.json"


def _load_cache(audio_ref: str, vocab=None):
    if os.getenv("SCRIBE_CACHE", "1") == "0":
        return None
    path = _cache_path(audio_ref, vocab)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — a corrupt cache should never break the run
        return None


def _save_cache(audio_ref: str, vocab, segments: list) -> None:
    if os.getenv("SCRIBE_CACHE", "1") == "0":
        return
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(audio_ref, vocab).write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 — caching is best-effort
        pass


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
