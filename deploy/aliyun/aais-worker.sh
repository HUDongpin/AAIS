#!/usr/bin/env bash
set -Eeuo pipefail

worker_kind="${1:-}"
worker_env_file="${AAIS_WORKER_ENV_FILE:-/run/aais/current/worker.env}"
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
