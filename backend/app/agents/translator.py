"""Translate agent — normalize the pt-BR transcript into clinical English.

The consultation is captured in Brazilian Portuguese (the patient's language); the pipeline works in
English (the demo's and the record's language). This agent sits between Scribe and Roles and adds a
`text_en` to every segment — the ORIGINAL `text` is always preserved so the clinician can toggle back
to it. Everything downstream (Roles, Structuring, Evidence, Verifier, Considerations) then reasons
over the English text, so the whole encounter reads in one language.

Real: Claude/Nova via the LLM layer, translating in batches (one call per ~25 turns) with progress
narrated over SSE. The parsed translation is cached per transcript-content hash under backend/.cache
so repeat demos are instant. Failure handling: if the LLM is unavailable, the original Portuguese is
kept (clearly flagged `degraded`) and the demo continues — translation is an enhancement, never a
blocker. Scores under: Actions & Tool Use.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import pathlib

from app.events import publish
from app.llm import claude_configured, claude_json
from app.retry import call_with_retry

AGENT = "translate"
_BATCH = 25
_CACHE_DIR = pathlib.Path(__file__).resolve().parents[2] / ".cache" / "translate"

_SYSTEM = (
    "You are a professional medical translator. Translate each numbered utterance of a Brazilian "
    "Portuguese doctor–patient consultation into natural clinical English. Translate utterance by "
    "utterance: never merge, split, summarize, or editorialize. Preserve hedges and colloquialisms "
    "naturally ('pressão alta' → 'high blood pressure'). Use international English drug names "
    "('losartana' → 'losartan'). If an utterance is a fragment or noise, translate it as the closest "
    'natural fragment. Output ONLY JSON: {"t": ["<english 1>", "<english 2>", ...]} with EXACTLY one '
    "item per input utterance, same order. No prose, no code fences."
)

# Canned translations for the no-keys stub transcript, so the zero-config demo still shows the beat.
_MOCK_EN = {
    "Bom dia, o que a senhora está sentindo?": "Good morning, what are you feeling?",
    "Doutor, estou com uma dor no peito desde ontem e falta de ar.":
        "Doctor, I've had chest pain since yesterday and shortness of breath.",
    "A dor irradia para o braço? Tem histórico de pressão alta?":
        "Does the pain radiate to your arm? Any history of high blood pressure?",
    "Irradia um pouco para o braço esquerdo. Tomo losartana pra pressão.":
        "It radiates a little to my left arm. I take losartan for my blood pressure.",
    "Vou pedir um eletrocardiograma e marcadores cardíacos.":
        "I'll order an electrocardiogram and cardiac markers.",
}


async def run_translate(state: dict) -> dict:
    session_id = state["session_id"]
    segments = state.get("transcript", []) or []
    if not segments:
        return {}
    total = len(segments)

    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": f"Translating {total} turns into clinical English…"})

    texts = [s.get("text", "") for s in segments]
    translations = _load_cache(texts)
    if translations is not None:
        await publish(session_id, {"agent": AGENT, "status": "running",
                                   "step": "Loaded cached translation — skipping re-translation"})
    elif claude_configured():
        try:
            translations = await _translate_live(session_id, texts)
            _save_cache(texts, translations)
        except Exception as exc:  # noqa: BLE001 — retries exhausted → keep the original language
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "LLM unavailable — keeping the original Portuguese"})
            translations = None
    else:
        # No-keys stub: canned English for the canned consult, so the demo never breaks.
        await asyncio.sleep(0.6)
        translations = [_MOCK_EN.get(t) for t in texts]
        if not any(translations):
            translations = None

    degraded = translations is None
    if not degraded:
        for seg, en in zip(segments, translations):
            if en:
                seg["text_en"] = en
        n_done = sum(1 for t in translations if t)
        summary = f"{n_done}/{total} turns translated to clinical English"
        reason = "pipeline normalized to English; the original pt-BR is preserved for review"
    else:
        summary = "translation unavailable — original Portuguese kept"
        reason = "the agents continue on the original text (failure handling)"

    await publish(session_id, {"agent": AGENT, "status": "done", "transcript": segments,
                               "summary": summary, "reason": reason, "degraded": degraded})
    return {"transcript": segments}


async def _translate_live(session_id: str, texts: list) -> list:
    """Translate in batches with visible progress; each batch is retried before the agent gives up."""
    out: list = []
    total = len(texts)
    for start in range(0, total, _BATCH):
        chunk = texts[start:start + _BATCH]
        batch_no = start // _BATCH + 1
        result = await call_with_retry(
            session_id, AGENT, lambda c=chunk: _translate_batch(c),
            step=f"translation batch {batch_no}",
        )
        out.extend(result)
        await publish(session_id, {"agent": AGENT, "status": "running",
                                   "step": f"Translating… {min(start + _BATCH, total)}/{total} turns"})
    return out


def _translate_batch(chunk: list) -> list:
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(chunk))
    # ~25 short turns ≈ well under 1k output tokens; generous budget so the JSON always closes.
    data = claude_json(_SYSTEM, numbered, max_tokens=2500, temperature=0)
    items = data.get("t") if isinstance(data, dict) else None
    if not isinstance(items, list) or len(items) != len(chunk):
        raise ValueError(f"expected {len(chunk)} translations, got {len(items) if isinstance(items, list) else 'none'}")
    return [str(t) for t in items]


# ── translation cache (per transcript content) ───────────────────────────────
def _cache_path(texts: list) -> pathlib.Path:
    digest = hashlib.sha1("\n".join(texts).encode("utf-8")).hexdigest()[:16]
    return _CACHE_DIR / f"{digest}.json"


def _load_cache(texts: list):
    path = _cache_path(texts)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) and len(data) == len(texts) else None
    except Exception:  # noqa: BLE001 — a corrupt cache should never break the run
        return None


def _save_cache(texts: list, translations: list) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(texts).write_text(json.dumps(translations, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 — caching is best-effort
        pass
