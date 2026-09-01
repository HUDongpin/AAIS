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

aais_json_validate_live() {
  aais_run_json_helper validate-live "$1"
}

aais_json_validate_traffic_ready() {
  aais_run_json_helper validate-traffic-ready "$1"
}

aais_json_validate_public_ready() {
  aais_run_json_helper validate-public-ready
}

aais_require_json_helper

deploy_config_file="${AAIS_DEPLOY_CONFIG_FILE:-/etc/aais/deploy.env}"
if [[ ! -r "$deploy_config_file" ]]; then
  echo "AAIS deploy configuration is unavailable." >&2
  exit 1
fi
deploy_config_mode="$(stat -c '%a' "$deploy_config_file")"
deploy_config_owner="$(stat -c '%u' "$deploy_config_file")"
if [[ "$deploy_config_owner" != "0" || "$deploy_config_mode" != "600" ]]; then
  echo "AAIS deploy configuration must be root-owned with mode 0600." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$deploy_config_file"

: "${AAIS_IMAGE_SOURCE:?AAIS_IMAGE_SOURCE is required}"
if [[ "$AAIS_IMAGE_SOURCE" != "ghcr-preloaded" ]]; then
  echo "AAIS_IMAGE_SOURCE must be ghcr-preloaded." >&2
  exit 1
fi
: "${AAIS_GHCR_REPOSITORY:?AAIS_GHCR_REPOSITORY is required}"
: "${AAIS_EXPECTED_MACHINE_ID_SHA256:?AAIS_EXPECTED_MACHINE_ID_SHA256 is required}"
: "${AAIS_NGINX_CONFIG_FILE:=/www/server/nginx/conf/nginx.conf}"
: "${AAIS_EXPECTED_NGINX_CONFIG_SHA256:?AAIS_EXPECTED_NGINX_CONFIG_SHA256 is required}"
: "${AAIS_NGINX_VHOST_FILE:?AAIS_NGINX_VHOST_FILE is required}"
: "${AAIS_EXPECTED_NGINX_VHOST_SHA256:?AAIS_EXPECTED_NGINX_VHOST_SHA256 is required}"
: "${AAIS_CANDIDATE_RECEIPT_DIR:=/opt/aais/candidates}"
: "${AAIS_PRELOADED_RECEIPT_DIR:=/opt/aais/preloaded}"
: "${AAIS_RUNTIME_ENV_FILE:=/run/aais/current/runtime.env}"
: "${AAIS_NGINX_BINARY:=/www/server/nginx/sbin/nginx}"
: "${AAIS_UPSTREAM_FILE:=/opt/aais/nginx/upstream-active.conf}"
: "${AAIS_STATE_FILE:=/opt/aais/state/active-deployment.env}"
: "${AAIS_OPERATION_LOCK_FILE:=$(dirname "$AAIS_STATE_FILE")/deploy.lock}"
: "${AAIS_ROTATION_PENDING_FILE:=$(dirname "$AAIS_STATE_FILE")/secret-rotation.pending}"
: "${AAIS_ROTATION_CANONICAL_CHECK_FILE:=$(dirname "$AAIS_STATE_FILE")/secret-rotation.canonical-check}"
: "${AAIS_ROTATION_INVALID_FILE:=$(dirname "$AAIS_STATE_FILE")/secret-rotation.invalid}"
: "${AAIS_RECEIPT_DIR:=/opt/aais/receipts}"

for command_name in docker curl flock sha256sum stat awk df install mktemp systemctl ss readlink; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "AAIS deploy dependency is unavailable: ${command_name}." >&2
    exit 1
  fi
done
if [[ "$AAIS_GHCR_REPOSITORY" != "ghcr.io/hudongpin/aais" \
  || "$(dirname -- "$AAIS_CANDIDATE_RECEIPT_DIR")" != "/opt/aais" \
  || "$(dirname -- "$AAIS_PRELOADED_RECEIPT_DIR")" != "/opt/aais" \
  || "$(dirname -- "$AAIS_RECEIPT_DIR")" != "/opt/aais" ]]; then
  echo "AAIS preloaded GHCR bindings are invalid." >&2
  exit 1
fi

require_protected_receipt_directory() {
  local directory="$1"
  local canonical identity_after identity_before mode owner
  identity_before="$(stat -c '%d:%i' "$directory" 2>/dev/null || true)"
  canonical="$(readlink -f -- "$directory" 2>/dev/null || true)"
  owner="$(stat -c '%u' "$directory" 2>/dev/null || true)"
  mode="$(stat -c '%a' "$directory" 2>/dev/null || true)"
  identity_after="$(stat -c '%d:%i' "$directory" 2>/dev/null || true)"
  if [[ ! -d "$directory" || -L "$directory" || -z "$identity_before" \
    || "$identity_after" != "$identity_before" || "$canonical" != "$directory" \
    || "$owner" != "0" || "$mode" != "755" ]]; then
    echo "AAIS protected receipt directory is invalid." >&2
    return 1
  fi
}

require_protected_receipt_directory /opt/aais || exit 1
require_protected_receipt_directory "$AAIS_CANDIDATE_RECEIPT_DIR" || exit 1
require_protected_receipt_directory "$AAIS_PRELOADED_RECEIPT_DIR" || exit 1
require_protected_receipt_directory "$AAIS_RECEIPT_DIR" || exit 1

