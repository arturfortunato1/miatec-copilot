"""AWS helpers (lazy boto3).

Credentials come from the standard chain: env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
loaded from .env), an AWS_PROFILE, or ~/.aws. If nothing is configured the agents fall back to their
stubs, so the demo always runs. boto3 is imported lazily so the app boots without it installed.
"""
from __future__ import annotations

import os
from functools import lru_cache


def aws_configured() -> bool:
    """True if some AWS credential source is present."""
    if os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY"):
        return True
    if os.getenv("AWS_PROFILE"):
        return True
    return os.path.exists(os.path.expanduser("~/.aws/credentials"))


def region() -> str:
    return os.getenv("AWS_REGION", "us-east-1")


@lru_cache(maxsize=8)
def client(service: str):
    """Cached boto3 client. Raises ImportError if boto3 isn't installed (pip install boto3)."""
    import boto3  # lazy — keep module import boto3-free
    return boto3.client(service, region_name=region())
