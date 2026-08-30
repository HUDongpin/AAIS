#!/usr/bin/env bash
set -Eeuo pipefail

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

: "${AAIS_ACR_REPOSITORY:?AAIS_ACR_REPOSITORY is required}"
: "${AAIS_ACR_INSTANCE_ID:?AAIS_ACR_INSTANCE_ID is required}"
: "${AAIS_ACR_API_ENDPOINT:?AAIS_ACR_API_ENDPOINT is required}"
: "${AAIS_ACR_LOGIN_SERVER:?AAIS_ACR_LOGIN_SERVER is required}"
: "${AAIS_ACR_PUBLIC_LOGIN_SERVER:?AAIS_ACR_PUBLIC_LOGIN_SERVER is required}"
: "${AAIS_ALIYUN_CLI:=/usr/local/bin/aliyun}"
: "${AAIS_ALIYUN_CLI_PROFILE:=aais-ecs-role}"
: "${AAIS_EXPECTED_MACHINE_ID_SHA256:?AAIS_EXPECTED_MACHINE_ID_SHA256 is required}"
: "${AAIS_NGINX_CONFIG_FILE:=/www/server/nginx/conf/nginx.conf}"
: "${AAIS_EXPECTED_NGINX_CONFIG_SHA256:?AAIS_EXPECTED_NGINX_CONFIG_SHA256 is required}"
: "${AAIS_NGINX_VHOST_FILE:?AAIS_NGINX_VHOST_FILE is required}"
: "${AAIS_EXPECTED_NGINX_VHOST_SHA256:?AAIS_EXPECTED_NGINX_VHOST_SHA256 is required}"
: "${AAIS_CANDIDATE_RECEIPT_DIR:=/opt/aais/candidates}"
: "${AAIS_DATABASE_CA_FILE:=}"
: "${AAIS_EXPECTED_DATABASE_CA_SHA256:=}"
: "${AAIS_RUNTIME_ENV_FILE:=/run/aais/current/runtime.env}"
: "${AAIS_NGINX_BINARY:=/www/server/nginx/sbin/nginx}"
: "${AAIS_UPSTREAM_FILE:=/opt/aais/nginx/upstream-active.conf}"
: "${AAIS_STATE_FILE:=/opt/aais/state/active-deployment.env}"
: "${AAIS_OPERATION_LOCK_FILE:=$(dirname "$AAIS_STATE_FILE")/deploy.lock}"
: "${AAIS_ROTATION_PENDING_FILE:=$(dirname "$AAIS_STATE_FILE")/secret-rotation.pending}"
: "${AAIS_RECEIPT_DIR:=/opt/aais/receipts}"

for command_name in docker curl jq flock sha256sum stat awk df install mktemp systemctl ss readlink; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "AAIS deploy dependency is unavailable: ${command_name}." >&2
    exit 1
  fi
done
if [[ ! -x "$AAIS_ALIYUN_CLI" ]]; then
  echo "AAIS Alibaba Cloud CLI is unavailable." >&2
  exit 1
fi
if [[ "$AAIS_ACR_REPOSITORY" != "$AAIS_ACR_LOGIN_SERVER/"* ]]; then
  echo "AAIS ACR repository must use the configured Enterprise login server." >&2
  exit 1
fi
if [[ ! "$AAIS_ACR_INSTANCE_ID" =~ ^cri-[a-z0-9-]+$ \
  || ! "$AAIS_ACR_API_ENDPOINT" =~ ^cr\.[a-z0-9-]+\.aliyuncs\.com$ \
  || ! "$AAIS_ACR_LOGIN_SERVER" =~ ^[a-z0-9][a-z0-9.-]*\.cr\.aliyuncs\.com$ \
  || "$AAIS_ACR_PUBLIC_LOGIN_SERVER" == "$AAIS_ACR_LOGIN_SERVER" \
  || ! "$AAIS_ACR_PUBLIC_LOGIN_SERVER" =~ ^[a-z0-9][a-z0-9.-]*\.cr\.aliyuncs\.com$ ]]; then
  echo "AAIS ACR public and VPC login-server bindings are invalid." >&2
  exit 1
fi
aais_repository_path="${AAIS_ACR_REPOSITORY#"$AAIS_ACR_LOGIN_SERVER"/}"
if [[ ! "$aais_repository_path" =~ ^[a-z0-9][a-z0-9._-]*/aais$ ]]; then
  echo "AAIS ACR repository path is invalid." >&2
  exit 1
