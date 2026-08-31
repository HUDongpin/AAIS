#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"
readonly AAIS_JSON_HELPER_SHA256="b94a6a7485c8b760cdcf3275c7cf82199e82eafa099213e640152d86dea0dd03"

aais_run_json_helper() {
  /usr/bin/env -i LC_ALL=C LANG=C HOME=/ TZ=UTC \
    /usr/bin/python3 -I -S -B "$AAIS_JSON_HELPER_PATH" "$@"
}

aais_require_json_helper() {
  local helper_dir="/opt/aais/libexec"
  local identity_before identity_after actual_sha256
  if [[ ! -x /usr/bin/env || ! -x /usr/bin/python3 ]] \
    || ! command -v stat >/dev/null 2>&1 \
    || ! command -v readlink >/dev/null 2>&1 \
    || ! command -v sha256sum >/dev/null 2>&1 \
    || ! command -v awk >/dev/null 2>&1; then
    echo "AAIS protected JSON runtime is unavailable." >&2
    return 1
  fi
  if [[ ! -d "$helper_dir" || -L "$helper_dir" \
    || "$(readlink -f "$helper_dir" 2>/dev/null || true)" != "$helper_dir" \
    || "$(stat -c '%u' "$helper_dir" 2>/dev/null || true)" != "0" \
    || "$(stat -c '%a' "$helper_dir" 2>/dev/null || true)" != "700" ]]; then
    echo "AAIS protected JSON helper directory is invalid." >&2
    return 1
  fi
  identity_before="$(stat -c '%d:%i' "$AAIS_JSON_HELPER_PATH" 2>/dev/null || true)"
  if [[ ! -f "$AAIS_JSON_HELPER_PATH" || -L "$AAIS_JSON_HELPER_PATH" \
    || "$(stat -c '%u' "$AAIS_JSON_HELPER_PATH" 2>/dev/null || true)" != "0" \
    || "$(stat -c '%a' "$AAIS_JSON_HELPER_PATH" 2>/dev/null || true)" != "500" \
    || "$(stat -c '%h' "$AAIS_JSON_HELPER_PATH" 2>/dev/null || true)" != "1" \
    || -z "$identity_before" ]]; then
    echo "AAIS protected JSON helper is invalid." >&2
    return 1
  fi
  actual_sha256="$(sha256sum "$AAIS_JSON_HELPER_PATH" 2>/dev/null | awk '{ print $1 }')"
  identity_after="$(stat -c '%d:%i' "$AAIS_JSON_HELPER_PATH" 2>/dev/null || true)"
  if [[ "$actual_sha256" != "$AAIS_JSON_HELPER_SHA256" \
    || "$identity_after" != "$identity_before" ]]; then
    echo "AAIS protected JSON helper fingerprint does not match." >&2
    return 1
  fi
  if ! aais_run_json_helper self-test >/dev/null; then
    echo "AAIS protected JSON helper self-test failed." >&2
    return 1
  fi
}

aais_json_validate_traffic_ready() {
  aais_run_json_helper validate-traffic-ready "$1"
}

aais_require_json_helper

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
rotation_canonical_check_file="$(dirname "$state_file")/secret-rotation.canonical-check"
rotation_invalid_file="$(dirname "$state_file")/secret-rotation.invalid"
deploy_wrapper="${AAIS_DEPLOY_WRAPPER:-/opt/aais/bin/aais-deploy.sh}"
bootstrap_wrapper="${AAIS_SECRETS_BOOTSTRAP_WRAPPER:-/opt/aais/bin/aais-secrets-bootstrap.sh}"
local_secret_dir="/etc/aais/secrets"
local_runtime_source="${local_secret_dir}/runtime.env"
local_runtime_candidate="${local_secret_dir}/runtime.env.candidate"
local_runtime_previous="${local_secret_dir}/runtime.env.previous"
local_previous_candidate="${local_secret_dir}/runtime.env.previous.staging"
local_rollback_candidate="${local_secret_dir}/runtime.env.rollback.staging"

for required_command in flock install readlink stat systemctl docker awk cp mv mktemp curl ln; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "AAIS secret rotation dependency is unavailable: ${required_command}." >&2
    exit 1
  fi
done
if [[ "$state_file" != "/opt/aais/state/active-deployment.env" \
  || "$operation_lock_file" != "/opt/aais/state/deploy.lock" \
  || "$operation_lock_file" != "$(dirname "$state_file")/deploy.lock" \
  || "$rotation_pending_file" != "/opt/aais/state/secret-rotation.pending" \
  || "$rotation_pending_file" != "$(dirname "$state_file")/secret-rotation.pending" \
  || "$rotation_canonical_check_file" != "/opt/aais/state/secret-rotation.canonical-check" \
  || "$rotation_canonical_check_file" != "$(dirname "$state_file")/secret-rotation.canonical-check" \
  || "$rotation_invalid_file" != "/opt/aais/state/secret-rotation.invalid" \
  || "$rotation_invalid_file" != "$(dirname "$state_file")/secret-rotation.invalid" \
  || -L "$operation_lock_file" || -L "$state_file" ]]; then
  echo "AAIS operation lock path is invalid." >&2
  exit 1
fi
if [[ ! -x "$deploy_wrapper" || ! -x "$bootstrap_wrapper" ]]; then
  echo "AAIS secret rotation wrappers are unavailable." >&2
  exit 1
