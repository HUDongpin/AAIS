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

bootstrap_config_file="${AAIS_SECRETS_BOOTSTRAP_CONFIG:-/etc/aais/secrets-bootstrap.env}"
if [[ ! -r "$bootstrap_config_file" \
  || "$(stat -c '%u' "$bootstrap_config_file" 2>/dev/null || true)" != "0" \
  || "$(stat -c '%a' "$bootstrap_config_file" 2>/dev/null || true)" != "600" ]]; then
  echo "AAIS secret bootstrap configuration must be root-owned with mode 0600." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$bootstrap_config_file"

email_timer="aais-email-outbox.timer"
lrs_timer="aais-lrs-outbox.timer"
state_file="${AAIS_STATE_FILE:-/opt/aais/state/active-deployment.env}"
operation_lock_file="${AAIS_OPERATION_LOCK_FILE:-/opt/aais/state/deploy.lock}"
rotation_pending_file="${AAIS_ROTATION_PENDING_FILE:-/opt/aais/state/secret-rotation.pending}"
deploy_wrapper="${AAIS_DEPLOY_WRAPPER:-/opt/aais/bin/aais-deploy.sh}"
bootstrap_wrapper="${AAIS_SECRETS_BOOTSTRAP_WRAPPER:-/opt/aais/bin/aais-secrets-bootstrap.sh}"
secret_source="${AAIS_SECRET_SOURCE:-file}"
local_secret_dir="/etc/aais/secrets"
local_runtime_source="${local_secret_dir}/runtime.env"
local_runtime_candidate="${local_secret_dir}/runtime.env.candidate"
local_runtime_previous="${local_secret_dir}/runtime.env.previous"
local_previous_candidate="${local_secret_dir}/runtime.env.previous.staging"
local_rollback_candidate="${local_secret_dir}/runtime.env.rollback.staging"

for required_command in flock install readlink stat systemctl docker awk cp mv mktemp curl jq; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "AAIS secret rotation dependency is unavailable: ${required_command}." >&2
    exit 1
  fi
done
if [[ "$operation_lock_file" != "$(dirname "$state_file")/deploy.lock" \
  || "$rotation_pending_file" != "$(dirname "$state_file")/secret-rotation.pending" \
  || -L "$operation_lock_file" || -L "$state_file" || -L "$rotation_pending_file" ]]; then
  echo "AAIS operation lock path is invalid." >&2
  exit 1
fi
if [[ ! -x "$deploy_wrapper" || ! -x "$bootstrap_wrapper" ]]; then
  echo "AAIS secret rotation wrappers are unavailable." >&2
  exit 1
fi
case "$secret_source" in
  file)
    if [[ "$#" -eq 1 && "${1:-}" == "$local_runtime_candidate" ]]; then
      file_rotation_mode="new"
    elif [[ "$#" -eq 1 && "${1:-}" == "--resume" ]]; then
      file_rotation_mode="resume"
    elif [[ "$#" -eq 1 && "${1:-}" == "--rollback" ]]; then
      file_rotation_mode="rollback"
    elif [[ "$#" -eq 2 && "${1:-}" == "--replace-pending" \
      && "${2:-}" == "$local_runtime_candidate" ]]; then
      file_rotation_mode="replace-pending"
    else
      echo "AAIS file-source rotation requires the protected candidate, --resume, --rollback, or --replace-pending plus the candidate." >&2
      exit 1
    fi
    ;;
  kms)
    if [[ "$#" -ne 0 ]]; then
      echo "AAIS KMS rotation does not accept a local secret candidate." >&2
      exit 1
    fi
    ;;
  *)
    echo "AAIS_SECRET_SOURCE must be file or kms." >&2
    exit 1
    ;;
