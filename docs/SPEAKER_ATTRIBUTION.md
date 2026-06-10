# Speaker attribution — getting "who said what" right

> Foundational for the whole pipeline. If the system thinks the patient's symptom report came from
> the doctor, every downstream agent reasons over corrupted input — **garbage in, garbage out**. This
> is how miatec copilot makes speaker attribution *assertive*, and how it degrades safely when it isn't.

## The problem is actually two problems

1. **Separation** — *"is this utterance voice A or voice B?"* Acoustic diarization. Imperfect on noisy
   or single-channel audio; the model can merge or split speakers, and gives **no confidence score** on
   the speaker label itself.
2. **Role assignment** — *"which voice is the doctor vs the patient?"* The transcriber only emits
   anonymous labels (`spk_0`, `spk_1`). Deciding which is the clinician is a *separate inference*.

A naive system maps "first speaker = doctor." That's a coin flip dressed up as a fact — and it
silently poisons the SOAP note.

## How we solve it — three layers

### A — Reasoned role assignment (not a position guess) → the **Roles agent**
After Scribe diarizes (spk_0 / spk_1), a dedicated **Roles agent** reads the turns and decides which
label is the clinician from *content*: who takes the history and asks questions, who reports symptoms
and answers, who gives the assessment and prescribes. LLMs are reliable at this even when separation
is imperfect. It emits a **mapping + confidence + one-line rationale** — a legible, auditable decision,
not a hidden heuristic.

`backend/app/agents/roles.py` · graph: `scribe → roles → structuring → evidence → verifier → considerations → ⏸ → record`

### B — Confidence gate + human-in-the-loop → the **assertiveness guarantee**
You can't *prove* acoustic diarization is correct, so we don't pretend to — we **measure and gate**:
- **High confidence** (≥ 0.75) → auto-accept; the pipeline continues.
- **Low / ambiguous** → `needs_review` trips, and the doctor confirms or **swaps doctor↔patient with
  one click** at the human-in-the-loop gate (`POST /roles`), which **re-derives the note** from the
  corrected transcript.

The human confirmation *is* the guarantee. This is decision-support discipline: the AI proposes with a
calibrated confidence; the clinician owns the call exactly when it's uncertain.

### C — The definite production solution → **dual-channel capture**
Acoustic diarization is the fragile part. In a real clinic you remove the guessing entirely: record
the doctor and patient on **separate audio channels** (two lapel mics, or two phones → stereo). AWS
Transcribe `ChannelIdentification` then transcribes each channel independently — **separation is
deterministic (channel = speaker)** and the role is **known at capture time** (the doctor's mic is
channel 0). Near-100% attribution, no inference required. **This is the shipping recommendation.**

## Why it scores on the rubric
- **Autonomy & Decision-Making** — the Roles agent makes an explicit, reasoned, auditable decision.
- **Failure Handling** — a *named, engineered* fallback (low confidence → human review) instead of silent error.
- **Human-in-the-Loop** — one-click confirm/swap that actually re-derives downstream state.
- **Orchestration** — a distinct, legible node in the agent graph, not a buried heuristic.

## Slide-ready framing
- **Hook:** "Most ambient scribes *guess* who's talking. A wrong guess corrupts the entire note."
- **Our answer:** **reason it** (A) → **gate it on confidence with a human** (B) → and in production,
  **don't guess at all** (C: one channel per speaker).
- **Proof on real audio** (*Atendimento #2*, a 9.8-min pt-BR consultation): the Roles agent assigned
  `spk_0 → doctor, spk_1 → patient` at **0.95 confidence**, rationale: *"spk_0 takes the history, asks
  questions, and gives the assessment, while spk_1 reports symptoms and answers."* Role assignment was
  solid; the **separation** itself still had per-segment noise on the single-channel phone recording —
  which is exactly why **C (one channel per speaker)** is the production answer.
