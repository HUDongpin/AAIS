#!/usr/bin/env bash
set -Eeuo pipefail

deploy_config_file="${AAIS_DEPLOY_CONFIG_FILE:-/etc/aais/deploy.env}"
if [[ ! -r "$deploy_config_file" \
  || "$(stat -c '%u' "$deploy_config_file" 2>/dev/null || true)" != "0" \
  || "$(stat -c '%a' "$deploy_config_file" 2>/dev/null || true)" != "600" ]]; then
  echo "AAIS deploy configuration must be root-owned with mode 0600." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$deploy_config_file"

email_timer="aais-email-outbox.timer"
lrs_timer="aais-lrs-outbox.timer"
state_file="${AAIS_STATE_FILE:-/opt/aais/state/active-color}"
operation_lock_file="${AAIS_OPERATION_LOCK_FILE:-/opt/aais/state/deploy.lock}"
deploy_wrapper="${AAIS_DEPLOY_WRAPPER:-/opt/aais/bin/aais-deploy.sh}"
bootstrap_wrapper="${AAIS_SECRETS_BOOTSTRAP_WRAPPER:-/opt/aais/bin/aais-secrets-bootstrap.sh}"

for required_command in flock install readlink stat systemctl docker; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "AAIS secret rotation dependency is unavailable: ${required_command}." >&2
    exit 1
  fi
done
if [[ "$operation_lock_file" != "$(dirname "$state_file")/deploy.lock" \
  || -L "$operation_lock_file" ]]; then
  echo "AAIS operation lock path is invalid." >&2
  exit 1
fi
if [[ ! -x "$deploy_wrapper" || ! -x "$bootstrap_wrapper" ]]; then
  echo "AAIS secret rotation wrappers are unavailable." >&2
  exit 1
fi
install -d -o root -g root -m 0755 "$(dirname "$operation_lock_file")"
exec 9>"$operation_lock_file"
if ! flock -n 9; then
  echo "Another AAIS deployment or secret rotation is already running." >&2
  exit 1
fi
export AAIS_OPERATION_LOCK_FD=9

rotation_complete="false"
on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 || "$rotation_complete" != "true" ]]; then
    systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
    echo "AAIS secret rotation did not complete; worker timers remain stopped for operator recovery." >&2
  fi
  exit "$status"
}
trap on_exit EXIT

systemctl stop "$email_timer" "$lrs_timer"
for _ in $(seq 1 130); do
  if ! systemctl is-active --quiet aais-email-outbox.service \
    && ! systemctl is-active --quiet aais-lrs-outbox.service; then
    break
  fi
  sleep 1
done
if systemctl is-active --quiet aais-email-outbox.service \
  || systemctl is-active --quiet aais-lrs-outbox.service; then
  echo "AAIS workers did not drain before secret rotation." >&2
  exit 1
fi

"$bootstrap_wrapper"
active_color="$(tr -d '[:space:]' < "$state_file")"
if [[ "$active_color" != "blue" && "$active_color" != "green" ]]; then
  echo "AAIS active color is unavailable for secret rotation." >&2
  exit 1
fi
active_container="aais-${active_color}"
image_ref="$(docker inspect --format '{{.Config.Image}}' "$active_container")"
release_sha="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$image_ref")"
if [[ "$image_ref" != *@sha256:* || ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "AAIS active image provenance is invalid for secret rotation." >&2
  exit 1
fi

"$deploy_wrapper" "$image_ref" "$release_sha"
systemctl start "$email_timer" "$lrs_timer"
rotation_complete="true"
unset AAIS_OPERATION_LOCK_FD
trap - EXIT
echo "AAIS secret bundle rotated through an exact-digest blue/green deployment."
