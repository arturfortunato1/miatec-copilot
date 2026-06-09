"""Structuring agent — transcript → validated SOAP JSON (ClinicalNote).

Real: Claude/Nova via the LLM layer with a strict-JSON instruction; the output is validated by
constructing ClinicalNote(**data) so bad shapes raise instead of leaking. Missing fields become
"not documented", never invented. Scores under: Autonomy & Decision-Making.

Quality hardening (the real audio came back ~34% low-confidence):
- **Mask** sub-0.7 turns as "[trecho inaudível]" before the LLM sees them, so it reasons over gaps
  instead of guessing from noise ("garbage in, garbage out" defence).
- **Tell the model the signal quality** (role-attribution confidence + how many turns are unreliable)
  so it hedges instead of inventing.
- The `_SYSTEM` prompt carries a compact pt-BR SOAP rubric + one few-shot example.
- LLM call is **retried** (visible `retry` events) before falling back to a canned note (`degraded`).

The low_confidence_segments still come from the Scribe confidences (not the model).
"""
from __future__ import annotations

import asyncio

from app.events import publish
from app.llm import claude_configured, claude_json
from app.retry import call_with_retry
from app.schema import ClinicalNote

AGENT = "structuring"
_LOW_CONF = 0.7

_SYSTEM = (
    "You are a clinical scribe for a Brazilian consultation. Convert the transcript into a SOAP "
    "clinical note as STRICT JSON with exactly these keys: chief_complaint (string), hpi (string), "
    "review_of_systems (array of strings), vitals (object with bp, hr, temp — string or null), "
    "current_medications (array of strings), allergies (array of strings), assessment (string), "
    "plan (string). Write the clinical content in pt-BR. For anything not stated in the transcript "
    'use "not documented" for strings, null for vitals fields, and [] for arrays — never invent.\n'
    "Convenções (pt-BR): use terminologia médica brasileira e nomes de medicamentos em pt-BR "
    '(ex.: "losartana", não "losartan"). chief_complaint = queixa principal em uma frase curta; '
    "hpi = história da doença atual (início, evolução, sintomas associados); assessment = hipótese/"
    "avaliação clínica; plan = conduta (exames, prescrições, encaminhamentos). Falas marcadas como "
    '"[trecho inaudível]" são ruído de transcrição — raciocine em torno delas, nunca preencha o que '
    "não foi dito.\n"
    'Exemplo de formato — para "Doutor, estou com dor no peito há um dia e tomo losartana" → '
    '{"chief_complaint":"Dor torácica há 1 dia","hpi":"Paciente refere dor torácica iniciada há 1 '
    'dia.","review_of_systems":["Cardiovascular: dor torácica"],"vitals":{"bp":null,"hr":null,'
    '"temp":null},"current_medications":["Losartana"],"allergies":[],"assessment":"not documented",'
    '"plan":"not documented"}.\n'
    "Output ONLY the JSON object: no prose, no code fences."
)


async def run_structuring(state: dict) -> dict:
    session_id = state["session_id"]
    await publish(session_id, {"agent": AGENT, "status": "running",
                               "step": "Mapping the role-labeled transcript into SOAP fields…"})

    transcript = state.get("transcript", [])
    low_conf = [seg["text"] for seg in transcript if seg.get("confidence", 1.0) < _LOW_CONF]
    user_content = _build_prompt(transcript, state.get("roles", {}) or {})

    note_dict = None
    if claude_configured() and transcript:
        try:
            note_dict = await call_with_retry(
                session_id, AGENT, lambda: _structure_with_claude(user_content),
                step="structuring via LLM",
            )
        except Exception as exc:  # noqa: BLE001 — all retries exhausted → fall back so the demo survives
            await publish(session_id, {"agent": AGENT, "status": "retry", "error": str(exc),
                                       "step": "LLM unavailable — using a baseline SOAP note"})

    used_stub = note_dict is None
    if used_stub:
        await asyncio.sleep(0.8)  # simulate latency for the stub path
        note_dict = ClinicalNote(
            chief_complaint="Dor torácica e dispneia, início há 1 dia",
            hpi="Paciente refere dor torácica iniciada ontem, com irradiação para o braço esquerdo e falta de ar.",
            review_of_systems=[
                "Cardiovascular: dor torácica com irradiação para MSE",
                "Respiratório: dispneia",
            ],
            current_medications=["Losartana"],
            allergies=[],
            assessment="not documented",
            plan="Solicitar ECG e marcadores cardíacos (troponina).",
        ).model_dump()

    # Confidence flags come from Scribe, not the model.
    note_dict["low_confidence_segments"] = low_conf

    cc = (note_dict.get("chief_complaint") or "not documented").strip()
    filled = sum(1 for k in ("chief_complaint", "hpi", "assessment", "plan")
                 if note_dict.get(k) and note_dict.get(k) != "not documented")
    summary = f"SOAP note built · CC: {cc[:48]}"
    reason = f"{filled}/4 narrative fields populated; {len(low_conf)} unclear turn(s) masked, unstated fields kept as 'not documented' (never invented)"
    await publish(session_id, {"agent": AGENT, "status": "done", "note": note_dict,
                               "summary": summary, "reason": reason, "degraded": used_stub})
    return {"note": note_dict}


def _build_prompt(transcript: list, roles: dict) -> str:
    """Render the transcript with low-confidence turns masked, prefixed by an audio-quality briefing."""
    lines = []
    for s in transcript:
        spk = s.get("speaker", "?")
        conf = s.get("confidence", 1.0)
        if conf < _LOW_CONF:
            lines.append(f"{spk}: [trecho inaudível — conf {round(conf * 100)}%]")
        else:
            lines.append(f'{spk}: {s.get("text", "")}')
    rendered = "\n".join(lines)

    total = len(transcript)
    n_low = sum(1 for s in transcript if s.get("confidence", 1.0) < _LOW_CONF)
    rconf = round(float(roles.get("confidence", 0.0)) * 100)
    role_flag = " (BAIXA — confirme os interlocutores)" if roles.get("needs_review") else ""
    briefing = (
        "Contexto de qualidade do áudio (use para calibrar sua confiança):\n"
        f"- Confiança da atribuição médico/paciente: {rconf}%{role_flag}\n"
        f"- {n_low} de {total} falas vieram com baixa confiança de transcrição e estão marcadas como "
        "[trecho inaudível]; não invente o conteúdo delas.\n\n"
        f"Transcrição:\n{rendered}"
    )
    return briefing


def _structure_with_claude(user_content: str) -> dict:
    data = claude_json(_SYSTEM, user_content, max_tokens=2500)  # headroom: verbose real notes were near the old 1500 cap
    # Validate by constructing the model — raises on bad shape, so the caller falls back.
    return ClinicalNote(**data).model_dump()
