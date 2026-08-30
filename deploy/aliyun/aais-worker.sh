#!/usr/bin/env bash
set -Eeuo pipefail

worker_kind="${1:-}"
worker_env_file="${AAIS_WORKER_ENV_FILE:-/run/aais/current/worker.env}"
active_deployment_file="${AAIS_STATE_FILE:-/opt/aais/state/active-deployment.env}"
rotation_pending_file="${AAIS_ROTATION_PENDING_FILE:-/opt/aais/state/secret-rotation.pending}"
if [[ -e "$rotation_pending_file" ]]; then
  echo "AAIS worker is blocked by a pending secret rotation." >&2
  exit 1
fi
if [[ ! -r "$worker_env_file" ]]; then
  echo "AAIS worker environment is unavailable." >&2
  exit 1
fi
worker_mode="$(stat -c '%a' "$worker_env_file")"
worker_owner="$(stat -c '%u' "$worker_env_file")"
if [[ "$worker_owner" != "0" || "$worker_mode" != "440" ]]; then
  echo "AAIS worker environment must be root-owned with mode 0440." >&2
  exit 1
fi
active_bundle_mode="$(stat -c '%a' "$active_deployment_file" 2>/dev/null || true)"
active_bundle_owner="$(stat -c '%u' "$active_deployment_file" 2>/dev/null || true)"
active_bundle="$(awk -F= '
  $1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" {
    count += 1
    value = substr($0, index($0, "=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$active_deployment_file" 2>/dev/null || true)"
worker_bundle="$(awk -F= '
  index($0, "AAIS_SECRET_BUNDLE_VERSION=") == 1 {
    count += 1
    value = substr($0, length("AAIS_SECRET_BUNDLE_VERSION=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$worker_env_file")"
if [[ "$active_bundle_owner" != "0" || "$active_bundle_mode" != "644" \
  || ! "$worker_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
  || "$worker_bundle" != "$active_bundle" ]]; then
  echo "AAIS worker secret bundle does not match the active deployment." >&2
  exit 1
fi
case "$worker_kind" in
  lrs)
    token_key="AAIS_LRS_OUTBOX_FLUSH_TOKEN"
    path="/api/learning/lrs/outbox/flush"
    ;;
  email)
    token_key="AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"
    path="/api/auth/email-outbox/flush"
    ;;
  *)
    echo "AAIS worker kind must be lrs or email." >&2
    exit 1
    ;;
esac

token="$(awk -v key="$token_key" '
  index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
  END { if (count != 1) exit 1; print value }
' "$worker_env_file")"

if (( ${#token} < 32 )); then
  echo "AAIS worker token is unavailable." >&2
  exit 1
fi

response="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
  | curl --config - \
      --fail-with-body \
      --silent \
      --show-error \
      --connect-timeout 5 \
      --max-time 90 \
      --request POST \
      --resolve www.aais.site:443:127.0.0.1 \
      "https://www.aais.site${path}")"
if [[ "$response" == *'"status":"standby"'* ]]; then
  echo "AAIS worker did not acquire runtime leadership." >&2
  exit 75
fi
unset response token