esac
if [[ -f /opt/aais/state/maintenance.enabled ]]; then
  echo "AAIS secret rotation requires the ordinary maintenance flag to be disabled." >&2
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
rotation_pending="false"
rotation_phase_candidate=""
write_rotation_phase() {
  local phase="$1"
  if [[ ! "$phase" =~ ^(prepared|previous-saved|source-promoted|runtime-published|container-promoted|failed)$ ]]; then
    return 1
  fi
  rotation_phase_candidate="$(mktemp "$(dirname "$rotation_pending_file")/secret-rotation.phase.XXXXXX")"
  printf '%s\n' "$phase" > "$rotation_phase_candidate"
  chown root:root "$rotation_phase_candidate"
  chmod 0600 "$rotation_phase_candidate"
  mv -Tf -- "$rotation_phase_candidate" "$rotation_pending_file"
  rotation_phase_candidate=""
  rotation_pending="true"
}
on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 || "$rotation_complete" != "true" ]]; then
    if [[ "$rotation_pending" == "true" && ! -f "$rotation_pending_file" ]]; then
      write_rotation_phase failed >/dev/null 2>&1 || true
    fi
    if [[ "$rotation_pending" == "true" ]]; then
      systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
      echo "AAIS secret rotation did not complete; worker timers remain stopped for operator recovery." >&2
    else
      timer_restore_failed="false"
      if [[ "${email_timer_was_active:-false}" == "true" ]]; then
        systemctl start "$email_timer" >/dev/null 2>&1 || timer_restore_failed="true"
      fi
      if [[ "${lrs_timer_was_active:-false}" == "true" ]]; then
        systemctl start "$lrs_timer" >/dev/null 2>&1 || timer_restore_failed="true"
      fi
      if [[ "$timer_restore_failed" == "true" ]]; then
        write_rotation_phase failed >/dev/null 2>&1 || true
        systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
        echo "AAIS rotation preflight failed and the original timers could not be restored; a durable failed marker was written." >&2
      else
        echo "AAIS secret rotation preflight failed before mutation; original timer state was restored." >&2
      fi
    fi
  fi
  if [[ -n "$rotation_phase_candidate" \
    && "$rotation_phase_candidate" == "$(dirname "$rotation_pending_file")/secret-rotation.phase."* ]]; then
    rm -f -- "$rotation_phase_candidate"
  fi
  if [[ "$rotation_pending" != "true" ]]; then
    rm -f -- "$local_previous_candidate" "$local_rollback_candidate"
  fi
  exit "$status"
}
trap on_exit EXIT

email_timer_was_active="false"
lrs_timer_was_active="false"
if systemctl is-active --quiet "$email_timer"; then
  email_timer_was_active="true"
fi
if systemctl is-active --quiet "$lrs_timer"; then
  lrs_timer_was_active="true"
fi
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

pending_was_present="false"
rotation_phase=""
if [[ -f "$rotation_pending_file" ]]; then
  pending_was_present="true"
  pending_owner="$(stat -c '%u' "$rotation_pending_file" 2>/dev/null || true)"
  pending_mode="$(stat -c '%a' "$rotation_pending_file" 2>/dev/null || true)"
  rotation_phase="$(tr -d '[:space:]' < "$rotation_pending_file" 2>/dev/null || true)"
  if [[ "$pending_owner" != "0" || "$pending_mode" != "600" \
    || ! "$rotation_phase" =~ ^(prepared|previous-saved|source-promoted|runtime-published|container-promoted|failed)$ ]]; then
    echo "AAIS durable secret rotation marker is invalid." >&2
    exit 1
  fi
  rotation_pending="true"