fi
if [[ "${AAIS_SECRET_SOURCE:-file}" != "file" ]]; then
  echo "AAIS_SECRET_SOURCE must be file." >&2
  exit 1
fi
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
canonical_check_active="false"
canonical_resume="false"
canonical_passed="false"
rollback_intent="false"
timers_stopped="false"
marker_metadata_valid="false"
marker_conflict="false"
rotation_invalid_present="false"
write_rotation_marker() {
  local marker_target="$1"
  local phase="$2"
  local marker_parent="$(dirname "$rotation_pending_file")"
  local email_active="${email_timer_was_active:-false}"
  local lrs_active="${lrs_timer_was_active:-false}"
  if [[ "$marker_target" != "$rotation_pending_file" \
    && "$marker_target" != "$rotation_canonical_check_file" ]]; then
    return 1
  fi
  if [[ "$(dirname "$marker_target")" != "$marker_parent" ]]; then
    return 1
  fi
  if [[ ! "$phase" =~ ^(prepared|previous-saved|rollback-requested|source-promoted|runtime-published|container-promoted|canonical-passed|failed)$ ]]; then
    return 1
  fi
  if [[ "$email_active" != "true" && "$email_active" != "false" ]] \
    || [[ "$lrs_active" != "true" && "$lrs_active" != "false" ]]; then
    return 1
  fi
  rotation_phase_candidate="$(mktemp "${marker_parent}/secret-rotation.phase.XXXXXX")" \
    || {
      rotation_phase_candidate=""
      return 1
    }
  if ! printf 'AAIS_ROTATION_PHASE=%s\nAAIS_EMAIL_TIMER_WAS_ACTIVE=%s\nAAIS_LRS_TIMER_WAS_ACTIVE=%s\n' \
      "$phase" "$email_active" "$lrs_active" > "$rotation_phase_candidate" \
    || ! chown root:root "$rotation_phase_candidate" \
    || ! chmod 0600 "$rotation_phase_candidate"; then
    rm -f -- "$rotation_phase_candidate" >/dev/null 2>&1 || true
    rotation_phase_candidate=""
    return 1
  fi
  if ! mv -Tf -- "$rotation_phase_candidate" "$marker_target"; then
    rm -f -- "$rotation_phase_candidate" >/dev/null 2>&1 || true
    rotation_phase_candidate=""
    return 1
  fi
  rotation_phase_candidate=""
}

write_rotation_phase() {
  local phase="$1"
  write_rotation_marker "$rotation_pending_file" "$phase" || return 1
  rotation_pending="true"
  marker_metadata_valid="true"
  marker_conflict="false"
}

write_canonical_phase() {
  local phase="$1"
  write_rotation_marker "$rotation_canonical_check_file" "$phase" || return 1
  canonical_check_active="true"
  rotation_pending="true"
  marker_metadata_valid="true"
  marker_conflict="false"
}

read_rotation_marker() {
  local marker_file="$1"
  local marker_owner marker_mode marker_links
  marker_owner="$(stat -c '%u' "$marker_file" 2>/dev/null || true)"
  marker_mode="$(stat -c '%a' "$marker_file" 2>/dev/null || true)"
  marker_links="$(stat -c '%h' "$marker_file" 2>/dev/null || true)"
  if [[ ! -f "$marker_file" || -L "$marker_file" \
    || "$marker_owner" != "0" || "$marker_mode" != "600" \
    || "$marker_links" != "1" ]]; then
    return 1
  fi
  awk -F= '
    NF != 2 { exit 1 }
    $1 == "AAIS_ROTATION_PHASE" { phase_count += 1; phase = $2; next }
    $1 == "AAIS_EMAIL_TIMER_WAS_ACTIVE" { email_count += 1; email = $2; next }
    $1 == "AAIS_LRS_TIMER_WAS_ACTIVE" { lrs_count += 1; lrs = $2; next }
    { exit 1 }
    END {
      if (NR != 3 || phase_count != 1 || email_count != 1 || lrs_count != 1) exit 1
      if (phase !~ /^(prepared|previous-saved|rollback-requested|source-promoted|runtime-published|container-promoted|canonical-passed|failed)$/) exit 1
      if (email !~ /^(true|false)$/ || lrs !~ /^(true|false)$/) exit 1
      printf "%s\t%s\t%s\n", phase, email, lrs
    }
  ' "$marker_file"
}

validate_invalid_guard() {
  local guard_owner guard_mode guard_links guard_value
  guard_owner="$(stat -c '%u' "$rotation_invalid_file" 2>/dev/null || true)"
  guard_mode="$(stat -c '%a' "$rotation_invalid_file" 2>/dev/null || true)"
  guard_links="$(stat -c '%h' "$rotation_invalid_file" 2>/dev/null || true)"
  guard_value="$(awk '
    NR == 1 { value = $0 }
    END { if (NR != 1) exit 1; print value }
  ' "$rotation_invalid_file" 2>/dev/null || true)"
  [[ -f "$rotation_invalid_file" && ! -L "$rotation_invalid_file" \
    && "$guard_owner" == "0" && "$guard_mode" == "600" \
    && "$guard_links" == "1" \
    && "$guard_value" == "AAIS_ROTATION_INVALID=manual-reconciliation-required" ]]
}

