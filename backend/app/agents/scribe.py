"""Scribe agent — audio → diarized transcript with confidence.

Real: AWS Transcribe (pt-BR, speaker labels). Preferred path is **streaming**
(`StartStreamTranscription`): the agent feeds a 16kHz mono PCM WAV to a live stream and publishes turns
as AWS finalizes them, so the cockpit fills in progressively (first turns in ~1-2s) instead of waiting
for a whole clip. It falls back to **batch** (`StartTranscriptionJob`) for arbitrary non-PCM uploads or
if streaming is unavailable (no perms / SDK / PCM ref) — so the loop can never break on it. Audio lives
in S3. Each segment carries averaged confidence (drives failure-handling flags) and its RAW diarization
label (spk_0 / spk_1); the downstream Roles agent assigns doctor/patient. Scores under: Actions & Tool Use.

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
# Used ONLY on the cache/batch/mock paths — the real streaming path publishes turns as AWS finalizes them.
_STREAM_DELAY = float(os.getenv("SCRIBE_STREAM_DELAY", "0.2"))
# Real streaming (AWS Transcribe StartStreamTranscription): pace the PCM we feed the stream so partial
# results come back progressively (the first turns appear in ~1-2s, the rest fill in as the audio plays
# through at ~10x). Set SCRIBE_STREAMING=0 to force the batch path. STREAM_AUDIO_REF = a 16kHz mono PCM
# WAV in S3 to stream for the default demo clip (Transcribe streaming needs PCM, not the m4a).
_STREAM_PACING = float(os.getenv("SCRIBE_STREAM_PACING", "0.05"))
# Feed the stream in ~0.5s chunks (fewer event-loop iterations than tiny chunks) and recompute/publish
# the cleaned transcript at most a few times a second — the per-event clean+publish is what otherwise
# starves the feed loop and drags the stream toward real-time. Both env-tunable without a rebuild.
_STREAM_CHUNK_MS = int(os.getenv("SCRIBE_STREAM_CHUNK_MS", "500"))
_STREAM_PUBLISH_MS = int(os.getenv("SCRIBE_STREAM_PUBLISH_MS", "350"))
# Demo hybrid: the real consult is ~9 min — too long to transcribe end-to-end live. So we live-stream
# only the opening ~N seconds (real-time, for the "live capture" effect) while a fast batch job
# transcribes the WHOLE clip in the background; when batch lands, the full transcript reveals with the
# existing line-by-line animation. Bounds the wait to the batch (~50s), not the audio's real length.
# SCRIBE_DEMO_SECONDS=0 disables the hybrid (pure batch). Code: run_scribe.
_DEMO_SECONDS = int(os.getenv("SCRIBE_DEMO_SECONDS", "30"))

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
            # DEMO HYBRID: live-stream the opening ~_DEMO_SECONDS (real-time capture effect) while a fast
            # BATCH job transcribes the whole ~9-min clip in the BACKGROUND. The batch is authoritative;
            # the stream is a decorative preview. When batch lands we fall through to the line-by-line
            # reveal of the full transcript below — so total wait ≈ batch (~50s), not the audio's length.
            # 1) Short LIVE preview of the opening ~_DEMO_SECONDS — the real-time-capture demo. Runs
            #    on its own (sequential, not concurrent: a batch job polling alongside the stream
            #    contends on the boto3/HTTP layer and stalls the very finals this preview shows).
            stream_ref = _resolve_stream_ref(audio_ref)
            if stream_ref and _DEMO_SECONDS > 0 and os.getenv("SCRIBE_STREAMING", "1") != "0":
                try:
                    # Fast feed (not real-time): Transcribe finalizes the opening turns a beat after it
                    # receives them, so a quick feed surfaces them live/early; real-time bunches them late.
                    await _transcribe_streaming(session_id, stream_ref, vocab,
                                                cap_seconds=_DEMO_SECONDS, realtime=False)
                except Exception as exc:  # noqa: BLE001 — the live preview is decorative, never fatal
                    await publish(session_id, {"agent": AGENT, "status": "running", "error": str(exc),
                                               "step": "Live preview unavailable — transcribing the full consultation"})

            # 2) Full transcript via batch (authoritative, ~50s), revealed line-by-line below when it
            #    lands. Bounded retry: a failed job is usually transient — one re-attempt, never a loop.
            for attempt in (1, 2):
                try:
                    segments = await _transcribe_live(session_id, audio_ref, vocab)
                    source = "s3"
                    _save_cache(audio_ref, vocab, segments)
                    break
                except Exception as exc:  # noqa: BLE001 — surface, retry once, then fall back
                    segments = None
                    if attempt == 1:
                        await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                                   "step": "Transcribe failed — retrying the job once"})
                    else:
                        await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                                   "step": "Transcribe failed twice — falling back to the sample transcript"})

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

    # The full transcript (cache/batch/mock) arrives all-at-once → replay it line-by-line for the
    # "live capture" feel. After the hybrid's ~30s live preview, this is the seamless full reveal.
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


async def _transcribe_live(session_id: str, audio_ref: str, vocab=None, narrate: bool = True) -> list:
    """Start an AWS Transcribe pt-BR batch job with diarization, poll it (narrating progress), parse.
    narrate=False stays silent — used when batch runs in the background under the live-stream demo, so
    the cockpit narration is owned by the stream and these progress steps don't fight it."""
    async def say(step: str):
        if narrate:
            await publish(session_id, {"agent": AGENT, "status": "running", "step": step})

    await say("Locating audio in S3…")
    s3_uri = await asyncio.to_thread(_ensure_in_s3, audio_ref)

    job_name = f"miatec-scribe-{uuid.uuid4().hex[:12]}"
    vstep = " + pt-BR clinical vocabulary" if vocab else ""
    await say(f"Starting AWS Transcribe job (pt-BR, speaker diarization{vstep})…")
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
        await say(f"Transcribing on AWS… {elapsed}s elapsed (job {status.lower()})")
        await asyncio.sleep(3)

    if status == "FAILED":
        raise RuntimeError(job.get("FailureReason", "transcription failed"))

    await say("Parsing diarized transcript…")
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