fi
previous_active_bundle="$(awk -F= '
  $1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" {
    count += 1
    value = substr($0, index($0, "=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$state_file" 2>/dev/null || true)"
if [[ ! "$previous_active_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
  echo "AAIS active secret bundle is unavailable for rotation." >&2
  exit 1
fi

if [[ "$secret_source" == "file" ]]; then
  local_secret_dir_owner="$(stat -c '%u' "$local_secret_dir" 2>/dev/null || true)"
  local_secret_dir_mode="$(stat -c '%a' "$local_secret_dir" 2>/dev/null || true)"
  if [[ ! -d "$local_secret_dir" || -L "$local_secret_dir" \
    || "$(readlink -f "$local_secret_dir" 2>/dev/null || true)" != "$local_secret_dir" \
    || "$local_secret_dir_owner" != "0" || "$local_secret_dir_mode" != "700" ]]; then
    echo "AAIS local secret rotation directory or recovery state is unsafe." >&2
    exit 1
  fi
  validate_local_secret_file() {
    local local_secret_file="$1"
    local local_secret_owner local_secret_mode local_secret_links
    local_secret_owner="$(stat -c '%u' "$local_secret_file" 2>/dev/null || true)"
    local_secret_mode="$(stat -c '%a' "$local_secret_file" 2>/dev/null || true)"
    local_secret_links="$(stat -c '%h' "$local_secret_file" 2>/dev/null || true)"
    if [[ ! -f "$local_secret_file" || -L "$local_secret_file" \
      || "$local_secret_owner" != "0" || "$local_secret_mode" != "400" \
      || "$local_secret_links" != "1" ]]; then
      return 1
    fi
  }
  if ! validate_local_secret_file "$local_runtime_source"; then
    echo "AAIS local runtime source must be a regular root-owned 0400 file." >&2
    exit 1
  fi

  if [[ "$file_rotation_mode" == "new" ]]; then
    if [[ "$pending_was_present" == "true" || -e "$local_runtime_previous" \
      || -e "$local_previous_candidate" || -e "$local_rollback_candidate" \
      || ! -f "$local_runtime_candidate" ]]; then
      echo "AAIS new local rotation has unresolved recovery state or no candidate." >&2
      exit 1
    fi
    if ! validate_local_secret_file "$local_runtime_candidate" \
      || ! "$bootstrap_wrapper" --validate-file "$local_runtime_candidate"; then
      echo "AAIS local secret candidate failed the complete bootstrap dry-run." >&2
      exit 1
    fi
    candidate_bundle="$(awk -F= '$1 == "AAIS_SECRET_BUNDLE_VERSION" { count += 1; value=substr($0, index($0, "=") + 1) } END { if (count != 1) exit 1; print value }' "$local_runtime_candidate")"
    if [[ ! "$candidate_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
      || "$candidate_bundle" == "$previous_active_bundle" ]]; then
      echo "AAIS local secret candidate must use a new valid bundle version." >&2
      exit 1
    fi
    write_rotation_phase prepared
    rotation_phase="prepared"
  elif [[ "$file_rotation_mode" == "replace-pending" ]]; then
    if [[ "$pending_was_present" != "true" || ! -f "$local_runtime_candidate" \
      || ! validate_local_secret_file "$local_runtime_candidate" \
      || ! "$bootstrap_wrapper" --validate-file "$local_runtime_candidate" ]]; then
      echo "AAIS replacement candidate is unavailable or failed the complete bootstrap dry-run." >&2
      exit 1
    fi
    mv -Tf -- "$local_runtime_candidate" "$local_runtime_source"
    write_rotation_phase source-promoted
    rotation_phase="source-promoted"
  elif [[ "$file_rotation_mode" == "rollback" ]]; then
    if [[ "$pending_was_present" != "true" || ! -f "$local_runtime_previous" \
      || ! validate_local_secret_file "$local_runtime_previous" \
      || ! "$bootstrap_wrapper" --validate-file "$local_runtime_previous" ]]; then
      echo "AAIS protected previous source is unavailable for rollback." >&2
      exit 1
    fi
    if [[ ! -f "$local_rollback_candidate" ]]; then
      cp -- "$local_runtime_previous" "$local_rollback_candidate"
      chown root:root "$local_rollback_candidate"
      chmod 0400 "$local_rollback_candidate"
    elif ! validate_local_secret_file "$local_rollback_candidate"; then
      echo "AAIS rollback staging source is invalid." >&2
      exit 1
    fi
    mv -Tf -- "$local_rollback_candidate" "$local_runtime_source"
    write_rotation_phase source-promoted
    rotation_phase="source-promoted"
  elif [[ "$pending_was_present" != "true" ]]; then
    echo "AAIS local secret rotation cannot resume without a durable phase marker." >&2
    exit 1
  fi

  if [[ "$rotation_phase" == "prepared" ]]; then
    if [[ ! -f "$local_runtime_candidate" \
      || ! validate_local_secret_file "$local_runtime_candidate" \
      || ! "$bootstrap_wrapper" --validate-file "$local_runtime_candidate" ]]; then
      echo "AAIS prepared rotation candidate is no longer valid." >&2
      exit 1
    fi
    if [[ ! -f "$local_runtime_previous" ]]; then
      if [[ ! -f "$local_previous_candidate" ]]; then
        cp -- "$local_runtime_source" "$local_previous_candidate"
        chown root:root "$local_previous_candidate"
        chmod 0400 "$local_previous_candidate"
      elif ! validate_local_secret_file "$local_previous_candidate"; then
        echo "AAIS previous-source staging file is invalid." >&2
        exit 1
      fi
      mv -Tf -- "$local_previous_candidate" "$local_runtime_previous"
    elif ! validate_local_secret_file "$local_runtime_previous"; then
      echo "AAIS protected previous source is invalid." >&2
      exit 1
    fi
    write_rotation_phase previous-saved
    rotation_phase="previous-saved"
  fi
  if [[ "$rotation_phase" == "previous-saved" ]]; then
    if [[ ! -f "$local_runtime_previous" \
      || ! validate_local_secret_file "$local_runtime_previous" ]]; then
      echo "AAIS previous source is unavailable before source promotion." >&2
      exit 1
    fi
    if [[ -f "$local_runtime_candidate" ]]; then
      if ! validate_local_secret_file "$local_runtime_candidate" \
        || ! "$bootstrap_wrapper" --validate-file "$local_runtime_candidate"; then
        echo "AAIS pending candidate is invalid before source promotion." >&2
        exit 1
      fi
      mv -Tf -- "$local_runtime_candidate" "$local_runtime_source"
    else
      promoted_source_bundle="$(awk -F= '$1 == "AAIS_SECRET_BUNDLE_VERSION" { count += 1; value=substr($0, index($0, "=") + 1) } END { if (count != 1) exit 1; print value }' "$local_runtime_source" 2>/dev/null || true)"
      if [[ "$promoted_source_bundle" == "$previous_active_bundle" \
        || ! "$promoted_source_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
        echo "AAIS source promotion is incomplete; supply a replacement or roll back." >&2
        exit 1
      fi
    fi
    write_rotation_phase source-promoted
    rotation_phase="source-promoted"
  fi
fi

if [[ "$secret_source" == "kms" && "$rotation_pending" != "true" ]]; then
  write_rotation_phase prepared
  rotation_phase="prepared"
fi

"$bootstrap_wrapper"
write_rotation_phase runtime-published
rotation_phase="runtime-published"
new_runtime_file="${AAIS_RUNTIME_ENV_FILE:-/run/aais/current/runtime.env}"
new_bundle="$(awk -F= '
  index($0, "AAIS_SECRET_BUNDLE_VERSION=") == 1 {
    count += 1
    value = substr($0, length("AAIS_SECRET_BUNDLE_VERSION=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$new_runtime_file")"
if [[ ! "$new_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
  || ( "$new_bundle" == "$previous_active_bundle" \
    && "$pending_was_present" != "true" ) ]]; then
  echo "AAIS secret bootstrap did not produce a new bundle version." >&2
  exit 1
fi
active_color="$(awk -F= '
  $1 == "AAIS_ACTIVE_COLOR" { count += 1; value=$2 }
  END { if (count != 1) exit 1; print value }
' "$state_file")"
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
promoted_bundle="$(awk -F= '
  $1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" {
    count += 1
    value = substr($0, index($0, "=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$state_file" 2>/dev/null || true)"
if [[ "$promoted_bundle" != "$new_bundle" ]]; then
  echo "AAIS promoted container did not commit the new secret bundle state." >&2
  exit 1
fi
write_rotation_phase container-promoted
rotation_phase="container-promoted"
diagnostic_probe="$(curl --fail --silent --show-error --max-time 10 \
  --resolve www.aais.site:8443:127.0.0.1 \
  https://www.aais.site:8443/api/system/traffic-readiness)"
if ! jq -e --arg release "$release_sha" \
  '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
  <<<"$diagnostic_probe" >/dev/null; then
  echo "AAIS loopback Nginx diagnostic path does not match the promoted release." >&2
  exit 1
fi
rm -f -- "$rotation_pending_file"
canonical_probe="$(curl --fail --silent --show-error --max-time 10 \
  --resolve www.aais.site:443:127.0.0.1 \
  https://www.aais.site/api/system/traffic-readiness)"
if ! jq -e --arg release "$release_sha" \
  '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
  <<<"$canonical_probe" >/dev/null; then
  echo "AAIS canonical path does not match the promoted release after rotation." >&2
  exit 1
fi
if [[ "$email_timer_was_active" == "true" ]]; then
  systemctl start "$email_timer"
  systemctl is-active --quiet "$email_timer"
fi
if [[ "$lrs_timer_was_active" == "true" ]]; then
  systemctl start "$lrs_timer"
  systemctl is-active --quiet "$lrs_timer"
fi
if [[ "$secret_source" == "file" ]]; then
  rm -f -- "$local_runtime_previous" "$local_previous_candidate" "$local_rollback_candidate"
  if [[ "$file_rotation_mode" == "rollback" ]]; then
    rm -f -- "$local_runtime_candidate"
  fi
fi
rotation_complete="true"
rotation_pending="false"
unset AAIS_OPERATION_LOCK_FD
trap - EXIT
echo "AAIS secret bundle rotated through an exact-digest blue/green deployment."