write_invalid_guard() {
  local guard_parent guard_candidate
  guard_parent="$(dirname "$rotation_invalid_file")"
  if [[ "$guard_parent" != "/opt/aais/state" ]]; then
    return 1
  fi
  if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]; then
    validate_invalid_guard
    return
  fi
  guard_candidate="$(mktemp "${guard_parent}/secret-rotation.invalid.XXXXXX")" \
    || return 1
  if ! printf 'AAIS_ROTATION_INVALID=manual-reconciliation-required\n' \
      > "$guard_candidate" \
    || ! chown root:root "$guard_candidate" \
    || ! chmod 0600 "$guard_candidate"; then
    rm -f -- "$guard_candidate" >/dev/null 2>&1 || true
    return 1
  fi
  if ! ln -- "$guard_candidate" "$rotation_invalid_file"; then
    rm -f -- "$guard_candidate"
    validate_invalid_guard
    return
  fi
  rm -f -- "$guard_candidate"
  validate_invalid_guard
}

aais_plan_marker_startup() {
  local pending_present="$1"
  local canonical_present="$2"
  local requested_mode="$3"
  if [[ "$pending_present" != "true" && "$pending_present" != "false" ]] \
    || [[ "$canonical_present" != "true" && "$canonical_present" != "false" ]]; then
    return 1
  fi
  if [[ "$pending_present" == "true" && "$canonical_present" == "true" ]]; then
    return 1
  fi
  if [[ "$canonical_present" == "true" ]]; then
    [[ "$requested_mode" == "resume" || "$requested_mode" == "rollback" ]] \
      || return 1
    printf 'canonical-validating\n'
  elif [[ "$pending_present" == "true" ]]; then
    printf 'pending\n'
  else
    printf 'none\n'
  fi
}

read_systemd_active_state() {
  local unit_name="$1"
  local unit_metadata load_state observed_state
  unit_metadata="$(systemctl show --property=LoadState --property=ActiveState \
    "$unit_name" 2>/dev/null)" || return 1
  IFS=$'\t' read -r load_state observed_state <<<"$(printf '%s\n' \
    "$unit_metadata" | awk -F= '
      NF != 2 { exit 1 }
      $1 == "LoadState" { load_count += 1; load = $2; next }
      $1 == "ActiveState" { active_count += 1; active = $2; next }
      { exit 1 }
      END {
        if (NR != 2 || load_count != 1 || active_count != 1) exit 1
        printf "%s\t%s\n", load, active
      }
    ')" || return 1
  [[ "$load_state" == "loaded" ]] || return 1
  case "$observed_state" in
    active|inactive|activating|deactivating|reloading|failed)
      printf '%s\n' "$observed_state"
      ;;
    *) return 1 ;;
  esac
}

read_timer_active_state() {
  local observed_state
  observed_state="$(read_systemd_active_state "$1")" || return 1
  case "$observed_state" in
    active) printf 'true\n' ;;
    inactive) printf 'false\n' ;;
    *) return 1 ;;
  esac
}