# ── live streaming (AWS Transcribe StartStreamTranscription) ───────────────────
_PUNCT = {",", ".", "?", "!", ";", ":", "…"}


def _resolve_stream_ref(audio_ref: str):
    """Pick a PCM-WAV S3 ref to stream, or None (→ batch). Transcribe streaming needs raw PCM, not m4a.
    A .wav ref streams directly; the default demo m4a maps to its pre-converted WAV via STREAM_AUDIO_REF."""
    if audio_ref and audio_ref.lower().endswith(".wav"):
        return audio_ref
    sref = os.getenv("STREAM_AUDIO_REF")
    if sref and (audio_ref is None or audio_ref == os.getenv("DEFAULT_AUDIO_REF")):
        return sref
    return None


def _split_s3(uri: str) -> tuple:
    bucket, _, key = uri[len("s3://"):].partition("/")
    return bucket, key


def _join_words(words: list) -> str:
    out = ""
    for w in words:
        out += w if (w in _PUNCT and out) else ((" " if out else "") + w)
    return out


def _clean_segments(items: list) -> list:
    """Turn a flat list of streaming items into clean diarized turns: attach punctuation to the current
    turn, clamp to the two dominant speakers (streaming occasionally invents a third), merge adjacent
    same-speaker turns, and normalize labels to spk_N so the downstream Roles agent is unchanged."""
    runs: list = []  # {speaker, words[], scores[], start, end}
    for it in items:
        if it["kind"] == "punctuation":
            if runs:
                runs[-1]["words"].append(it["content"])
                if it["end"] is not None:
                    runs[-1]["end"] = it["end"]
            continue
        spk = it["speaker"]
        if not runs or (spk is not None and spk != runs[-1]["speaker"]):
            runs.append({"speaker": spk, "words": [], "scores": [], "start": it["start"], "end": it["end"]})
        r = runs[-1]
        r["words"].append(it["content"])
        if it["confidence"] is not None:
            r["scores"].append(it["confidence"])
        if r["start"] is None:
            r["start"] = it["start"]
        if it["end"] is not None:
            r["end"] = it["end"]

    if not runs:
        return []

    # Dominant two speakers by total speaking time; fold any stray third into the previous kept turn.
    dur: dict = {}
    for r in runs:
        if r["speaker"] is None:
            continue
        dur[r["speaker"]] = dur.get(r["speaker"], 0.0) + max((r["end"] or 0) - (r["start"] or 0), 0.1)
    top2 = set(sorted(dur, key=lambda k: dur[k], reverse=True)[:2])

    kept: list = []
    for r in runs:
        if not kept or r["speaker"] in top2 or r["speaker"] is None:
            kept.append(r)
        else:
            prev = kept[-1]
            prev["words"].extend(r["words"])
            prev["scores"].extend(r["scores"])
            if r["end"] is not None:
                prev["end"] = r["end"]

    merged: list = []
    for r in kept:
        if merged and merged[-1]["speaker"] == r["speaker"]:
            merged[-1]["words"].extend(r["words"])
            merged[-1]["scores"].extend(r["scores"])
            if r["end"] is not None:
                merged[-1]["end"] = r["end"]
        else:
            merged.append(r)

    out = []
    for r in merged:
        label = f"spk_{r['speaker']}" if r["speaker"] is not None else "spk_0"
        out.append(
            TranscriptSegment(
                speaker=label, speaker_label=label, text=_join_words(r["words"]),
                confidence=round(sum(r["scores"]) / len(r["scores"]), 2) if r["scores"] else 1.0,
                start=r["start"], end=r["end"],
            ).model_dump()
        )
    return out