fi
expected_public_push_repository="${AAIS_ACR_PUBLIC_LOGIN_SERVER}/${aais_repository_path}"
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
database_ca_args=()
if [[ -n "$AAIS_DATABASE_CA_FILE" || -n "$AAIS_EXPECTED_DATABASE_CA_SHA256" ]]; then
  if [[ "$AAIS_DATABASE_CA_FILE" != /etc/aais/tls/* \
    || ! "$AAIS_EXPECTED_DATABASE_CA_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    echo "AAIS database CA binding is invalid." >&2
    exit 1
  fi
  if [[ ! -f "$AAIS_DATABASE_CA_FILE" ]]; then
    echo "AAIS database CA file is unavailable." >&2
    exit 1
  fi
  database_ca_owner="$(stat -c '%u' "$AAIS_DATABASE_CA_FILE" 2>/dev/null || true)"
  database_ca_mode="$(stat -c '%a' "$AAIS_DATABASE_CA_FILE" 2>/dev/null || true)"
  database_ca_sha256="$(sha256sum "$AAIS_DATABASE_CA_FILE" 2>/dev/null | awk '{ print $1 }')"
  if [[ "$database_ca_owner" != "0" \
    || ( "$database_ca_mode" != "444" && "$database_ca_mode" != "644" ) \
    || "$database_ca_sha256" != "$AAIS_EXPECTED_DATABASE_CA_SHA256" ]]; then
    echo "AAIS database CA file does not match its protected fingerprint." >&2
    exit 1
  fi
  database_ca_args=(
    --mount "type=bind,src=${AAIS_DATABASE_CA_FILE},dst=/etc/aais/rds-ca.pem,readonly"
  )
fi

image_ref="${1:-}"
release_sha="${2:-}"
expected_image_prefix="${AAIS_ACR_REPOSITORY}@sha256:"
image_digest="${image_ref#"$expected_image_prefix"}"
if [[ "$image_ref" != "$expected_image_prefix"* || ! "$image_digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo "AAIS deploy requires an immutable digest from the configured ACR repository." >&2
  exit 1
fi
if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "AAIS deploy requires a full 40-character Git SHA." >&2
  exit 1
fi
candidate_source_receipt="${AAIS_CANDIDATE_RECEIPT_DIR}/${release_sha}.json"
watchdog_source_receipt="${AAIS_CANDIDATE_RECEIPT_DIR}/${release_sha}.watchdog.json"
candidate_receipt_mode="$(stat -c '%a' "$candidate_source_receipt" 2>/dev/null || true)"
candidate_receipt_owner="$(stat -c '%u' "$candidate_source_receipt" 2>/dev/null || true)"
if [[ "$candidate_receipt_owner" != "0" || "$candidate_receipt_mode" != "644" ]]; then
  echo "AAIS candidate source receipt must be root-owned with mode 0644." >&2
  exit 1
fi
if ! jq -e \
  --arg gitSha "$release_sha" \
  --arg acrInstanceId "$AAIS_ACR_INSTANCE_ID" \
  --arg acrApiEndpoint "$AAIS_ACR_API_ENDPOINT" \
  --arg publicLoginServer "$AAIS_ACR_PUBLIC_LOGIN_SERVER" \
  --arg imageRepository "$AAIS_ACR_REPOSITORY" \
  --arg pushRepository "$expected_public_push_repository" \
  --arg imageDigest "sha256:${image_digest}" \
  '.schemaVersion == 1
   and .provider == "aliyun"
   and .stage == "acr_candidate"
   and .gitSha == $gitSha
   and .acrInstanceId == $acrInstanceId
   and .acrApiEndpoint == $acrApiEndpoint
   and .publicLoginServer == $publicLoginServer
   and .imageRepository == $imageRepository
   and .pushRepository == $pushRepository
   and .imageDigest == $imageDigest
   and .publicEndpointClosed == true
   and .postRunWatchdogActive == true
   and (.postRunWatchdogWorkflowId | type) == "number"' \
  "$candidate_source_receipt" >/dev/null; then
  echo "AAIS candidate receipt does not bind the requested source/image or prove ACR closure." >&2
  exit 1
fi
watchdog_receipt_mode="$(stat -c '%a' "$watchdog_source_receipt" 2>/dev/null || true)"
watchdog_receipt_owner="$(stat -c '%u' "$watchdog_source_receipt" 2>/dev/null || true)"
if [[ "$watchdog_receipt_owner" != "0" || "$watchdog_receipt_mode" != "644" ]]; then
  echo "AAIS post-run watchdog receipt must be root-owned with mode 0644." >&2
  exit 1
fi
candidate_run_id="$(jq -er '.githubRunId | select(type == "string")' \
  "$candidate_source_receipt")"
candidate_run_attempt="$(jq -er '.githubRunAttempt | select(type == "string")' \
  "$candidate_source_receipt")"
if [[ ! "$candidate_run_id" =~ ^[0-9]+$ || ! "$candidate_run_attempt" =~ ^[0-9]+$ ]]; then
  echo "AAIS candidate receipt has an invalid GitHub run identity." >&2
  exit 1
fi
if ! jq -e \
  --arg gitSha "$release_sha" \
  --arg acrInstanceId "$AAIS_ACR_INSTANCE_ID" \
  --arg acrApiEndpoint "$AAIS_ACR_API_ENDPOINT" \
  --arg publicLoginServer "$AAIS_ACR_PUBLIC_LOGIN_SERVER" \
  --arg candidateRunId "$candidate_run_id" \
  --arg candidateRunAttempt "$candidate_run_attempt" \
  '.schemaVersion == 1
   and .provider == "aliyun"
   and .stage == "acr_postrun_cleanup"
   and .gitSha == $gitSha
   and .acrInstanceId == $acrInstanceId
   and .acrApiEndpoint == $acrApiEndpoint
   and .publicLoginServer == $publicLoginServer
   and .candidateRunId == $candidateRunId
   and .candidateRunAttempt == $candidateRunAttempt
   and .publicEndpointReconciled == true
   and (.watchdogRunId | type) == "string"
   and (.watchdogRunId | test("^[0-9]+$"))' \
  "$watchdog_source_receipt" >/dev/null; then
  echo "AAIS post-run watchdog receipt does not match the candidate run." >&2
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
  || -L "$AAIS_OPERATION_LOCK_FILE" || -L "$AAIS_STATE_FILE" \
  || -L "$AAIS_ROTATION_PENDING_FILE" ]]; then
  echo "AAIS operation lock path is invalid." >&2
  exit 1
fi
inherited_operation_lock_fd="${AAIS_OPERATION_LOCK_FD:-}"
if [[ -n "$inherited_operation_lock_fd" ]]; then
  if [[ ! "$inherited_operation_lock_fd" =~ ^[3-9][0-9]*$ \
    || "$(readlink -f "/proc/$$/fd/${inherited_operation_lock_fd}" 2>/dev/null || true)" \
      != "$(readlink -f "$AAIS_OPERATION_LOCK_FILE" 2>/dev/null || true)" \
    ]] || ! flock -n "$inherited_operation_lock_fd"; then
    echo "AAIS inherited operation lock is invalid." >&2
    exit 1
  fi
else
  exec 9>"$AAIS_OPERATION_LOCK_FILE"
  if ! flock -n 9; then
    echo "Another AAIS deployment or secret rotation is already running." >&2
    exit 1
  fi
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
  local diagnostic
  for _ in $(seq 1 30); do
    diagnostic="$(curl --fail --silent --show-error --max-time 10 \
      --resolve www.aais.site:8443:127.0.0.1 \
      https://www.aais.site:8443/api/system/traffic-readiness 2>/dev/null || true)"
    if jq -e --arg release "$expected_release" \
      '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
      <<<"$diagnostic" >/dev/null 2>&1; then
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
  local binding bundle database_target digest live release ready
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
  live="$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${port}/api/system/live")" || return 1
  ready="$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${port}/api/system/traffic-readiness")" || return 1
  jq -e --arg release "$release_sha" \
    '.status == "live" and .provider == "aliyun" and .releaseId == $release' \
    <<<"$live" >/dev/null || return 1
  jq -e --arg release "$release_sha" \
    '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
    <<<"$ready" >/dev/null
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
candidate_upstream="${transaction_dir}/candidate-upstream"
candidate_state="${transaction_dir}/candidate-state"
candidate_receipt="${transaction_dir}/candidate-receipt"
cp "$AAIS_UPSTREAM_FILE" "$previous_upstream"
if [[ -f "$AAIS_STATE_FILE" ]]; then
  cp "$AAIS_STATE_FILE" "$previous_state"
fi

nginx_switched="false"
state_committed="false"
receipt_committed="false"
acr_logged_in="false"
docker_config_dir=""

email_timer="aais-email-outbox.timer"
lrs_timer="aais-lrs-outbox.timer"
email_service="aais-email-outbox.service"
lrs_service="aais-lrs-outbox.service"
email_timer_was_active="false"
lrs_timer_was_active="false"
timers_paused="false"

pause_worker_timers() {
  timers_paused="true"
  if systemctl is-active --quiet "$email_timer"; then
    email_timer_was_active="true"
    systemctl stop "$email_timer"
  fi
  if systemctl is-active --quiet "$lrs_timer"; then
    lrs_timer_was_active="true"
    systemctl stop "$lrs_timer"
  fi
  for _ in $(seq 1 130); do
    if ! systemctl is-active --quiet "$email_service" \
      && ! systemctl is-active --quiet "$lrs_service"; then
      return 0
    fi
    sleep 1
  done
  echo "AAIS worker services did not drain before deployment." >&2
  return 1
}

resume_worker_timers() {
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
  timers_paused="false"
}

cleanup_transaction_files() {
  rm -f -- \
    "$previous_upstream" "$previous_state" "$candidate_upstream" \
    "$candidate_state" "$candidate_receipt"
  rmdir -- "$transaction_dir" >/dev/null 2>&1 || true
}

cleanup_acr_login() {
  if [[ "$acr_logged_in" == "true" ]]; then
    docker logout "$AAIS_ACR_LOGIN_SERVER" >/dev/null 2>&1 || true
    acr_logged_in="false"
  fi
  if [[ -n "$docker_config_dir" \
    && "$docker_config_dir" == /run/aais/docker-config.* \
    && -d "$docker_config_dir" ]]; then
    rm -rf -- "$docker_config_dir"
  fi
  docker_config_dir=""
  unset DOCKER_CONFIG
  unset acr_response acr_username acr_token
}

container_matches_expected_runtime() {
  local container_name="$1"
  local container_port="$2"
  local expected_release="$3"
  local expected_digest="$4"
  local expected_bundle="$5"
  local container_binding container_bundle container_digest container_release container_target live_response ready_response
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
  live_response="$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${container_port}/api/system/live")" || return 1
  ready_response="$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${container_port}/api/system/traffic-readiness")" || return 1
  jq -e --arg release "$expected_release" \
    '.status == "live" and .provider == "aliyun" and .releaseId == $release' \
    <<<"$live_response" >/dev/null || return 1
  jq -e --arg release "$expected_release" \
    '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
    <<<"$ready_response" >/dev/null || return 1
}

nginx_path_is_healthy() {
  local expected_release="$1"
  local response status_code
  nginx_loaded_release_matches "$expected_release" || return 1
  if [[ -f /opt/aais/state/maintenance.enabled \
    || -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
    status_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
      --resolve www.aais.site:443:127.0.0.1 https://www.aais.site/)" || return 1
    [[ "$status_code" == "503" ]]
    return
  fi
  response="$(curl --fail --silent --show-error --max-time 10 \
    --resolve www.aais.site:443:127.0.0.1 \
    https://www.aais.site/api/system/traffic-readiness)" || return 1
  jq -e --arg release "$expected_release" \
    '.status == "ready" and .provider == "aliyun" and .releaseId == $release' \
    <<<"$response" >/dev/null
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
  install -m 0644 "$previous_upstream" "$AAIS_UPSTREAM_FILE" || return 1
  "$AAIS_NGINX_BINARY" -t >/dev/null || return 1
  "$AAIS_NGINX_BINARY" -s reload >/dev/null || return 1
  nginx_path_is_healthy "$active_release_sha"
}

drain_active_connections() {
  if [[ -z "$active_port" ]]; then
    return 0
  fi
  for _ in $(seq 1 330); do
    if ! ss -Htn state established | awk -v port=":${active_port}" '
      $4 ~ port "$" || $5 ~ port "$" { found = 1 }
      END { exit(found ? 0 : 1) }
    '; then
      return 0
    fi
    sleep 1
  done
  echo "AAIS old container still has active HTTP/SSE connections." >&2
  return 1
}

rollback_on_error() {
  local status=$?
  local recovered="false"
  trap - EXIT
  set +e
  cleanup_acr_login
  if [[ "$nginx_switched" == "true" ]]; then
    if restore_previous_path; then
      recovered="true"
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
    if [[ "$state_committed" == "true" ]]; then
      if [[ -f "$previous_state" ]]; then
        chown root:root "$previous_state"
        chmod 0644 "$previous_state"
        mv -Tf -- "$previous_state" "$AAIS_STATE_FILE"
      else
        rm -f -- "$AAIS_STATE_FILE"
      fi
    fi
    if resume_worker_timers; then
      if [[ "$receipt_committed" == "true" ]]; then
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

docker_config_dir="$(mktemp -d /run/aais/docker-config.XXXXXX)"
chmod 0700 "$docker_config_dir"
export DOCKER_CONFIG="$docker_config_dir"

acr_response="$("$AAIS_ALIYUN_CLI" cr GetAuthorizationToken \
  --profile "$AAIS_ALIYUN_CLI_PROFILE" \
  --endpoint "$AAIS_ACR_API_ENDPOINT" \
  --InstanceId "$AAIS_ACR_INSTANCE_ID")"
acr_username="$(jq -er '.TempUsername' <<<"$acr_response")"
acr_token="$(jq -er '.AuthorizationToken' <<<"$acr_response")"
printf '%s' "$acr_token" | docker login "$AAIS_ACR_LOGIN_SERVER" \
  --username "$acr_username" --password-stdin >/dev/null
acr_logged_in="true"
docker pull "$image_ref" >/dev/null
cleanup_acr_login

image_revision="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$image_ref")"
if [[ "$image_revision" != "$release_sha" ]]; then
  echo "AAIS image revision does not match the requested Git SHA." >&2
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
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /app/.next/cache:rw,noexec,nosuid,size=256m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --restart unless-stopped \
  "${database_ca_args[@]}" \
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
  if curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${target_port}/api/system/live" >/dev/null; then
    break
  fi
  sleep 1
done
live_report="$(curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${target_port}/api/system/live")"
if [[ "$live_report" != *'"status":"live"'* || "$live_report" != *"\"releaseId\":\"${release_sha}\""* ]]; then
  echo "AAIS candidate liveness provenance does not match." >&2
  exit 1
fi
traffic_report="$(curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${target_port}/api/system/traffic-readiness")"
if [[ "$traffic_report" != *'"status":"ready"'* || "$traffic_report" != *"\"releaseId\":\"${release_sha}\""* ]]; then
  echo "AAIS candidate traffic readiness does not match." >&2
  exit 1
fi
full_readiness_report="$(curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${target_port}/api/system/readiness")"
if ! jq -e '.status == "ready"' <<<"$full_readiness_report" >/dev/null; then
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
upstream_sha="$(sha256sum "$candidate_upstream" | awk '{ print $1 }')"
deployed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '{"schemaVersion":1,"provider":"aliyun","gitSha":"%s","imageDigest":"%s","secretBundleVersion":"%s","container":"%s","containerId":"%s","color":"%s","port":%s,"nginxUpstreamSha256":"%s","nginxVhostSha256":"%s","deployedAt":"%s","secrets":"redacted"}\n' \
  "$release_sha" "sha256:${image_digest}" "$expected_secret_bundle" "$target_container" "${container_id:0:12}" \
  "$target_color" "$target_port" "$upstream_sha" "$actual_nginx_vhost_sha256" \
  "$deployed_at" > "$candidate_receipt"

pause_worker_timers
install -m 0644 "$candidate_upstream" "$AAIS_UPSTREAM_FILE"
nginx_switched="true"
"$AAIS_NGINX_BINARY" -t >/dev/null
"$AAIS_NGINX_BINARY" -s reload >/dev/null

if [[ -f /opt/aais/state/maintenance.enabled \
  || -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
  maintenance_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --resolve www.aais.site:443:127.0.0.1 https://www.aais.site/)"
  if [[ "$maintenance_status" != "503" ]]; then
    echo "AAIS maintenance proxy gate is not active." >&2
    exit 1
  fi
else
  nginx_report="$(curl --fail --silent --show-error --max-time 10 \
    --resolve www.aais.site:443:127.0.0.1 \
    https://www.aais.site/api/system/traffic-readiness)"
  if [[ "$nginx_report" != *'"status":"ready"'* || "$nginx_report" != *"\"releaseId\":\"${release_sha}\""* ]]; then
    echo "AAIS Nginx/TLS promotion check does not match." >&2
    exit 1
  fi
fi

chown root:root "$candidate_state"
chmod 0644 "$candidate_state"
mv -Tf -- "$candidate_state" "$AAIS_STATE_FILE"
state_committed="true"

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
mv -Tf -- "$candidate_receipt" "$receipt_file"
receipt_committed="true"

trap - EXIT
trap - INT TERM HUP
cleanup_transaction_files
printf 'AAIS deployment promoted: %s %s %s\n' \
  "$release_sha" "sha256:${image_digest}" "$target_color"