require_timer_target_state() {
  local timer_name="$1"
  local expected_active="$2"
  local observed_state
  observed_state="$(read_systemd_active_state "$timer_name")" || return 1
  if [[ "$expected_active" == "true" ]]; then
    [[ "$observed_state" == "active" ]]
  elif [[ "$expected_active" == "false" ]]; then
    [[ "$observed_state" == "inactive" ]]
  else
    return 1
  fi
}
on_exit() {
  local status=$?
  local canonical_recovery_failed="false"
  local exit_marker_metadata=""
  local exit_marker_phase=""
  local exit_email_timer_was_active=""
  local exit_lrs_timer_was_active=""
  trap - EXIT
  if [[ "$rotation_invalid_present" != "true" \
    && "$marker_conflict" != "true" \
    && ( -e "$rotation_canonical_check_file" \
      || -L "$rotation_canonical_check_file" ) ]]; then
    if exit_marker_metadata="$(read_rotation_marker \
      "$rotation_canonical_check_file" 2>/dev/null)"; then
      IFS=$'\t' read -r exit_marker_phase exit_email_timer_was_active \
        exit_lrs_timer_was_active <<<"$exit_marker_metadata"
      email_timer_was_active="$exit_email_timer_was_active"
      lrs_timer_was_active="$exit_lrs_timer_was_active"
      marker_metadata_valid="true"
      rollback_intent="false"
      canonical_passed="false"
      if [[ "$exit_marker_phase" == "rollback-requested" ]]; then
        rollback_intent="true"
      elif [[ "$exit_marker_phase" == "canonical-passed" ]]; then
        canonical_passed="true"
      fi
    else
      marker_metadata_valid="false"
      rollback_intent="false"
      canonical_passed="false"
    fi
  fi
  if [[ "$status" -ne 0 || "$rotation_complete" != "true" ]]; then
    if [[ "$rotation_invalid_present" == "true" ]]; then
      systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
      echo "AAIS rotation invalid guard is present; no marker was changed and manual reconciliation is required." >&2
    elif [[ "$marker_conflict" == "true" ]]; then
      if write_invalid_guard >/dev/null 2>&1; then
        rotation_invalid_present="true"
      else
        echo "AAIS invalid guard could not be armed; both original markers remain untouched." >&2
      fi
      systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
      echo "AAIS pending and canonical-check markers both exist; both marker bytes were preserved, the invalid guard was armed, and manual reconciliation is required." >&2
    elif [[ "$canonical_passed" == "true" ]]; then
      if [[ -e "$rotation_canonical_check_file" \
        || -L "$rotation_canonical_check_file" ]]; then
        rotation_pending="true"
        systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
        echo "AAIS canonical verification passed but final commit did not complete; the canonical-check marker and durable timer intent were preserved for --resume." >&2
      elif [[ "$rotation_complete" != "true" ]]; then
        write_rotation_phase failed >/dev/null 2>&1 || true
        rotation_pending="true"
        systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
        echo "AAIS canonical-passed custody disappeared before commit; a failed pending marker was written for manual recovery." >&2
      fi
    elif [[ "$rollback_intent" == "true" ]]; then
      if [[ -e "$rotation_canonical_check_file" \
        || -L "$rotation_canonical_check_file" ]]; then
        if [[ ! -e "$rotation_pending_file" && ! -L "$rotation_pending_file" ]]; then
          mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file" \
            >/dev/null 2>&1 || true
        fi
      elif [[ ! -e "$rotation_pending_file" && ! -L "$rotation_pending_file" ]]; then
        write_rotation_phase rollback-requested >/dev/null 2>&1 || true
      fi
      systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
      echo "AAIS rollback intent did not complete; its durable marker and timer intent were preserved for --resume." >&2
    elif [[ "$rotation_pending" == "true" ]]; then
      if [[ "$marker_metadata_valid" != "true" ]]; then
        if write_invalid_guard >/dev/null 2>&1; then
          rotation_invalid_present="true"
        else
          echo "AAIS invalid guard could not be armed; the invalid original marker remains untouched." >&2
        fi
        canonical_recovery_failed="true"
      elif [[ -e "$rotation_canonical_check_file" \
        || -L "$rotation_canonical_check_file" ]]; then
        if [[ ! -e "$rotation_pending_file" && ! -L "$rotation_pending_file" ]] \
          && mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file"; then
          canonical_check_active="false"
          write_rotation_phase failed >/dev/null 2>&1 || true
        else
          write_rotation_phase failed >/dev/null 2>&1 || true
          canonical_recovery_failed="true"
        fi
      elif [[ ! -f "$rotation_pending_file" ]]; then
        write_rotation_phase failed >/dev/null 2>&1 || true
      fi
      systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
      echo "AAIS secret rotation did not complete; worker timers remain stopped for operator recovery." >&2
      if [[ "$canonical_recovery_failed" == "true" ]]; then
        echo "AAIS durable marker metadata and paths were preserved without synthesis; the invalid guard requires manual reconciliation before resume." >&2
      fi
    else
      timer_restore_failed="false"
      if [[ "$timers_stopped" == "true" \
        && "${email_timer_was_active:-false}" == "true" ]]; then
        if ! systemctl start "$email_timer" >/dev/null 2>&1 \
          || ! require_timer_target_state "$email_timer" true; then
          timer_restore_failed="true"
        fi
      fi
      if [[ "$timers_stopped" == "true" \
        && "${lrs_timer_was_active:-false}" == "true" ]]; then
        if ! systemctl start "$lrs_timer" >/dev/null 2>&1 \
          || ! require_timer_target_state "$lrs_timer" true; then
          timer_restore_failed="true"
        fi
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
  if [[ "$rotation_pending" != "true" \
    && "$rotation_invalid_present" != "true" \
    && "$marker_conflict" != "true" \
    && ! -e "$rotation_pending_file" && ! -L "$rotation_pending_file" \
    && ! -e "$rotation_canonical_check_file" \
    && ! -L "$rotation_canonical_check_file" \
    && ! -e "$rotation_invalid_file" && ! -L "$rotation_invalid_file" ]]; then
    rm -f -- "$local_previous_candidate" "$local_rollback_candidate"
  fi
  exit "$status"
}
trap on_exit EXIT

if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]; then
  rotation_invalid_present="true"
  rotation_pending="true"
  systemctl stop "$email_timer" "$lrs_timer" >/dev/null 2>&1 || true
  echo "AAIS rotation invalid guard is present; automatic rotation recovery is forbidden until manual reconciliation." >&2
  exit 1
fi

pending_was_present="false"
rotation_phase=""
pending_marker_present="false"
canonical_marker_present="false"
if [[ -e "$rotation_pending_file" || -L "$rotation_pending_file" ]]; then
  pending_marker_present="true"
fi
if [[ -e "$rotation_canonical_check_file" \
  || -L "$rotation_canonical_check_file" ]]; then
  canonical_marker_present="true"
fi
if [[ "$pending_marker_present" == "true" \
  || "$canonical_marker_present" == "true" ]]; then
  rotation_pending="true"
  pending_was_present="true"
fi
if [[ "$pending_marker_present" == "true" \
  && "$canonical_marker_present" == "true" ]]; then
  marker_conflict="true"
fi
marker_startup_state="$(aais_plan_marker_startup "$pending_marker_present" \
  "$canonical_marker_present" "$file_rotation_mode")" || {
    echo "AAIS durable rotation markers conflict or require --resume; worker timers remain blocked and manual reconciliation may be required." >&2
    exit 1
  }