async def _transcribe_streaming(session_id: str, wav_ref: str, vocab=None,
                                cap_seconds: int | None = None, realtime: bool = False) -> list:
    """Open a live AWS Transcribe stream, feed it the PCM WAV in paced chunks, and publish turns as they
    finalize (progressive load). Returns the final cleaned segments. Raises on any failure so run_scribe
    falls back to batch. Imports the streaming SDK lazily so a missing dep never breaks app boot.

    cap_seconds: feed only the first N seconds of audio, then end the stream (the demo preview).
    realtime: pace the feed to ~1x so the opening visibly 'captures' live (vs as-fast-as-allowed)."""
    import io
    import wave as wavemod

    from amazon_transcribe.client import TranscribeStreamingClient
    from amazon_transcribe.handlers import TranscriptResultStreamHandler

    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": "Opening a live AWS Transcribe stream (pt-BR, diarization)…"})
    bucket, key = _split_s3(wav_ref)
    raw = await asyncio.to_thread(lambda: client("s3").get_object(Bucket=bucket, Key=key)["Body"].read())
    wf = wavemod.open(io.BytesIO(raw), "rb")
    if wf.getnchannels() != 1 or wf.getframerate() != 16000 or wf.getsampwidth() != 2:
        raise RuntimeError(f"stream audio must be 16kHz mono PCM s16le (got "
                           f"{wf.getnchannels()}ch/{wf.getframerate()}Hz/{wf.getsampwidth()*8}bit)")
    pcm = wf.readframes(wf.getnframes())

    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-west-2"
    tclient = TranscribeStreamingClient(region=region)
    kwargs = dict(language_code="pt-BR", media_sample_rate_hz=16000, media_encoding="pcm",
                  show_speaker_label=True)
    if vocab:
        kwargs["vocabulary_name"] = vocab
    stream = await tclient.start_stream_transcription(**kwargs)

    items: list = []
    last_pub = [0.0]

    async def _emit():
        last_pub[0] = time.monotonic()
        segs = _clean_segments(items)
        await publish(session_id, {"agent": AGENT, "status": "streaming",
                                   "step": f"Transcribing live… {len(segs)} turns",
                                   "transcript": segs})

    class _Handler(TranscriptResultStreamHandler):
        async def handle_transcript_event(self, event):  # noqa: D401
            changed = False
            for result in event.transcript.results:
                if result.is_partial:
                    continue
                alt = (result.alternatives or [None])[0]
                if not alt:
                    continue
                for it in (alt.items or []):
                    items.append({
                        "content": it.content,
                        "speaker": getattr(it, "speaker", None),
                        "confidence": it.confidence,
                        "start": it.start_time,
                        "end": it.end_time,
                        "kind": "punctuation" if it.item_type == "punctuation" else "pronunciation",
                    })
                    changed = True
            # Coalesce: only re-clean + publish a few times a second, never on every event — the clean
            # over a growing list is what otherwise starves the feed coroutine.
            if changed and (time.monotonic() - last_pub[0]) * 1000 >= _STREAM_PUBLISH_MS:
                await _emit()

    async def _writer():
        chunk = max(2, int(16000 * 2 * _STREAM_CHUNK_MS / 1000))  # bytes per ~_STREAM_CHUNK_MS of PCM
        cap_bytes = int(16000 * 2 * cap_seconds) if cap_seconds else None
        pacing = (_STREAM_CHUNK_MS / 1000.0) if realtime else _STREAM_PACING  # ~1x feed if realtime
        sent = 0
        for off in range(0, len(pcm), chunk):
            buf = pcm[off:off + chunk]
            await stream.input_stream.send_audio_event(audio_chunk=buf)
            sent += len(buf)
            if cap_bytes and sent >= cap_bytes:  # demo preview: stop after the opening N seconds
                break
            if pacing > 0:
                await asyncio.sleep(pacing)
        await stream.input_stream.end_stream()

    await asyncio.gather(_writer(), _Handler(stream.output_stream).handle_events())
    if items:
        await _emit()  # final live frame so the cockpit shows the full transcript before "done"

    segments = _clean_segments(items)
    if not segments:
        raise RuntimeError("stream produced no segments")
    return segments


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
