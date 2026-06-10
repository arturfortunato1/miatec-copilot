#!/usr/bin/env bash
# Rebuild + push the backend image and roll the ECS service (see docs/INTEGRATIONS.md).
# Needs FRESH Workshop Studio creds. Always builds linux/amd64 (Apple Silicon host).
set -euo pipefail

# Creds: prefer the repo .env; bypass the broken ~/.aws files (pasted `export` lines) for this process.
ROOT_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "${ROOT_ENV}" ]; then
  set -a; eval "$(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)=' "${ROOT_ENV}")"; set +a
fi
if grep -qs 'export' ~/.aws/config 2>/dev/null; then
  export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
fi

REGION="${AWS_REGION:-us-west-2}"
CLUSTER="miatec"
SERVICE="miatec-copilot"
REPO="miatec-copilot"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}"

echo "→ Login to ECR"
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "→ Build (linux/amd64)"
docker build --platform linux/amd64 --provenance=false -t "${REPO}" "${ROOT}/backend/"

echo "→ Push ${ECR}:latest"
docker tag "${REPO}:latest" "${ECR}:latest"
docker push "${ECR}:latest"

echo "→ Roll the service"
aws ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
  --force-new-deployment --region "${REGION}" >/dev/null
aws ecs wait services-stable --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}"

echo "✓ stable. Remember: fresh task = COLD Scribe cache — warm it before demoing:"
echo "  curl -X POST https://d1g2v6wxyaxkjl.cloudfront.net/ingest -H 'content-type: application/json' \\"
echo "       -d '{\"session_id\":\"warmup\"}'"
