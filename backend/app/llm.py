"""LLM helper — one interface over the Vercel AI Gateway, the Anthropic API, or Amazon Bedrock.

Resolution order, so the same agents work in any environment:
  1. AI_GATEWAY_API_KEY set           → Vercel AI Gateway (OpenAI-compatible; satisfies the NEXT
                                        Hackathon "integrate a Vercel AI product" requirement)
  2. ANTHROPIC_API_KEY set            → direct Anthropic API (Claude)
  3. AWS creds + BEDROCK_MODEL_ID set → Amazon Bedrock via the Converse API
                                        (this workshop account allows Amazon models → Nova Pro)
  4. none                             → not configured; agents fall back to their stubs

The Gateway routes through the official `openai` SDK pointed at https://ai-gateway.vercel.sh/v1, so one
`creator/model-name` string (e.g. anthropic/claude-opus-4.8) switches providers and every call shows up
in the Gateway dashboard. Why Converse for Bedrock: it's the unified message API, so one code path
serves Amazon Nova now and Claude-on-Bedrock on any account that allows it. Function names keep the
`claude_` prefix because Claude is the intended model; each path runs whatever its model id names. SDKs
import lazily so the app boots without them.
"""
from __future__ import annotations

import json
import os
from typing import Any

from app.aws import aws_configured, client


def gateway_configured() -> bool:
    return bool(os.getenv("AI_GATEWAY_API_KEY"))


def anthropic_configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def bedrock_configured() -> bool:
    return aws_configured() and bool(os.getenv("BEDROCK_MODEL_ID"))


def claude_configured() -> bool:
    return gateway_configured() or anthropic_configured() or bedrock_configured()


def claude_messages(system: str, messages: list, max_tokens: int = 1024, temperature: float = 0.2) -> str:
    """Call the LLM → concatenated text, FALLING THROUGH providers on failure.

    Order: Vercel AI Gateway → Anthropic API → Amazon Bedrock (Nova). The Gateway is preferred (it's the
    Vercel AI-product integration); when it can't serve — free-tier model block / rate-limit / no
    credits — we fall through to **Bedrock Nova** (free, runs on AWS) so the agents keep working. Same
    key can stay set: add Gateway credits and it's used automatically; without them, Nova carries the
    demo. Each provider raises on failure and we try the next; the last error surfaces if all fail.
    """
    last_exc = None
    if gateway_configured():
        try:
            return _via_vercel_gateway(system, messages, max_tokens, temperature)
        except Exception as exc:  # noqa: BLE001 — gateway blocked/down → fall through to the next provider
            last_exc = exc
    if anthropic_configured():
        try:
            return _via_anthropic(system, messages, max_tokens, temperature)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    if bedrock_configured():
        return _via_bedrock(system, messages, max_tokens, temperature)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("no LLM provider configured (set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, or BEDROCK_MODEL_ID)")


def claude_json(system: str, user: str, max_tokens: int = 1500, temperature: float = 0.2) -> Any:
    """Ask the LLM for strict JSON, strip any code fences, parse and return it (dict or list).

    `temperature` is threaded through so callers can pin it (e.g. Considerations uses 0 to cut Nova's
    run-to-run ranking variance).
    """
    text = claude_messages(system, [{"role": "user", "content": user}],
                           max_tokens=max_tokens, temperature=temperature).strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    return json.loads(text)


def _via_vercel_gateway(system: str, messages: list, max_tokens: int, temperature: float) -> str:
    """Route through the Vercel AI Gateway's OpenAI-compatible endpoint. One `creator/model-name`
    string (GATEWAY_MODEL, e.g. anthropic/claude-opus-4.8) picks the provider; every call is visible
    in the Vercel AI Gateway dashboard — the demoable proof of the Vercel integration.
    """
    from openai import OpenAI  # lazy
    cli = OpenAI(api_key=os.getenv("AI_GATEWAY_API_KEY"),
                 base_url="https://ai-gateway.vercel.sh/v1")  # OpenAI path — keep the /v1
    # Our messages are already {"role": ..., "content": "<str>"}; fold the system prompt in as a
    # leading system message (the OpenAI chat shape).
    oai_messages = ([{"role": "system", "content": system}] if system else []) + messages
    resp = cli.chat.completions.create(
        model=os.getenv("GATEWAY_MODEL", "anthropic/claude-sonnet-4.6"),  # full creator/model-name id
        messages=oai_messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


def _via_anthropic(system: str, messages: list, max_tokens: int, temperature: float) -> str:
    import anthropic  # lazy
    cli = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) from env
    resp = cli.messages.create(
        model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        system=system,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return "".join(block.text for block in resp.content if block.type == "text")


def _via_bedrock(system: str, messages: list, max_tokens: int, temperature: float) -> str:
    # Convert Anthropic-style messages ({"content": "<str>"}) to Bedrock Converse content blocks.
    converse_messages = [{"role": m["role"], "content": [{"text": m["content"]}]} for m in messages]
    kwargs = {
        "modelId": os.environ["BEDROCK_MODEL_ID"],
        "messages": converse_messages,
        "inferenceConfig": {"maxTokens": max_tokens, "temperature": temperature},
    }
    if system:
        kwargs["system"] = [{"text": system}]
    resp = client("bedrock-runtime").converse(**kwargs)
    return "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
