#!/usr/bin/env bash
# One-shot: provision the miatec staging store (DynamoDB) + task-role access + task-def env var.
# Needs FRESH Workshop Studio creds in the environment (export AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN)
# or in .env at the repo root. Idempotent — safe to re-run.
set -euo pipefail

# Creds: prefer the repo .env (Workshop Studio export block pasted there). The ~/.aws files on this
# machine contain pasted `export` lines that break the CLI parser — bypass them for this process.
ROOT_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "${ROOT_ENV}" ]; then
  set -a; eval "$(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)=' "${ROOT_ENV}")"; set +a
fi
if grep -qs 'export' ~/.aws/config 2>/dev/null; then
  export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
fi

REGION="${AWS_REGION:-us-west-2}"
TABLE="${MIATEC_TABLE:-miatec-encounters}"
ROLE="miatecTaskRole"
CLUSTER="miatec"
SERVICE="miatec-copilot"
FAMILY="miatec-copilot"

echo "→ Using identity:"
aws sts get-caller-identity --output table
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "→ 1/3 DynamoDB table ${TABLE} (${REGION})"
if aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1; then
  echo "   already exists — skipping create"
else
  aws dynamodb create-table \
    --table-name "${TABLE}" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "${REGION}" >/dev/null
  aws dynamodb wait table-exists --table-name "${TABLE}" --region "${REGION}"
  echo "   created"
fi

echo "→ 2/3 Task-role policy ${ROLE}/miatecDynamoWrite"
aws iam put-role-policy --role-name "${ROLE}" --policy-name miatecDynamoWrite \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"dynamodb:PutItem\", \"dynamodb:GetItem\"],
      \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}\"
    }]
  }"
echo "   attached"

echo "→ 3/3 Ensure MIATEC_TABLE=${TABLE} in the ${FAMILY} task definition"
command -v jq >/dev/null || { echo "   jq required (brew install jq)"; exit 1; }
TD=$(aws ecs describe-task-definition --task-definition "${FAMILY}" --region "${REGION}" \
     --query taskDefinition --output json)
if echo "${TD}" | jq -e '.containerDefinitions[0].environment[] | select(.name=="MIATEC_TABLE")' >/dev/null; then
  echo "   already present — no new revision needed"
else
  NEW_TD=$(echo "${TD}" | jq --arg t "${TABLE}" '
    .containerDefinitions[0].environment += [{"name":"MIATEC_TABLE","value":$t}]
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
          .registeredAt, .registeredBy)')
  REV=$(aws ecs register-task-definition --region "${REGION}" --cli-input-json "${NEW_TD}" \
        --query 'taskDefinition.revision' --output text)
  aws ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
    --task-definition "${FAMILY}:${REV}" --region "${REGION}" >/dev/null
  echo "   registered ${FAMILY}:${REV} and updated the service (rollout in progress)"
fi

echo "✓ done — the Record agent now has a real table to write to."
