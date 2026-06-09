"""LLM helper — Claude via the Anthropic API (preferred) or a model on Amazon Bedrock.

Resolution order, so the same agents work in any environment:
  1. ANTHROPIC_API_KEY set            → direct Anthropic API (Claude)
  2. AWS creds + BEDROCK_MODEL_ID set → Amazon Bedrock via the Converse API
                                        (this workshop account allows Amazon models → Nova Pro)
  3. neither                          → not configured; agents fall back to their stubs

Why Converse for Bedrock: it's the unified message API, so one code path serves Amazon Nova now and
Claude-on-Bedrock on any account that allows it. Function names keep the `claude_` prefix because
Claude is the intended/upgrade model; the Bedrock path runs whatever BEDROCK_MODEL_ID names. SDKs
import lazily so the app boots without them.
"""
from __future__ import annotations

import json
import os
from typing import Any

from app.aws import aws_configured, client


def anthropic_configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def bedrock_configured() -> bool:
    return aws_configured() and bool(os.getenv("BEDROCK_MODEL_ID"))


def claude_configured() -> bool:
    return anthropic_configured() or bedrock_configured()


def claude_messages(system: str, messages: list, max_tokens: int = 1024, temperature: float = 0.2) -> str:
    """Call the LLM (Anthropic API first, else Bedrock Converse) → concatenated text."""
    if anthropic_configured():
        return _via_anthropic(system, messages, max_tokens, temperature)
    return _via_bedrock(system, messages, max_tokens, temperature)


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