case "$marker_startup_state" in
  pending)
    marker_metadata="$(read_rotation_marker "$rotation_pending_file")" || {
      echo "AAIS durable secret rotation marker is invalid." >&2
      exit 1
    }
    IFS=$'\t' read -r rotation_phase email_timer_was_active \
      lrs_timer_was_active <<<"$marker_metadata"
    marker_metadata_valid="true"
    if [[ "$rotation_phase" == "rollback-requested" ]]; then
      rollback_intent="true"
    fi
    ;;
  canonical-validating)
    canonical_check_active="true"
    marker_metadata="$(read_rotation_marker \
      "$rotation_canonical_check_file")" || {
      echo "AAIS durable canonical-check marker is invalid." >&2
      exit 1
    }
    IFS=$'\t' read -r rotation_phase email_timer_was_active \
      lrs_timer_was_active <<<"$marker_metadata"
    marker_metadata_valid="true"
    if [[ "$rotation_phase" == "canonical-passed" ]]; then
      canonical_passed="true"
      if [[ "$file_rotation_mode" != "resume" ]]; then
        echo "AAIS canonical-passed recovery permits only --resume." >&2
        exit 1
      fi
      canonical_resume="true"
    elif [[ "$rotation_phase" == "rollback-requested" ]]; then
      rollback_intent="true"
      mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file"
      canonical_check_active="false"
      canonical_resume="false"
    elif [[ "$rotation_phase" != "container-promoted" ]]; then
      echo "AAIS canonical-check marker does not bind the promoted-container phase." >&2
      exit 1
    elif [[ "$file_rotation_mode" == "rollback" ]]; then
      write_canonical_phase rollback-requested
      rotation_phase="rollback-requested"
      rollback_intent="true"
      mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file"
      canonical_check_active="false"
      canonical_resume="false"
    else
      canonical_resume="true"
    fi
    ;;
  none) ;;
  *)
    echo "AAIS durable secret rotation marker is invalid." >&2
    exit 1
    ;;
esac
if [[ "$marker_startup_state" == "none" ]]; then
  email_timer_was_active="$(read_timer_active_state "$email_timer")" || {
    echo "AAIS email timer state is not exactly active or inactive." >&2
    exit 1
  }
  lrs_timer_was_active="$(read_timer_active_state "$lrs_timer")" || {
    echo "AAIS LRS timer state is not exactly active or inactive." >&2
    exit 1
  }
else
  if ! read_timer_active_state "$email_timer" >/dev/null; then
    echo "AAIS current email timer state is not exactly active or inactive." >&2
    exit 1
  fi
  if ! read_timer_active_state "$lrs_timer" >/dev/null; then
    echo "AAIS current LRS timer state is not exactly active or inactive." >&2
    exit 1
  fi
fi
state_owner="$(stat -c '%u' "$state_file" 2>/dev/null || true)"
state_mode="$(stat -c '%a' "$state_file" 2>/dev/null || true)"
state_links="$(stat -c '%h' "$state_file" 2>/dev/null || true)"
if [[ ! -f "$state_file" || -L "$state_file" \
  || "$state_owner" != "0" || "$state_mode" != "644" \
  || "$state_links" != "1" ]]; then
  echo "AAIS active deployment state is not protected for secret rotation." >&2
  exit 1
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

read_secret_bundle_version() {
  awk -F= '
    $1 == "AAIS_SECRET_BUNDLE_VERSION" {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END { if (count != 1) exit 1; print value }
  ' "$1"
}

validate_recovery_secret_file() {
  validate_local_secret_file "$1" \
    && "$bootstrap_wrapper" --validate-file "$1"
}

validate_rotation_candidate() {
  local candidate_file="$1"
  local candidate_version
  if ! validate_recovery_secret_file "$candidate_file"; then
    return 1
  fi
  candidate_version="$(read_secret_bundle_version "$candidate_file" 2>/dev/null || true)"
  [[ "$candidate_version" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
    && "$candidate_version" != "$previous_active_bundle" ]]
}

aais_plan_replace_pending_phase() {
  local current_phase="$1"
  local protected_previous_present="$2"
  if [[ "$protected_previous_present" != "true" \
    && "$protected_previous_present" != "false" ]]; then
    return 1
  fi
  case "$current_phase" in
    prepared)
      printf 'prepared\n'
      ;;
    previous-saved)
      [[ "$protected_previous_present" == "true" ]] || return 1
      printf 'previous-saved\n'
      ;;
    source-promoted|runtime-published)
      [[ "$protected_previous_present" == "true" ]] || return 1
      printf 'previous-saved\n'
      ;;
    container-promoted|failed) return 1 ;;
    *) return 1 ;;
  esac
}

read_active_deployment_binding() {
  local active_owner active_mode active_links
  active_owner="$(stat -c '%u' "$state_file" 2>/dev/null || true)"
  active_mode="$(stat -c '%a' "$state_file" 2>/dev/null || true)"
  active_links="$(stat -c '%h' "$state_file" 2>/dev/null || true)"
  if [[ ! -f "$state_file" || -L "$state_file" \
    || "$active_owner" != "0" || "$active_mode" != "644" \
    || "$active_links" != "1" ]]; then
    return 1
  fi
  awk -F= '
    NF != 2 { exit 1 }
    $1 == "AAIS_ACTIVE_COLOR" { color_count += 1; color = $2; next }
    $1 == "AAIS_ACTIVE_PORT" { port_count += 1; port = $2; next }
    $1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" { bundle_count += 1; bundle = $2; next }
    $1 == "AAIS_ACTIVE_RELEASE_SHA" { release_count += 1; release = $2; next }
    $1 == "AAIS_ACTIVE_IMAGE_DIGEST" { digest_count += 1; digest = $2; next }
    { exit 1 }
    END {
      if (NR != 5 || color_count != 1 || port_count != 1 || bundle_count != 1 || release_count != 1 || digest_count != 1) exit 1
      printf "%s\t%s\t%s\t%s\t%s\n", color, port, bundle, release, digest
    }
  ' "$state_file"
}