image_repository="$AAIS_GHCR_REPOSITORY"
if [[ ! "$AAIS_EXPECTED_MACHINE_ID_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS expected machine fingerprint is invalid." >&2
  exit 1
fi
if [[ ! "$AAIS_EXPECTED_NGINX_CONFIG_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS expected Nginx configuration fingerprint is invalid." >&2
  exit 1
fi
if [[ ! "$AAIS_EXPECTED_NGINX_VHOST_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS expected Nginx vhost fingerprint is invalid." >&2
  exit 1
fi
actual_machine_id_sha256="$(sha256sum /etc/machine-id | awk '{ print $1 }')"
actual_nginx_config_sha256="$(sha256sum "$AAIS_NGINX_CONFIG_FILE" | awk '{ print $1 }')"
actual_nginx_vhost_sha256="$(sha256sum "$AAIS_NGINX_VHOST_FILE" | awk '{ print $1 }')"
if [[ "$actual_machine_id_sha256" != "$AAIS_EXPECTED_MACHINE_ID_SHA256" ]]; then
  echo "AAIS deploy target machine fingerprint does not match." >&2
  exit 1
fi
if [[ "$actual_nginx_config_sha256" != "$AAIS_EXPECTED_NGINX_CONFIG_SHA256" ]]; then
  echo "AAIS shared Nginx configuration fingerprint does not match." >&2
  exit 1
fi
if [[ "$actual_nginx_vhost_sha256" != "$AAIS_EXPECTED_NGINX_VHOST_SHA256" ]]; then
  echo "AAIS Nginx vhost fingerprint does not match." >&2
  exit 1
fi
image_ref="${1:-}"
release_sha="${2:-}"
expected_image_prefix="${image_repository}@sha256:"
image_digest="${image_ref#"$expected_image_prefix"}"
if [[ "$image_ref" != "$expected_image_prefix"* || ! "$image_digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS deploy requires an immutable digest from the configured image repository." >&2
  exit 1
fi
if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "AAIS deploy requires a full 40-character Git SHA." >&2
  exit 1
fi
candidate_source_receipt="${AAIS_CANDIDATE_RECEIPT_DIR}/${release_sha}.json"
candidate_receipt_mode="$(stat -c '%a' "$candidate_source_receipt" 2>/dev/null || true)"
candidate_receipt_owner="$(stat -c '%u' "$candidate_source_receipt" 2>/dev/null || true)"
if [[ ! -f "$candidate_source_receipt" || -L "$candidate_source_receipt" \
  || "$candidate_receipt_owner" != "0" || "$candidate_receipt_mode" != "644" ]]; then
  echo "AAIS candidate source receipt must be root-owned with mode 0644." >&2
  exit 1
fi
candidate_metadata="$(aais_run_json_helper candidate-metadata \
  "$candidate_source_receipt" "$release_sha" "sha256:${image_digest}")" || {
  echo "AAIS GHCR candidate receipt does not bind the requested private image." >&2
  exit 1
}
IFS=$'\t' read -r validated_image_digest candidate_run_id candidate_run_attempt \
  <<<"$candidate_metadata"
if [[ "$validated_image_digest" != "sha256:${image_digest}" ]]; then
  echo "AAIS GHCR candidate receipt does not bind the requested private image." >&2
  exit 1
fi
preloaded_source_receipt="${AAIS_PRELOADED_RECEIPT_DIR}/${release_sha}.json"
preloaded_receipt_mode="$(stat -c '%a' "$preloaded_source_receipt" 2>/dev/null || true)"
preloaded_receipt_owner="$(stat -c '%u' "$preloaded_source_receipt" 2>/dev/null || true)"
if [[ ! -f "$preloaded_source_receipt" || -L "$preloaded_source_receipt" \
  || "$preloaded_receipt_owner" != "0" || "$preloaded_receipt_mode" != "644" ]]; then
  echo "AAIS GHCR preloaded receipt must be root-owned with mode 0644." >&2
  exit 1
fi
if ! aais_run_json_helper validate-preloaded "$preloaded_source_receipt" \
  "$release_sha" "sha256:${image_digest}" "$candidate_run_id" \
  "$candidate_run_attempt"; then
  echo "AAIS GHCR preloaded receipt does not match the candidate run and digest." >&2
  exit 1
fi
if [[ ! -x "$AAIS_NGINX_BINARY" || ! -r "$AAIS_NGINX_CONFIG_FILE" ]]; then
  echo "AAIS Nginx runtime is unavailable." >&2
  exit 1
fi
if [[ ! -f "$AAIS_UPSTREAM_FILE" ]]; then
  echo "AAIS bootstrap upstream is unavailable." >&2
  exit 1
fi
if [[ ! -f "$AAIS_RUNTIME_ENV_FILE" ]]; then
  echo "AAIS runtime environment file is unavailable." >&2
  exit 1
fi
runtime_mode="$(stat -c '%a' "$AAIS_RUNTIME_ENV_FILE")"
runtime_owner="$(stat -c '%u' "$AAIS_RUNTIME_ENV_FILE")"
if [[ "$runtime_owner" != "0" || ( "$runtime_mode" != "400" && "$runtime_mode" != "600" ) ]]; then
  echo "AAIS runtime environment file must be root-owned with mode 0400 or 0600." >&2
  exit 1
fi
runtime_database_provider="$(awk -F= '$1 == "AAIS_DATABASE_PROVIDER" { count += 1; value=$2 } END { if (count != 1) exit 1; print value }' "$AAIS_RUNTIME_ENV_FILE")"
runtime_database_transport="$(awk -F= '$1 == "AAIS_DATABASE_TRANSPORT" { count += 1; value=$2 } END { if (count != 1) exit 1; print value }' "$AAIS_RUNTIME_ENV_FILE")"
if [[ "$runtime_database_provider" != "aliyun-postgres" \
  || "$runtime_database_transport" != "unix" ]]; then
  echo "AAIS runtime database must be bound to the Aliyun PostgreSQL Unix socket." >&2
  exit 1
fi
postgres_socket_dir="/run/aais/postgresql"
postgres_socket_identity_before="$(stat -c '%d:%i' "$postgres_socket_dir" 2>/dev/null || true)"
postgres_socket_identity_after="$(stat -c '%d:%i' "$postgres_socket_dir" 2>/dev/null || true)"
postgres_socket_canonical="$(readlink -f -- "$postgres_socket_dir" 2>/dev/null || true)"
postgres_socket_mode="$(stat -c '%a' "$postgres_socket_dir" 2>/dev/null || true)"
if [[ ! -d "$postgres_socket_dir" || -L "$postgres_socket_dir" \
  || -z "$postgres_socket_identity_before" \
  || "$postgres_socket_identity_after" != "$postgres_socket_identity_before" \
  || "$postgres_socket_canonical" != "$postgres_socket_dir" \
  || "$postgres_socket_mode" != "770" ]]; then
  echo "AAIS self-managed PostgreSQL socket directory is invalid." >&2
  exit 1
fi
expected_database_target="$(awk -F= '
  index($0, "AAIS_DATABASE_TARGET_ID=") == 1 {
    count += 1
    value = substr($0, length("AAIS_DATABASE_TARGET_ID=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$AAIS_RUNTIME_ENV_FILE")"
if [[ ! "$expected_database_target" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
  echo "AAIS runtime database target identity is invalid." >&2
  exit 1
fi
expected_secret_bundle="$(awk -F= '
  index($0, "AAIS_SECRET_BUNDLE_VERSION=") == 1 {
    count += 1
    value = substr($0, length("AAIS_SECRET_BUNDLE_VERSION=") + 1)
  }
  END { if (count != 1) exit 1; print value }
' "$AAIS_RUNTIME_ENV_FILE")"
if [[ ! "$expected_secret_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
  echo "AAIS runtime secret bundle identity is invalid." >&2
  exit 1
fi

available_memory_mib="$(awk '/MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
available_disk_mib="$(df -Pk /opt/aais | awk 'NR == 2 { print int($4 / 1024) }')"
if (( available_memory_mib < 3072 )); then
  echo "AAIS capacity gate failed: less than 3 GiB memory is available." >&2
  exit 1
fi
if (( available_disk_mib < 51200 )); then
  echo "AAIS capacity gate failed: less than 50 GiB disk is available." >&2
  exit 1
fi

install -d -o root -g root -m 0755 \
  "$(dirname "$AAIS_STATE_FILE")" "$(dirname "$AAIS_UPSTREAM_FILE")" \
  "$(dirname "$AAIS_OPERATION_LOCK_FILE")" "$AAIS_RECEIPT_DIR"
if [[ "$AAIS_OPERATION_LOCK_FILE" != "$(dirname "$AAIS_STATE_FILE")/deploy.lock" \
  || "$AAIS_ROTATION_PENDING_FILE" != "$(dirname "$AAIS_STATE_FILE")/secret-rotation.pending" \
  || "$AAIS_ROTATION_CANONICAL_CHECK_FILE" != "$(dirname "$AAIS_STATE_FILE")/secret-rotation.canonical-check" \
  || "$AAIS_ROTATION_INVALID_FILE" != "$(dirname "$AAIS_STATE_FILE")/secret-rotation.invalid" \
  || -L "$AAIS_OPERATION_LOCK_FILE" || -L "$AAIS_STATE_FILE" \
  || -L "$AAIS_ROTATION_PENDING_FILE" \
  || -L "$AAIS_ROTATION_CANONICAL_CHECK_FILE" \
  || -L "$AAIS_ROTATION_INVALID_FILE" ]]; then
  echo "AAIS operation lock path is invalid." >&2
  exit 1
fi
inherited_operation_lock_fd="${AAIS_OPERATION_LOCK_FD:-}"
rotation_lock_inherited="false"
if [[ -n "$inherited_operation_lock_fd" ]]; then
  if [[ ! "$inherited_operation_lock_fd" =~ ^[3-9][0-9]*$ \
    || "$(readlink -f "/proc/$$/fd/${inherited_operation_lock_fd}" 2>/dev/null || true)" \
      != "$(readlink -f "$AAIS_OPERATION_LOCK_FILE" 2>/dev/null || true)" \
    ]] || ! flock -n "$inherited_operation_lock_fd"; then
    echo "AAIS inherited operation lock is invalid." >&2
    exit 1
  fi
  rotation_lock_inherited="true"
else
  exec 9>"$AAIS_OPERATION_LOCK_FILE"
  if ! flock -n 9; then
    echo "Another AAIS deployment or secret rotation is already running." >&2
    exit 1
  fi
fi
if [[ -e "$AAIS_ROTATION_CANONICAL_CHECK_FILE" ]]; then
  echo "AAIS deployment is fenced during the canonical secret check." >&2
  exit 1
fi
if [[ -e "$AAIS_ROTATION_INVALID_FILE" ]]; then
  echo "AAIS deployment is fenced by an invalid secret rotation state." >&2
  exit 1
fi
if [[ -e "$AAIS_ROTATION_PENDING_FILE" \
  && "$rotation_lock_inherited" != "true" ]]; then
  echo "AAIS secret rotation state requires the verified inherited operation lock." >&2
  exit 1
fi

email_timer="aais-email-outbox.timer"
lrs_timer="aais-lrs-outbox.timer"
email_service="aais-email-outbox.service"
lrs_service="aais-lrs-outbox.service"

read_systemd_active_state() {
  local unit="$1"
  local active_state=""
  local active_state_seen="false"
  local line
  local line_count=0
  local load_state=""
  local load_state_seen="false"
  local output
  if ! output="$(systemctl show --property=LoadState --property=ActiveState \
    "$unit" 2>/dev/null)"; then
    echo "AAIS systemd state query failed: ${unit}." >&2
    return 1
  fi
  while IFS= read -r line; do
    line_count=$((line_count + 1))
    case "$line" in
      LoadState=*)
        if [[ "$load_state_seen" == "true" ]]; then
          echo "AAIS systemd returned duplicate state fields: ${unit}." >&2
          return 1
        fi
        load_state_seen="true"
        load_state="${line#LoadState=}"
        ;;
      ActiveState=*)
        if [[ "$active_state_seen" == "true" ]]; then
          echo "AAIS systemd returned duplicate state fields: ${unit}." >&2
          return 1
        fi
        active_state_seen="true"
        active_state="${line#ActiveState=}"
        ;;
      *)
        echo "AAIS systemd returned unexpected state fields: ${unit}." >&2
        return 1
        ;;
    esac
  done <<<"$output"
  if [[ "$line_count" -ne 2 || "$load_state_seen" != "true" \
    || "$active_state_seen" != "true" || "$load_state" != "loaded" \
    || -z "$active_state" ]]; then
    echo "AAIS systemd unit is unavailable or has an invalid state: ${unit}." >&2
    return 1
  fi
  printf '%s\n' "$active_state"
}

email_timer_snapshot="$(read_systemd_active_state "$email_timer")" || exit 1
lrs_timer_snapshot="$(read_systemd_active_state "$lrs_timer")" || exit 1
if [[ "$email_timer_snapshot" != "active" \
  && "$email_timer_snapshot" != "inactive" ]]; then
  echo "AAIS email timer is not in a stable active/inactive state." >&2
  exit 1
fi
if [[ "$lrs_timer_snapshot" != "active" \
  && "$lrs_timer_snapshot" != "inactive" ]]; then
  echo "AAIS LRS timer is not in a stable active/inactive state." >&2
  exit 1
fi
email_timer_was_active="false"
lrs_timer_was_active="false"
if [[ "$email_timer_snapshot" == "active" ]]; then
  email_timer_was_active="true"
fi
if [[ "$lrs_timer_snapshot" == "active" ]]; then
  lrs_timer_was_active="true"
fi

normalized_upstream="$(tr -d '[:space:]' < "$AAIS_UPSTREAM_FILE")"
if [[ "$normalized_upstream" == "server127.0.0.1:3101;" ]]; then
  upstream_color="blue"
  upstream_port="3101"
elif [[ "$normalized_upstream" == "server127.0.0.1:3102;" ]]; then
  upstream_color="green"
  upstream_port="3102"
else
  echo "AAIS Nginx upstream state is invalid." >&2
  exit 1
fi

read_active_state_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END { if (count != 1) exit 1; print value }
  ' "$AAIS_STATE_FILE"
}

nginx_loaded_release_matches() {
  local expected_release="$1"
  for _ in $(seq 1 30); do
    if curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
      --resolve www.aais.site:8443:127.0.0.1 \
      https://www.aais.site:8443/api/system/traffic-readiness 2>/dev/null \
      | aais_json_validate_traffic_ready "$expected_release" \
        >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

recovery_container_matches_request() {
  local color="$1"
  local port="$2"
  local container="aais-${color}"
  local binding bundle database_target digest release
  [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] \
    || return 1
  binding="$(docker port "$container" 3000/tcp 2>/dev/null || true)"
  database_target="$(docker exec "$container" printenv AAIS_DATABASE_TARGET_ID 2>/dev/null || true)"
  bundle="$(docker exec "$container" printenv AAIS_SECRET_BUNDLE_VERSION 2>/dev/null || true)"
  release="$(docker exec "$container" printenv AAIS_DEPLOYMENT_GIT_COMMIT_SHA 2>/dev/null || true)"
  digest="$(docker inspect --format '{{ index .Config.Labels "aais.image.digest" }}' "$container" 2>/dev/null || true)"
  [[ "$binding" == "127.0.0.1:${port}" \
    && "$database_target" == "$expected_database_target" \
    && "$bundle" == "$expected_secret_bundle" \
    && "$release" == "$release_sha" \
    && "$digest" == "sha256:${image_digest}" ]] || return 1
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    "http://127.0.0.1:${port}/api/system/live" \
    | aais_json_validate_live "$release_sha" >/dev/null || return 1
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    "http://127.0.0.1:${port}/api/system/traffic-readiness" \
    | aais_json_validate_traffic_ready "$release_sha" >/dev/null
}

commit_recovered_active_state() {
  local color="$1"
  local port="$2"
  local recovery_state
  recovery_state="$(mktemp "$(dirname "$AAIS_STATE_FILE")/active-deployment.recovery.XXXXXX")"
  printf 'AAIS_ACTIVE_COLOR=%s\nAAIS_ACTIVE_PORT=%s\nAAIS_ACTIVE_SECRET_BUNDLE_VERSION=%s\nAAIS_ACTIVE_RELEASE_SHA=%s\nAAIS_ACTIVE_IMAGE_DIGEST=sha256:%s\n' \
    "$color" "$port" "$expected_secret_bundle" "$release_sha" "$image_digest" \
    > "$recovery_state"
  chown root:root "$recovery_state"
  chmod 0644 "$recovery_state"
  mv -Tf -- "$recovery_state" "$AAIS_STATE_FILE"
}

active_color=""
if [[ -r "$AAIS_STATE_FILE" ]]; then
  active_color="$(read_active_state_value AAIS_ACTIVE_COLOR 2>/dev/null || true)"
fi
if [[ -z "$active_color" ]]; then
  if [[ "$(docker inspect --format '{{.State.Running}}' "aais-${upstream_color}" 2>/dev/null || true)" == "true" ]]; then
    if ! recovery_container_matches_request "$upstream_color" "$upstream_port"; then
      echo "AAIS unrecorded Nginx upstream cannot be reconciled to the requested release." >&2
      exit 1
    fi
    "$AAIS_NGINX_BINARY" -t >/dev/null
    "$AAIS_NGINX_BINARY" -s reload >/dev/null
    if ! nginx_loaded_release_matches "$release_sha"; then
      echo "AAIS effective Nginx upstream did not load the interrupted bootstrap promotion." >&2
      exit 1
    fi
    commit_recovered_active_state "$upstream_color" "$upstream_port"
    active_color="$upstream_color"
    echo "AAIS finalized a verified interrupted bootstrap promotion." >&2
  elif [[ "$upstream_color" != "blue" ]]; then
    echo "AAIS bootstrap state cannot point to the green port." >&2
    exit 1
  fi
elif [[ "$active_color" != "$upstream_color" ]]; then
  if ! recovery_container_matches_request "$upstream_color" "$upstream_port"; then
    echo "AAIS active state and Nginx upstream disagree without a verifiable promotion." >&2
    exit 1
  fi
  "$AAIS_NGINX_BINARY" -t >/dev/null
  "$AAIS_NGINX_BINARY" -s reload >/dev/null
  if ! nginx_loaded_release_matches "$release_sha"; then
    echo "AAIS effective Nginx upstream did not load the interrupted promotion." >&2
    exit 1
  fi
  commit_recovered_active_state "$upstream_color" "$upstream_port"
  active_color="$upstream_color"
  echo "AAIS finalized a verified interrupted Nginx promotion." >&2
fi

if [[ "$active_color" == "blue" ]]; then
  target_color="green"
  target_port="3102"
  active_port="3101"
elif [[ "$active_color" == "green" ]]; then
  target_color="blue"
  target_port="3101"
  active_port="3102"
elif [[ -z "$active_color" ]]; then
  target_color="blue"
  target_port="3101"
  active_port=""
else
  echo "AAIS active color state is invalid." >&2
  exit 1
fi
active_secret_bundle=""
active_release_sha=""
active_image_digest=""
if [[ -n "$active_color" ]]; then
  active_state_owner="$(stat -c '%u' "$AAIS_STATE_FILE" 2>/dev/null || true)"
  active_state_mode="$(stat -c '%a' "$AAIS_STATE_FILE" 2>/dev/null || true)"
  active_state_port="$(awk -F= '$1 == "AAIS_ACTIVE_PORT" { count += 1; value=$2 } END { if (count != 1) exit 1; print value }' "$AAIS_STATE_FILE")"
  active_secret_bundle="$(awk -F= '$1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" { count += 1; value=substr($0, index($0, "=") + 1) } END { if (count != 1) exit 1; print value }' "$AAIS_STATE_FILE")"
  active_release_sha="$(awk -F= '$1 == "AAIS_ACTIVE_RELEASE_SHA" { count += 1; value=$2 } END { if (count != 1) exit 1; print value }' "$AAIS_STATE_FILE")"
  active_image_digest="$(awk -F= '$1 == "AAIS_ACTIVE_IMAGE_DIGEST" { count += 1; value=$2 } END { if (count != 1) exit 1; print value }' "$AAIS_STATE_FILE")"
  if [[ "$active_state_owner" != "0" || "$active_state_mode" != "644" \
    || "$active_state_port" != "$active_port" \
    || ! "$active_secret_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
    || ! "$active_release_sha" =~ ^[a-f0-9]{40}$ \
    || ! "$active_image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "AAIS atomic active deployment state is invalid." >&2
    exit 1
  fi
  if [[ "$active_secret_bundle" != "$expected_secret_bundle" \
    && ! -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
    echo "AAIS secret bundle changed without the guarded rotation marker." >&2
    exit 1
  fi
fi
target_container="aais-${target_color}"
active_container="${active_color:+aais-${active_color}}"
active_container_was_running="false"
if [[ -n "$active_container" ]]; then
  if [[ "$(docker inspect --format '{{.State.Running}}' "$active_container" 2>/dev/null || true)" == "true" ]]; then
    active_container_was_running="true"
    active_binding="$(docker port "$active_container" 3000/tcp 2>/dev/null || true)"
    if [[ "$active_binding" != "127.0.0.1:${active_port}" ]]; then
      echo "AAIS active container port binding does not match the recorded upstream." >&2
      exit 1
    fi
    running_active_bundle="$(docker exec "$active_container" printenv AAIS_SECRET_BUNDLE_VERSION 2>/dev/null || true)"
    if [[ "$running_active_bundle" != "$active_secret_bundle" ]]; then
      echo "AAIS active container secret bundle does not match the recorded state." >&2
      exit 1
    fi
    running_active_release="$(docker exec "$active_container" printenv AAIS_DEPLOYMENT_GIT_COMMIT_SHA 2>/dev/null || true)"
    running_active_digest="$(docker inspect --format '{{ index .Config.Labels "aais.image.digest" }}' "$active_container" 2>/dev/null || true)"
    if [[ "$running_active_release" != "$active_release_sha" \
      || "$running_active_digest" != "$active_image_digest" ]]; then
      echo "AAIS active container provenance does not match the atomic deployment state." >&2
      exit 1
    fi
  else
    echo "AAIS recorded active container is unavailable; entering exact-digest recovery mode." >&2
  fi
fi

operation_id="$(date -u +'%Y%m%dT%H%M%SZ')-${release_sha:0:12}-$$"
receipt_file="${AAIS_RECEIPT_DIR}/${operation_id}.json"
if [[ -e "$receipt_file" ]]; then
  echo "AAIS release operation receipt already exists." >&2
  exit 1
fi

transaction_dir="$(mktemp -d "$(dirname "$AAIS_STATE_FILE")/deploy.XXXXXX")"
previous_upstream="${transaction_dir}/previous-upstream"
previous_state="${transaction_dir}/previous-state"
candidate_state="${transaction_dir}/candidate-state"
candidate_upstream="$(mktemp "$(dirname "$AAIS_UPSTREAM_FILE")/.aais-upstream.candidate.XXXXXX")"
candidate_receipt="$(mktemp "${AAIS_RECEIPT_DIR}/.aais-deployment-receipt.candidate.XXXXXX")"
cp "$AAIS_UPSTREAM_FILE" "$previous_upstream"
if [[ -f "$AAIS_STATE_FILE" ]]; then
  cp "$AAIS_STATE_FILE" "$previous_state"
fi

upstream_publish_attempted="false"
nginx_reload_attempted="false"
state_commit_attempted="false"
receipt_publish_attempted="false"

timers_paused="false"

pause_worker_timers() {
  local email_state lrs_state
  timers_paused="true"
  if [[ "$email_timer_was_active" == "true" ]]; then
    systemctl stop "$email_timer"
  fi
  if [[ "$lrs_timer_was_active" == "true" ]]; then
    systemctl stop "$lrs_timer"
  fi
  email_state="$(read_systemd_active_state "$email_timer")" || return 1
  lrs_state="$(read_systemd_active_state "$lrs_timer")" || return 1
  if [[ "$email_state" != "inactive" || "$lrs_state" != "inactive" ]]; then
    echo "AAIS worker timers did not reach the exact inactive state." >&2
    return 1
  fi
  for _ in $(seq 1 130); do
    email_state="$(read_systemd_active_state "$email_service")" || return 1
    lrs_state="$(read_systemd_active_state "$lrs_service")" || return 1
    case "$email_state" in
      inactive) ;;
      active|activating|deactivating|reloading) ;;
      *)
        echo "AAIS email worker entered an unsafe systemd state." >&2
        return 1
        ;;
    esac
    case "$lrs_state" in
      inactive) ;;
      active|activating|deactivating|reloading) ;;
      *)
        echo "AAIS LRS worker entered an unsafe systemd state." >&2
        return 1
        ;;
    esac
    if [[ "$email_state" == "inactive" && "$lrs_state" == "inactive" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "AAIS worker services did not drain before deployment." >&2
  return 1
}

resume_worker_timers() {
  local email_state lrs_state
  local failed="false"
  if [[ "$timers_paused" != "true" ]]; then
    return 0
  fi
  if [[ "$email_timer_was_active" == "true" ]]; then
    systemctl start "$email_timer" || failed="true"
  fi
  if [[ "$lrs_timer_was_active" == "true" ]]; then
    systemctl start "$lrs_timer" || failed="true"
  fi
  if [[ "$failed" == "true" ]]; then
    return 1
  fi
  for _ in $(seq 1 30); do
    email_state="$(read_systemd_active_state "$email_timer")" || return 1
    lrs_state="$(read_systemd_active_state "$lrs_timer")" || return 1
    if [[ "$email_state" == "$email_timer_snapshot" \
      && "$lrs_state" == "$lrs_timer_snapshot" ]]; then
      timers_paused="false"
      return 0
    fi
    case "${email_timer_snapshot}:${email_state}" in
      active:activating|active:reloading|inactive:deactivating) ;;
      *)
        echo "AAIS email timer did not restore its exact snapshot state." >&2
        return 1
        ;;
    esac
    case "${lrs_timer_snapshot}:${lrs_state}" in
      active:activating|active:reloading|inactive:deactivating) ;;
      *)
        echo "AAIS LRS timer did not restore its exact snapshot state." >&2
        return 1
        ;;
    esac
    sleep 1
  done
  echo "AAIS worker timers did not restore their snapshot states." >&2
  return 1
}

cleanup_transaction_files() {
  rm -f -- \
    "$previous_upstream" "$previous_state" "$candidate_upstream" \
    "$candidate_state" "$candidate_receipt"
  rmdir -- "$transaction_dir" >/dev/null 2>&1 || true
}

restore_previous_upstream_file() {
  install -o root -g root -m 0644 "$previous_upstream" "$candidate_upstream" \
    || return 1
  mv -Tf -- "$candidate_upstream" "$AAIS_UPSTREAM_FILE"
}

container_matches_expected_runtime() {
  local container_name="$1"
  local container_port="$2"
  local expected_release="$3"
  local expected_digest="$4"
  local expected_bundle="$5"
  local container_binding container_bundle container_digest container_release container_target
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" != "true" ]]; then
    return 1
  fi
  container_binding="$(docker port "$container_name" 3000/tcp 2>/dev/null)"
  if [[ "$container_binding" != "127.0.0.1:${container_port}" ]]; then
    return 1
  fi
  container_target="$(docker exec "$container_name" printenv AAIS_DATABASE_TARGET_ID 2>/dev/null)"
  if [[ "$container_target" != "$expected_database_target" ]]; then
    return 1
  fi
  container_bundle="$(docker exec "$container_name" printenv AAIS_SECRET_BUNDLE_VERSION 2>/dev/null)"
  container_release="$(docker exec "$container_name" printenv AAIS_DEPLOYMENT_GIT_COMMIT_SHA 2>/dev/null)"
  container_digest="$(docker inspect --format '{{ index .Config.Labels "aais.image.digest" }}' "$container_name" 2>/dev/null)"
  if [[ "$container_bundle" != "$expected_bundle" \
    || "$container_release" != "$expected_release" \
    || "$container_digest" != "$expected_digest" ]]; then
    return 1
  fi
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    "http://127.0.0.1:${container_port}/api/system/live" \
    | aais_json_validate_live "$expected_release" >/dev/null || return 1
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    "http://127.0.0.1:${container_port}/api/system/traffic-readiness" \
    | aais_json_validate_traffic_ready "$expected_release" >/dev/null || return 1
}

nginx_path_is_healthy() {
  local expected_release="$1"
  local status_code
  nginx_loaded_release_matches "$expected_release" || return 1
  if [[ -f /opt/aais/state/maintenance.enabled \
    || -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
    status_code="$(curl --disable --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 10 --max-filesize 65536 \
      --resolve www.aais.site:443:127.0.0.1 https://www.aais.site/)" || return 1
    [[ "$status_code" == "503" ]]
    return
  fi
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    --resolve www.aais.site:443:127.0.0.1 \
    https://www.aais.site/api/system/traffic-readiness \
    | aais_json_validate_traffic_ready "$expected_release" >/dev/null
}

restore_previous_path() {
  if [[ -z "$active_container" || -z "$active_port" ]]; then
    return 1
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$active_container" 2>/dev/null)" != "true" ]]; then
    docker start "$active_container" >/dev/null || return 1
  fi
  for _ in $(seq 1 60); do
    if container_matches_expected_runtime \
      "$active_container" "$active_port" "$active_release_sha" \
      "$active_image_digest" "$active_secret_bundle"; then
      break
    fi
    sleep 1
  done
  container_matches_expected_runtime \
    "$active_container" "$active_port" "$active_release_sha" \
    "$active_image_digest" "$active_secret_bundle" || return 1
  restore_previous_upstream_file || return 1
  "$AAIS_NGINX_BINARY" -t >/dev/null || return 1
  "$AAIS_NGINX_BINARY" -s reload >/dev/null || return 1
  nginx_path_is_healthy "$active_release_sha"
}

restore_previous_bootstrap_path() {
  local current_sha previous_sha
  restore_previous_upstream_file || return 1
  "$AAIS_NGINX_BINARY" -t >/dev/null || return 1
  "$AAIS_NGINX_BINARY" -s reload >/dev/null || return 1
  previous_sha="$(sha256sum "$previous_upstream" | awk '{ print $1 }')" \
    || return 1
  current_sha="$(sha256sum "$AAIS_UPSTREAM_FILE" | awk '{ print $1 }')" \
    || return 1
  [[ "$current_sha" == "$previous_sha" ]]
}

drain_active_connections() {
  local connection_state
  if [[ -z "$active_port" ]]; then
    return 0
  fi
  for _ in $(seq 1 330); do
    connection_state="$(ss -Htn state established \
      | awk -v port=":${active_port}" '
        $4 ~ port "$" || $5 ~ port "$" { found = 1 }
        END { print(found ? "true" : "false") }
      ')" || {
      echo "AAIS active connection state query failed." >&2
      return 1
    }
    case "$connection_state" in
      false) return 0 ;;
      true) ;;
      *)
        echo "AAIS active connection state query returned invalid output." >&2
        return 1
        ;;
    esac
    sleep 1
  done
  echo "AAIS old container still has active HTTP/SSE connections." >&2
  return 1
}

rollback_on_error() {
  local status=$?
  local recovered="false"
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  if [[ "$nginx_reload_attempted" == "true" ]]; then
    if [[ -z "$active_container" ]] && restore_previous_bootstrap_path; then
      recovered="true"
    elif [[ -n "$active_container" ]] && restore_previous_path; then
      recovered="true"
    fi
  elif [[ "$upstream_publish_attempted" == "true" ]]; then
    if restore_previous_upstream_file; then
      if [[ -z "$active_container" ]]; then
        recovered="true"
      elif container_matches_expected_runtime \
        "$active_container" "$active_port" "$active_release_sha" \
        "$active_image_digest" "$active_secret_bundle" \
        && nginx_path_is_healthy "$active_release_sha"; then
        recovered="true"
      fi
    fi
  elif [[ -z "$active_container" ]]; then
    recovered="true"
  elif container_matches_expected_runtime \
    "$active_container" "$active_port" "$active_release_sha" \
    "$active_image_digest" "$active_secret_bundle" \
    && nginx_path_is_healthy "$active_release_sha"; then
    recovered="true"
  fi

  if [[ "$recovered" == "true" ]]; then
    if [[ "$state_commit_attempted" == "true" ]]; then
      if [[ -f "$previous_state" ]]; then
        install -o root -g root -m 0644 "$previous_state" "$candidate_state"
        mv -Tf -- "$candidate_state" "$AAIS_STATE_FILE"
      else
        rm -f -- "$AAIS_STATE_FILE"
      fi
    fi
    if resume_worker_timers; then
      if [[ "$receipt_publish_attempted" == "true" ]]; then
        rm -f -- "$receipt_file"
      fi
      docker rm -f "$target_container" >/dev/null 2>&1 || true
      cleanup_transaction_files
      echo "AAIS deployment failed; the previous verified path was restored." >&2
      exit "$status"
    fi
  fi

  echo "AAIS automatic rollback could not be verified; candidate and prior containers were preserved and worker timers remain stopped." >&2
  exit "$status"
}
trap rollback_on_error EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

image_revision="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$image_ref")"
image_repo_digests="$(docker image inspect \
  --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref")"
image_repo_digest_matches="false"
while IFS= read -r local_repo_digest; do
  if [[ "$local_repo_digest" == "$image_ref" ]]; then
    image_repo_digest_matches="true"
    break
  fi
done <<<"$image_repo_digests"
if [[ "$image_repo_digest_matches" != "true" || "$image_revision" != "$release_sha" ]]; then
  echo "AAIS local image RepoDigest or OCI revision does not match the requested release." >&2
  exit 1
fi

docker network inspect aais-net >/dev/null 2>&1 || docker network create aais-net >/dev/null
if docker container inspect "$target_container" >/dev/null 2>&1; then
  docker rm -f "$target_container" >/dev/null
fi

docker run --detach \
  --name "$target_container" \
  --network aais-net \
  --publish "127.0.0.1:${target_port}:3000" \
  --cpus 1.25 \
  --memory 1280m \
  --pids-limit 256 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777,uid=10001,gid=10001 \
  --tmpfs /app/.next/cache:rw,noexec,nosuid,size=256m,mode=0700,uid=10001,gid=10001 \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --restart unless-stopped \
  --volume /run/aais/postgresql:/run/aais/postgresql:ro \
  --env-file "$AAIS_RUNTIME_ENV_FILE" \
  --env NODE_OPTIONS=--max-old-space-size=768 \
  --env AAIS_DEPLOYMENT_PROVIDER=aliyun \
  --env AAIS_RELEASE_ID="$release_sha" \
  --env AAIS_DEPLOYMENT_GIT_COMMIT_SHA="$release_sha" \
  --env AAIS_DATABASE_POOL_MAX=5 \
  --env AAIS_TRUSTED_PROXY_IP_HEADER=x-real-ip \
  --label "aais.image.digest=sha256:${image_digest}" \
  "$image_ref" >/dev/null

for _ in $(seq 1 60); do
  if curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    "http://127.0.0.1:${target_port}/api/system/live" >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  "http://127.0.0.1:${target_port}/api/system/live" \
  | aais_json_validate_live "$release_sha" >/dev/null; then
  echo "AAIS candidate liveness provenance does not match." >&2
  exit 1
fi
if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  "http://127.0.0.1:${target_port}/api/system/traffic-readiness" \
  | aais_json_validate_traffic_ready "$release_sha" >/dev/null; then
  echo "AAIS candidate traffic readiness does not match." >&2
  exit 1
fi
if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
  "http://127.0.0.1:${target_port}/api/system/readiness" \
  | aais_json_validate_public_ready >/dev/null; then
  echo "AAIS candidate comprehensive readiness is not ready." >&2
  exit 1
fi
if ! container_matches_expected_runtime \
  "$target_container" "$target_port" "$release_sha" \
  "sha256:${image_digest}" "$expected_secret_bundle"; then
  echo "AAIS candidate runtime binding does not match the current secret and database generation." >&2
  exit 1
fi
post_candidate_memory_mib="$(awk '/MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
post_candidate_disk_mib="$(df -Pk /opt/aais | awk 'NR == 2 { print int($4 / 1024) }')"
if (( post_candidate_memory_mib < 2048 || post_candidate_disk_mib < 51200 )); then
  echo "AAIS post-candidate host capacity gate failed." >&2
  exit 1
fi

printf 'server 127.0.0.1:%s;\n' "$target_port" > "$candidate_upstream"
printf 'AAIS_ACTIVE_COLOR=%s\nAAIS_ACTIVE_PORT=%s\nAAIS_ACTIVE_SECRET_BUNDLE_VERSION=%s\nAAIS_ACTIVE_RELEASE_SHA=%s\nAAIS_ACTIVE_IMAGE_DIGEST=sha256:%s\n' \
  "$target_color" "$target_port" "$expected_secret_bundle" "$release_sha" "$image_digest" \
  > "$candidate_state"
container_id="$(docker inspect --format '{{.Id}}' "$target_container")"
if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS candidate container identity is invalid." >&2
  exit 1
fi
container_id_short="${container_id:0:12}"
upstream_sha="$(sha256sum "$candidate_upstream" | awk '{ print $1 }')"
deployed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
if ! aais_run_json_helper write-deployment \
  "$release_sha" "sha256:${image_digest}" "$expected_secret_bundle" \
  "$target_color" "$target_port" "$container_id_short" "$upstream_sha" \
  "$actual_nginx_vhost_sha256" "$deployed_at" > "$candidate_receipt"; then
  echo "AAIS deployment receipt generation failed." >&2
  exit 1
fi
if ! aais_run_json_helper validate-deployment "$candidate_receipt" \
  "$release_sha" "sha256:${image_digest}" "$expected_secret_bundle" \
  "$target_color" "$target_port" "$container_id_short" "$upstream_sha" \
  "$actual_nginx_vhost_sha256" "$deployed_at"; then
  echo "AAIS deployment receipt validation failed." >&2
  exit 1
fi

pause_worker_timers
chown root:root "$candidate_upstream"
chmod 0644 "$candidate_upstream"
upstream_publish_attempted="true"
mv -Tf -- "$candidate_upstream" "$AAIS_UPSTREAM_FILE"
"$AAIS_NGINX_BINARY" -t >/dev/null
nginx_reload_attempted="true"
"$AAIS_NGINX_BINARY" -s reload >/dev/null

if [[ -f /opt/aais/state/maintenance.enabled \
  || -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
  maintenance_status="$(curl --disable --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 10 --max-filesize 65536 \
    --resolve www.aais.site:443:127.0.0.1 https://www.aais.site/)"
  if [[ "$maintenance_status" != "503" ]]; then
    echo "AAIS maintenance proxy gate is not active." >&2
    exit 1
  fi
else
  if ! curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 --max-filesize 65536 \
    --resolve www.aais.site:443:127.0.0.1 \
    https://www.aais.site/api/system/traffic-readiness \
    | aais_json_validate_traffic_ready "$release_sha" >/dev/null; then
    echo "AAIS Nginx/TLS promotion check does not match." >&2
    exit 1
  fi
fi

chown root:root "$candidate_state"
chmod 0644 "$candidate_state"
state_commit_attempted="true"
mv -Tf -- "$candidate_state" "$AAIS_STATE_FILE"

drain_active_connections
if [[ -n "$active_container" && "$active_container_was_running" == "true" ]]; then
  docker stop --time 30 "$active_container" >/dev/null
fi
resume_worker_timers
if ! container_matches_expected_runtime \
  "$target_container" "$target_port" "$release_sha" \
  "sha256:${image_digest}" "$expected_secret_bundle" \
  || ! nginx_path_is_healthy "$release_sha"; then
  echo "AAIS final promoted path verification failed." >&2
  exit 1
fi
chown root:root "$candidate_receipt"
chmod 0644 "$candidate_receipt"
receipt_publish_attempted="true"
trap '' INT TERM HUP
mv -Tf -- "$candidate_receipt" "$receipt_file"

trap - EXIT
cleanup_transaction_files
printf 'AAIS deployment promoted: %s %s %s\n' \
  "$release_sha" "sha256:${image_digest}" "$target_color"
