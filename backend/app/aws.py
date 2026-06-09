"""AWS helpers (lazy boto3).

Credentials come from the standard chain: env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
loaded from .env), an AWS_PROFILE, or ~/.aws. If nothing is configured the agents fall back to their
stubs, so the demo always runs. boto3 is imported lazily so the app boots without it installed.
"""
from __future__ import annotations

import os
from functools import lru_cache


def aws_configured() -> bool:
    """True if some AWS credential source is present.

    Covers static env keys, a named profile, ~/.aws — AND the container/instance role case (ECS
    Fargate task role, EKS, or EC2 instance profile), where boto3 auto-resolves rotating creds from
    the container-credentials endpoint or IMDS and there are NO static keys or ~/.aws on disk. Without
    this last check the agents silently fall back to their stubs when deployed on Fargate.
    """
    if os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY"):
        return True
    if os.getenv("AWS_PROFILE"):
        return True
    # ECS/Fargate or EKS task role → creds come from the container credentials endpoint.
    if os.getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") or os.getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        return True
    return os.path.exists(os.path.expanduser("~/.aws/credentials"))


def region() -> str:
    return os.getenv("AWS_REGION", "us-east-1")


@lru_cache(maxsize=8)
def client(service: str):
    """Cached boto3 client. Raises ImportError if boto3 isn't installed (pip install boto3)."""
    import boto3  # lazy — keep module import boto3-free
    return boto3.client(service, region_name=region())