validate_canonical_resume_binding() {
  local color="$1"
  local port="$2"
  local bundle="$3"
  local expected_release="$4"
  local expected_digest="$5"
  local runtime_file="$6"
  local container="aais-${color}"
  local binding container_bundle container_release container_digest
  local configured_image image_revision runtime_bundle runtime_owner runtime_mode runtime_links
  if [[ ( "$color" == "blue" && "$port" != "3101" ) \
    || ( "$color" == "green" && "$port" != "3102" ) \
    || ( "$color" != "blue" && "$color" != "green" ) \
    || ! "$bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
    || ! "$expected_release" =~ ^[a-f0-9]{40}$ \
    || ! "$expected_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    return 1
  fi
  runtime_owner="$(stat -c '%u' "$runtime_file" 2>/dev/null || true)"
  runtime_mode="$(stat -c '%a' "$runtime_file" 2>/dev/null || true)"
  runtime_links="$(stat -c '%h' "$runtime_file" 2>/dev/null || true)"
  if [[ ! -f "$runtime_file" || -L "$runtime_file" \
    || "$runtime_owner" != "0" || "$runtime_mode" != "400" \
    || "$runtime_links" != "1" ]]; then
    return 1
  fi
  runtime_bundle="$(read_secret_bundle_version "$runtime_file" 2>/dev/null || true)"
  [[ "$runtime_bundle" == "$bundle" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] \
    || return 1
  binding="$(docker port "$container" 3000/tcp 2>/dev/null || true)"
  container_bundle="$(docker exec "$container" printenv AAIS_SECRET_BUNDLE_VERSION 2>/dev/null || true)"
  container_release="$(docker exec "$container" printenv AAIS_DEPLOYMENT_GIT_COMMIT_SHA 2>/dev/null || true)"
  container_digest="$(docker inspect --format '{{ index .Config.Labels "aais.image.digest" }}' "$container" 2>/dev/null || true)"
  configured_image="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  image_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$configured_image" 2>/dev/null || true)"
  [[ "$binding" == "127.0.0.1:${port}" \
    && "$container_bundle" == "$bundle" \
    && "$container_release" == "$expected_release" \
    && "$container_digest" == "$expected_digest" \
    && "$configured_image" == *@"$expected_digest" \
    && "$image_revision" == "$expected_release" ]]
}

  if ! validate_local_secret_file "$local_runtime_source"; then
    echo "AAIS local runtime source must be a regular root-owned 0400 file." >&2
    exit 1
  fi

  active_preflight_binding="$(read_active_deployment_binding)" || {
    echo "AAIS active deployment binding failed the rotation preflight." >&2
    exit 1
  }
  IFS=$'\t' read -r preflight_color preflight_port preflight_bundle \
    preflight_release preflight_digest <<<"$active_preflight_binding"
  if [[ "$preflight_bundle" != "$previous_active_bundle" ]]; then
    echo "AAIS active deployment and runtime bindings failed the rotation preflight." >&2
    exit 1
  fi
  if [[ "$file_rotation_mode" == "new" ]] \
    && ! validate_canonical_resume_binding "$preflight_color" "$preflight_port" \
      "$preflight_bundle" "$preflight_release" "$preflight_digest" \
      "${AAIS_RUNTIME_ENV_FILE:-/run/aais/current/runtime.env}"; then
    echo "AAIS active deployment and runtime bindings failed the rotation preflight." >&2
    exit 1
  fi

  if [[ "$file_rotation_mode" == "new" ]]; then
    if [[ "$pending_was_present" == "true" || -e "$local_runtime_previous" \
      || -e "$local_previous_candidate" || -e "$local_rollback_candidate" \
      || ! -f "$local_runtime_candidate" ]]; then
      echo "AAIS new local rotation has unresolved recovery state or no candidate." >&2
      exit 1
    fi
    if ! validate_rotation_candidate "$local_runtime_candidate"; then
      echo "AAIS local secret candidate failed the complete bootstrap dry-run." >&2
      exit 1
    fi
    write_rotation_phase prepared
    rotation_phase="prepared"
  elif [[ "$file_rotation_mode" == "replace-pending" ]]; then
    if [[ "$pending_was_present" != "true" || ! -f "$local_runtime_candidate" ]] \
      || ! validate_rotation_candidate "$local_runtime_candidate"; then
      echo "AAIS replacement candidate is unavailable or failed the complete bootstrap dry-run." >&2
      exit 1
    fi
    if [[ -e "$local_rollback_candidate" || -L "$local_rollback_candidate" ]]; then
      echo "AAIS replacement is blocked by unresolved rollback staging custody." >&2
      exit 1
    fi
    protected_previous_present="false"
    if [[ -e "$local_runtime_previous" || -L "$local_runtime_previous" ]]; then
      if ! validate_recovery_secret_file "$local_runtime_previous"; then
        echo "AAIS protected previous source is invalid before replacement." >&2
        exit 1
      fi
      protected_previous_present="true"
    fi
    if [[ -e "$local_previous_candidate" || -L "$local_previous_candidate" ]] \
      && ! validate_recovery_secret_file "$local_previous_candidate"; then
      echo "AAIS previous-source staging custody is invalid before replacement." >&2
      exit 1
    fi
    replacement_phase="$(aais_plan_replace_pending_phase "$rotation_phase" \
      "$protected_previous_present")" || {
        echo "AAIS replacement cannot preserve a usable rollback source for this phase." >&2
        exit 1
      }
    if [[ "$replacement_phase" != "$rotation_phase" ]]; then
      write_rotation_phase "$replacement_phase"
    fi
    rotation_phase="$replacement_phase"
  elif [[ "$file_rotation_mode" == "rollback" ]]; then
    if [[ "$pending_was_present" != "true" || ! -f "$local_runtime_previous" ]] \
      || ! validate_recovery_secret_file "$local_runtime_previous"; then
      echo "AAIS protected previous source is unavailable for rollback." >&2
      exit 1
    fi
    if [[ -e "$local_rollback_candidate" || -L "$local_rollback_candidate" ]] \
      && ! validate_recovery_secret_file "$local_rollback_candidate"; then
      echo "AAIS rollback staging source is invalid." >&2
      exit 1
    fi
    write_rotation_phase rollback-requested
    rotation_phase="rollback-requested"
    rollback_intent="true"
  elif [[ "$pending_was_present" != "true" ]]; then
    echo "AAIS local secret rotation cannot resume without a durable phase marker." >&2
    exit 1
  fi

  if [[ "$rotation_pending" != "true" ]]; then
    echo "AAIS secret rotation cannot mutate without a durable marker." >&2
    exit 1
  fi
  timers_stopped="true"
  systemctl stop "$email_timer" "$lrs_timer"
  if ! require_timer_target_state "$email_timer" false \
    || ! require_timer_target_state "$lrs_timer" false; then
    echo "AAIS worker timers did not reach exact inactive state after stop." >&2
    exit 1
  fi
  workers_drained="false"
  for _ in $(seq 1 130); do
    email_service_state="$(read_systemd_active_state \
      aais-email-outbox.service)" || {
        echo "AAIS email worker state query failed during drain." >&2
        exit 1
      }
    lrs_service_state="$(read_systemd_active_state \
      aais-lrs-outbox.service)" || {
        echo "AAIS LRS worker state query failed during drain." >&2
        exit 1
      }
    if [[ "$email_service_state" == "failed" \
      || "$lrs_service_state" == "failed" ]]; then
      echo "AAIS worker entered failed state during secret rotation drain." >&2
      exit 1
    fi
    if [[ "$email_service_state" == "inactive" \
      && "$lrs_service_state" == "inactive" ]]; then
      workers_drained="true"
      break
    fi
    sleep 1
  done
  if [[ "$workers_drained" != "true" ]]; then
    echo "AAIS workers did not drain before secret rotation." >&2
    exit 1
  fi

  if [[ "$rotation_phase" == "rollback-requested" ]]; then
    if ! validate_recovery_secret_file "$local_runtime_previous"; then
      echo "AAIS rollback intent lost its protected previous source." >&2
      exit 1
    fi
    if [[ ! -f "$local_rollback_candidate" ]]; then
      cp -- "$local_runtime_previous" "$local_rollback_candidate"
      chown root:root "$local_rollback_candidate"
      chmod 0400 "$local_rollback_candidate"
    fi
    if ! validate_recovery_secret_file "$local_rollback_candidate"; then
      echo "AAIS rollback staging source failed custody validation." >&2
      exit 1
    fi
    mv -Tf -- "$local_rollback_candidate" "$local_runtime_source"
    write_rotation_phase source-promoted
    rotation_phase="source-promoted"
    rollback_intent="false"
  fi

  case "$rotation_phase" in
    prepared)
      if [[ -e "$local_runtime_previous" || -L "$local_runtime_previous" ]] \
        && ! validate_recovery_secret_file "$local_runtime_previous"; then
        echo "AAIS protected previous source is invalid in the prepared phase." >&2
        exit 1
      fi
      ;;
    previous-saved|rollback-requested|source-promoted|runtime-published|container-promoted|failed)
      if ! validate_recovery_secret_file "$local_runtime_previous"; then
        echo "AAIS durable rotation phase has no usable protected previous source." >&2
        exit 1
      fi
      ;;
    canonical-passed)
      if [[ -e "$local_runtime_previous" || -L "$local_runtime_previous" ]] \
        && ! validate_recovery_secret_file "$local_runtime_previous"; then
        echo "AAIS optional previous source is invalid in the canonical-passed phase." >&2
        exit 1
      fi
      ;;
    *)
      echo "AAIS durable secret rotation phase is unsupported." >&2
      exit 1
      ;;
  esac
  case "$rotation_phase" in
    source-promoted|runtime-published|container-promoted|canonical-passed|failed)
      if ! validate_recovery_secret_file "$local_runtime_source"; then
        echo "AAIS promoted secret source is invalid for the durable rotation phase." >&2
        exit 1
      fi
      ;;
  esac

  if [[ "$rotation_phase" == "prepared" ]]; then
    if [[ ! -f "$local_runtime_candidate" ]] \
      || ! validate_rotation_candidate "$local_runtime_candidate"; then
      echo "AAIS prepared rotation candidate is no longer valid." >&2
      exit 1
    fi
    if [[ ! -f "$local_runtime_previous" ]]; then
      if [[ ! -f "$local_previous_candidate" ]]; then
        cp -- "$local_runtime_source" "$local_previous_candidate"
        chown root:root "$local_previous_candidate"
        chmod 0400 "$local_previous_candidate"
      elif ! validate_recovery_secret_file "$local_previous_candidate"; then
        echo "AAIS previous-source staging file is invalid." >&2
        exit 1
      fi
      if ! validate_recovery_secret_file "$local_previous_candidate"; then
        echo "AAIS previous-source staging file failed custody validation." >&2
        exit 1
      fi
      mv -Tf -- "$local_previous_candidate" "$local_runtime_previous"
    elif ! validate_recovery_secret_file "$local_runtime_previous"; then
      echo "AAIS protected previous source is invalid." >&2
      exit 1
    fi
    if ! validate_recovery_secret_file "$local_runtime_previous"; then
      echo "AAIS protected previous source was not durably preserved." >&2
      exit 1
    fi
    write_rotation_phase previous-saved
    rotation_phase="previous-saved"
  fi
  if [[ "$rotation_phase" == "previous-saved" ]]; then
    if [[ ! -f "$local_runtime_previous" ]] \
      || ! validate_recovery_secret_file "$local_runtime_previous"; then
      echo "AAIS previous source is unavailable before source promotion." >&2
      exit 1
    fi
    if [[ -f "$local_runtime_candidate" ]]; then
      if ! validate_rotation_candidate "$local_runtime_candidate"; then
        echo "AAIS pending candidate is invalid before source promotion." >&2
        exit 1
      fi
      mv -Tf -- "$local_runtime_candidate" "$local_runtime_source"
    else
      promoted_source_bundle="$(read_secret_bundle_version \
        "$local_runtime_source" 2>/dev/null || true)"
      if [[ "$promoted_source_bundle" == "$previous_active_bundle" \
        || ! "$promoted_source_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
        echo "AAIS source promotion is incomplete; supply a replacement or roll back." >&2
        exit 1
      fi
    fi
    write_rotation_phase source-promoted
    rotation_phase="source-promoted"
  fi

new_runtime_file="${AAIS_RUNTIME_ENV_FILE:-/run/aais/current/runtime.env}"
if [[ "$canonical_resume" == "true" ]]; then
  active_binding="$(read_active_deployment_binding)" || {
    echo "AAIS canonical-check resume cannot validate the active deployment state." >&2
    exit 1
  }
  IFS=$'\t' read -r active_color active_port new_bundle release_sha \
    active_image_digest <<<"$active_binding"
  if ! validate_canonical_resume_binding "$active_color" "$active_port" \
    "$new_bundle" "$release_sha" "$active_image_digest" "$new_runtime_file"; then
    echo "AAIS canonical-check resume does not match the active container, release, digest, and bundle." >&2
    exit 1
  fi
else
  "$bootstrap_wrapper"
  write_rotation_phase runtime-published
  rotation_phase="runtime-published"
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
  if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    --resolve www.aais.site:8443:127.0.0.1 \
    https://www.aais.site:8443/api/system/traffic-readiness \
    | aais_json_validate_traffic_ready "$release_sha" >/dev/null; then
    echo "AAIS loopback Nginx diagnostic path does not match the promoted release." >&2
    exit 1
  fi
  if [[ -e "$rotation_canonical_check_file" \
    || -L "$rotation_canonical_check_file" ]]; then
    echo "AAIS canonical-check marker already exists before the atomic transition." >&2
    exit 1
  fi
  mv -Tf -- "$rotation_pending_file" "$rotation_canonical_check_file"
  canonical_check_active="true"
fi
if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  --resolve www.aais.site:443:127.0.0.1 \
  https://www.aais.site/api/system/traffic-readiness \
  | aais_json_validate_traffic_ready "$release_sha" >/dev/null; then
  echo "AAIS canonical path does not match the promoted release after rotation." >&2
  exit 1
fi
if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]; then
  rotation_invalid_present="true"
  echo "AAIS invalid guard appeared before canonical commit." >&2
  exit 1
fi
write_canonical_phase canonical-passed
rotation_phase="canonical-passed"
canonical_passed="true"
if [[ "$email_timer_was_active" == "true" ]]; then
  systemctl start "$email_timer"
fi
if ! require_timer_target_state "$email_timer" "$email_timer_was_active"; then
  echo "AAIS email timer does not match its durable target state." >&2
  exit 1
fi
if [[ "$lrs_timer_was_active" == "true" ]]; then
  systemctl start "$lrs_timer"
fi
if ! require_timer_target_state "$lrs_timer" "$lrs_timer_was_active"; then
  echo "AAIS LRS timer does not match its durable target state." >&2
  exit 1
fi
if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]; then
  rotation_invalid_present="true"
  echo "AAIS invalid guard appeared before recovery custody cleanup." >&2
  exit 1
fi
timers_stopped="false"
rm -f -- "$local_runtime_previous" "$local_previous_candidate" "$local_rollback_candidate"
rm -f -- "$local_runtime_candidate"
if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]; then
  rotation_invalid_present="true"
  echo "AAIS invalid guard appeared before final marker commit." >&2
  exit 1
fi
trap '' INT TERM HUP
rotation_complete="true"
rm -f -- "$rotation_canonical_check_file"
if [[ -e "$rotation_canonical_check_file" \
  || -L "$rotation_canonical_check_file" ]]; then
  echo "AAIS canonical-check commit marker could not be removed." >&2
  exit 1
fi
canonical_check_active="false"
rotation_pending="false"
unset AAIS_OPERATION_LOCK_FD
trap - EXIT
trap - INT TERM HUP
echo "AAIS secret bundle rotated through an exact-digest blue/green deployment."
