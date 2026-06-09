"""pt-BR clinical custom vocabulary for AWS Transcribe.

The biggest transcription failure mode in a medical consult is not background noise (denoising it
actually HURT confidence in our A/B test) — it's DOMAIN WORDS: Brazilian drug names and clinical terms
that a general ASR model mangles. AWS Transcribe supports a native **custom vocabulary** that biases
recognition toward a known term list. This module curates that list and provisions it.

Usage:
    python -m app.vocab                 # create/refresh the vocabulary and wait until READY
    TRANSCRIBE_VOCABULARY_NAME=...       # Scribe passes this to the transcription job when READY

Idempotent: re-running updates the term list in place. If the workshop account denies vocabulary APIs,
ensure_vocabulary() raises and Scribe simply transcribes without it (graceful — the demo still runs).
"""
from __future__ import annotations

import os
import time

from app.aws import client

DEFAULT_NAME = os.getenv("TRANSCRIBE_VOCABULARY_NAME", "miatec-ptbr-clinical")
LANGUAGE = "pt-BR"

# Curated pt-BR clinical terms. Multi-word phrases are hyphen-joined per Transcribe's list format.
# Lowercase to match natural speech; the Structuring LLM normalizes capitalization for the note.
PHRASES = [
    # ── medications (Brazilian generics/brands) ──
    "losartana", "hidroclorotiazida", "anlodipino", "enalapril", "captopril", "atenolol",
    "propranolol", "carvedilol", "metoprolol", "espironolactona", "furosemida", "hidralazina",
    "isossorbida", "sinvastatina", "atorvastatina", "rosuvastatina", "ezetimiba",
    "metformina", "glibenclamida", "gliclazida", "insulina", "empagliflozina",
    "omeprazol", "pantoprazol", "ranitidina", "dipirona", "paracetamol", "ibuprofeno",
    "nimesulida", "amoxicilina", "azitromicina", "cefalexina", "ciprofloxacino",
    "sertralina", "fluoxetina", "escitalopram", "clonazepam", "diazepam", "alprazolam",
    "passiflora", "levotiroxina", "prednisona", "prednisolona", "salbutamol", "budesonida",
    "loratadina", "ácido-acetilsalicílico", "ácido-fólico", "sulfato-ferroso", "varfarina",
    "clopidogrel", "digoxina", "espironolactona",
    # ── exams / labs ──
    "eletrocardiograma", "ecocardiograma", "holter", "troponina", "hemograma", "glicemia",
    "hemoglobina-glicada", "creatinina", "ureia", "colesterol", "triglicerídeos", "potássio",
    # ── signs / symptoms / conditions ──
    "dispneia", "taquicardia", "bradicardia", "palpitação", "palpitações", "hipertensão",
    "hipotensão", "síncope", "pré-síncope", "vertigem", "tontura", "cefaleia", "ansiedade",
    "dislipidemia", "ausculta", "sopro", "edema", "dispepsia", "refluxo", "isquemia",
    "arritmia", "fibrilação", "extrassístole", "angina", "dor-torácica",
    # ── descriptors / drug classes ──
    "betabloqueador", "anti-hipertensivo", "ansiolítico", "fitoterápico", "anti-inflamatório",
    "diurético", "sinusal",
]


def ensure_vocabulary(name: str = DEFAULT_NAME, *, wait: bool = True, timeout_s: int = 240) -> str:
    """Create or refresh the custom vocabulary; optionally block until READY. Returns its state.

    Idempotent: updates the phrase list if the vocabulary already exists. Raises on API errors (e.g.
    the account denies Transcribe vocabulary APIs) so the caller can decide to proceed without it.
    """
    tc = client("transcribe")

    exists = True
    try:
        tc.get_vocabulary(VocabularyName=name)
    except Exception:  # noqa: BLE001 — not-found (BadRequest/NotFound) → create fresh
        exists = False

    if exists:
        tc.update_vocabulary(VocabularyName=name, LanguageCode=LANGUAGE, Phrases=PHRASES)
    else:
        tc.create_vocabulary(VocabularyName=name, LanguageCode=LANGUAGE, Phrases=PHRASES)

    state = "PENDING"
    deadline = time.monotonic() + timeout_s
    while wait:
        info = tc.get_vocabulary(VocabularyName=name)
        state = info["VocabularyState"]
        if state in ("READY", "FAILED"):
            if state == "FAILED":
                raise RuntimeError(f"vocabulary {name} FAILED: {info.get('FailureReason')}")
            break
        if time.monotonic() > deadline:
            break  # still PENDING — caller can poll later; Scribe only uses it once READY
        time.sleep(5)
    return state


def vocabulary_if_ready(name=None):
    """Return the vocabulary name iff it exists and is READY, else None (never raises).

    Resolves the name at CALL time (after .env is loaded). Set TRANSCRIBE_VOCABULARY_NAME="" to disable.
    """
    if name is None:
        name = os.getenv("TRANSCRIBE_VOCABULARY_NAME", "miatec-ptbr-clinical")
    if not name:
        return None
    try:
        if client("transcribe").get_vocabulary(VocabularyName=name)["VocabularyState"] == "READY":
            return name
    except Exception:  # noqa: BLE001 — missing/denied → just transcribe without it
        return None
    return None


if __name__ == "__main__":
    from dotenv import find_dotenv, load_dotenv

    load_dotenv(find_dotenv(usecwd=True))
    n = os.getenv("TRANSCRIBE_VOCABULARY_NAME", DEFAULT_NAME)
    print(f"Provisioning Transcribe vocabulary '{n}' ({len(PHRASES)} terms, {LANGUAGE})…")
    print("state:", ensure_vocabulary(n, wait=True))
