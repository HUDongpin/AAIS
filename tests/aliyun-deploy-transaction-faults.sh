#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly TEST_IMAGE_ID="be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2"
readonly TEST_IMAGE="node@sha256:${TEST_IMAGE_ID}"

if [[ "${1:-}" != "--inside" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  harness_path="${repo_root}/tests/aliyun-deploy-transaction-faults.sh"
  deploy_path="${repo_root}/deploy/aliyun/aais-deploy.sh"
  helper_path="${repo_root}/deploy/aliyun/aais-json-v1.py"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for the isolated AAIS deploy fault test." >&2
    exit 1
  fi
  if ! docker image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "The preloaded test image is unavailable: ${TEST_IMAGE}." >&2
    exit 1
  fi
  exec docker run --rm --pull never --network none --platform linux/amd64 \
    --hostname aais-deploy-fault-test \
    --env AAIS_DEPLOY_FAULT_CONTAINER=1 \
    --env "AAIS_DEPLOY_FAULT_IMAGE_ID=${TEST_IMAGE_ID}" \
    --env "AAIS_DEPLOY_FAULT_CASE=${AAIS_DEPLOY_FAULT_CASE:-}" \
    --volume "${harness_path}:/aais-test/aliyun-deploy-transaction-faults.sh:ro" \
    --volume "${deploy_path}:/aais-test/aais-deploy.sh:ro" \
    --volume "${helper_path}:/aais-test/aais-json-v1.py:ro" \
    --entrypoint /bin/bash \
    "$TEST_IMAGE" /aais-test/aliyun-deploy-transaction-faults.sh --inside
fi

refuse_unsafe_inside() {
  echo "Refusing to run the destructive fault fixture outside its dedicated container." >&2
  exit 1
}

if [[ "${AAIS_DEPLOY_FAULT_CONTAINER:-}" != "1" \
  || "${AAIS_DEPLOY_FAULT_IMAGE_ID:-}" != "$TEST_IMAGE_ID" \
  || ! -f /.dockerenv \
  || "$(hostname)" != "aais-deploy-fault-test" \
  || "$(node --version 2>/dev/null || true)" != "v24.20.0" \
  || "$(python3 --version 2>/dev/null || true)" != "Python 3.11.2" \
  || -e /repo ]]; then
  refuse_unsafe_inside
fi
expected_test_files=$'aais-deploy.sh\naais-json-v1.py\naliyun-deploy-transaction-faults.sh'
actual_test_files="$(find /aais-test -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
  | LC_ALL=C sort)" || refuse_unsafe_inside
if [[ "$actual_test_files" != "$expected_test_files" ]]; then
  refuse_unsafe_inside
fi
for test_file in \
  /aais-test/aliyun-deploy-transaction-faults.sh \
  /aais-test/aais-deploy.sh \
  /aais-test/aais-json-v1.py; do
  mount_options="$(findmnt -n -o OPTIONS --target "$test_file" 2>/dev/null)" \
    || refuse_unsafe_inside
  if [[ ! -f "$test_file" || -L "$test_file" \
    || ",${mount_options}," != *,ro,* ]]; then
    refuse_unsafe_inside
  fi
done

readonly OLD_RELEASE="1111111111111111111111111111111111111111"
readonly NEW_RELEASE="2222222222222222222222222222222222222222"
readonly OLD_DIGEST="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly NEW_DIGEST="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly IMAGE_REF="ghcr.io/hudongpin/aais@sha256:${NEW_DIGEST}"
readonly BUNDLE="bundle-v1"
readonly DATABASE_TARGET="neon-hk-primary"
readonly TEST_ROOT="/tmp/aais-deploy-fault"
readonly FAKE_BIN="${TEST_ROOT}/bin"
readonly FAKE_STATE="${TEST_ROOT}/state"

write_fake_commands() {
  cat > "${FAKE_BIN}/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
printf 'docker %s\n' "$*" >> "${FAKE_STATE}/operations.log"

last_arg="${!#}"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  if [[ "$*" == *"org.opencontainers.image.revision"* ]]; then
    printf '%s\n' "$NEW_RELEASE"
  else
    printf '%s\n' "$IMAGE_REF"
  fi
  exit 0
fi
if [[ "$1" == "network" && "$2" == "inspect" ]]; then
  exit 0
fi
if [[ "$1" == "network" && "$2" == "create" ]]; then
  exit 0
fi
if [[ "$1" == "container" && "$2" == "inspect" ]]; then
  [[ -f "${FAKE_STATE}/${last_arg}.exists" ]]
  exit
fi
if [[ "$1" == "inspect" ]]; then
  container="$last_arg"
  if [[ ! -f "${FAKE_STATE}/${container}.exists" ]]; then
    exit 1
  fi
  if [[ "$*" == *".State.Running"* ]]; then
    cat "${FAKE_STATE}/${container}.running"
  elif [[ "$*" == *"aais.image.digest"* ]]; then
    cat "${FAKE_STATE}/${container}.digest"
  elif [[ "$*" == *"{{.Id}}"* ]]; then
    printf '%064d\n' 0 | tr '0' 'c'
  else
    exit 1
  fi
  exit 0
fi
if [[ "$1" == "port" ]]; then
  if [[ "$2" == "aais-blue" ]]; then
    printf '127.0.0.1:3101\n'
  else
    printf '127.0.0.1:3102\n'
  fi
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  container="$2"
  variable="$4"
  case "$variable" in
    AAIS_DATABASE_TARGET_ID) printf '%s\n' "$DATABASE_TARGET" ;;
    AAIS_SECRET_BUNDLE_VERSION) printf '%s\n' "$BUNDLE" ;;
    AAIS_DEPLOYMENT_GIT_COMMIT_SHA) cat "${FAKE_STATE}/${container}.release" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$1" == "run" ]]; then
  container=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--name" ]]; then
      container="$argument"
      break
    fi
    previous="$argument"
  done
  [[ -n "$container" ]] || exit 1
  : > "${FAKE_STATE}/${container}.exists"
  printf 'true\n' > "${FAKE_STATE}/${container}.running"
  printf '%s\n' "$NEW_RELEASE" > "${FAKE_STATE}/${container}.release"
  printf 'sha256:%s\n' "$NEW_DIGEST" > "${FAKE_STATE}/${container}.digest"
  printf '%064d\n' 0 | tr '0' 'c'
  exit 0
fi
if [[ "$1" == "start" ]]; then
  printf 'true\n' > "${FAKE_STATE}/${2}.running"
  exit 0
fi
if [[ "$1" == "stop" ]]; then
  printf 'false\n' > "${FAKE_STATE}/${last_arg}.running"
  exit 0
fi
if [[ "$1" == "rm" ]]; then
  rm -f -- "${FAKE_STATE}/${last_arg}.exists" \
    "${FAKE_STATE}/${last_arg}.running" \
    "${FAKE_STATE}/${last_arg}.release" \
    "${FAKE_STATE}/${last_arg}.digest"
  exit 0
fi
exit 1
FAKE_DOCKER

  cat > "${FAKE_BIN}/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
printf 'curl %s\n' "$*" >> "${FAKE_STATE}/operations.log"
if [[ "${1:-}" != "--disable" \
  || "${2:-}" != "--noproxy" \
  || "${3:-}" != "*" ]]; then
  echo "curl did not disable config and proxy routing first" >&2
  exit 92
fi
if [[ "${HTTPS_PROXY:-}" != "http://proxy.invalid:8443" \
  || "${ALL_PROXY:-}" != "socks5://proxy.invalid:1080" \
  || ! -f "${HOME}/.curlrc" ]]; then
  echo "malicious curl environment was not installed" >&2
  exit 93
fi
url="${!#}"
if [[ "$url" == http://127.0.0.1:* ]]; then
  :
elif [[ "$url" == https://www.aais.site* \
  && "$*" == *"--resolve www.aais.site:"*":127.0.0.1"* ]]; then
  :
else
  echo "curl target was not pinned to the loopback test path" >&2
  exit 94
fi
if [[ "$url" == *"127.0.0.1:3101"* ]]; then
  container="aais-blue"
elif [[ "$url" == *"127.0.0.1:3102"* ]]; then
  container="aais-green"
elif grep -q '3102' "${FAKE_STATE}/loaded-upstream"; then
  container="aais-green"
else
  container="aais-blue"
fi
release="$(cat "${FAKE_STATE}/${container}.release")"
case "$url" in
  */api/system/live)
    printf '{"status":"live","releaseId":"%s","provider":"aliyun"}\n' "$release"
    ;;
  */api/system/traffic-readiness)
    printf '{"status":"ready","releaseId":"%s","provider":"aliyun","deployment":"valid","database":"ok","schema":"current"}\n' "$release"
    ;;
  */api/system/readiness)
    printf '{"status":"ready"}\n'
    ;;
  *)
    if [[ -f /opt/aais/state/maintenance.enabled ]]; then
      printf '503'
    else
      printf '200'
    fi
    ;;
esac
FAKE_CURL

  cat > "${FAKE_BIN}/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
unit="${!#}"
printf 'systemctl %s\n' "$*" >> "${FAKE_STATE}/operations.log"
case "$1" in
  show)
    if [[ "${2:-}" != "--property=LoadState" \
      || "${3:-}" != "--property=ActiveState" ]]; then
      echo "systemctl show did not request the strict state pair" >&2
      exit 6
    fi
    if [[ "$unit" == "aais-email-outbox.timer" \
      && ! -f "${FAKE_STATE}/systemctl-fault-injected" ]]; then
      case "$FAULT_CASE" in
        timer-query-error)
          : > "${FAKE_STATE}/systemctl-fault-injected"
          exit 5
          ;;
        timer-state-unknown)
          : > "${FAKE_STATE}/systemctl-fault-injected"
          printf 'LoadState=loaded\nActiveState=unknown\n'
          exit 0
          ;;
        timer-state-failed)
          : > "${FAKE_STATE}/systemctl-fault-injected"
          printf 'LoadState=loaded\nActiveState=failed\n'
          exit 0
          ;;
        timer-load-not-found)
          : > "${FAKE_STATE}/systemctl-fault-injected"
          printf 'LoadState=not-found\nActiveState=inactive\n'
          exit 0
          ;;
      esac
    fi
    printf 'LoadState=loaded\n'
    if [[ -f "${FAKE_STATE}/${unit}.active" ]]; then
      printf 'ActiveState=active\n'
    else
      printf 'ActiveState=inactive\n'
    fi
    ;;
  stop)
    rm -f -- "${FAKE_STATE}/${unit}.active"
    ;;
  start)
    : > "${FAKE_STATE}/${unit}.active"
    ;;
  *)
    exit 1
    ;;
esac
FAKE_SYSTEMCTL

  cat > "${FAKE_BIN}/ss" <<'FAKE_SS'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
printf 'ss %s\n' "$*" >> "${FAKE_STATE}/operations.log"
if [[ "$FAULT_CASE" == "ss-query-error-at-drain" ]]; then
  exit 7
fi
exit 0
FAKE_SS

  cat > "${FAKE_BIN}/mv" <<'FAKE_MV'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
target="${!#}"
printf 'mv %s\n' "$*" >> "${FAKE_STATE}/operations.log"

if [[ "$target" == "$UPSTREAM_FILE" \
  && "$FAULT_CASE" == "fail-upstream-publish" \
  && ! -f "${FAKE_STATE}/fault-injected" ]]; then
  : > "${FAKE_STATE}/fault-injected"
  exit 74
fi

/usr/bin/mv "$@"

inject="false"
if [[ "$target" == "$UPSTREAM_FILE" \
  && ( "$FAULT_CASE" == "after-upstream-publish" \
    || "$FAULT_CASE" == "first-after-upstream-publish" ) ]]; then
  inject="true"
elif [[ "$target" == "$STATE_FILE" \
  && ( "$FAULT_CASE" == "after-state-publish" \
    || "$FAULT_CASE" == "after-state-publish-email-active-lrs-inactive" \
    || "$FAULT_CASE" == "after-state-publish-email-inactive-lrs-active" ) ]]; then
  inject="true"
elif [[ "$target" == "$RECEIPT_DIR/"*.json \
  && "$FAULT_CASE" == "after-receipt-publish" ]]; then
  inject="true"
fi
if [[ "$inject" == "true" && ! -f "${FAKE_STATE}/fault-injected" ]]; then
  : > "${FAKE_STATE}/fault-injected"
  kill -TERM "$PPID"
fi
FAKE_MV

  cat > "${FAKE_BIN}/nginx" <<'FAKE_NGINX'
#!/usr/bin/env bash
set -Eeuo pipefail
source /tmp/aais-deploy-fault/common.env
printf 'nginx %s\n' "$*" >> "${FAKE_STATE}/operations.log"
if [[ "$1" == "-t" ]]; then
  exit 0
fi
if [[ "$1" == "-s" && "$2" == "reload" ]]; then
  if [[ "$FIRST_DEPLOY" != "true" ]] \
    && grep -q '3102' "$UPSTREAM_FILE" \
    && [[ "$FAULT_CASE" == "fail-nginx-reload" ]] \
    && [[ ! -f "${FAKE_STATE}/fault-injected" ]]; then
    : > "${FAKE_STATE}/fault-injected"
    exit 75
  fi
  cp "$UPSTREAM_FILE" "${FAKE_STATE}/loaded-upstream"
  if { grep -q '3102' "$UPSTREAM_FILE" \
      && [[ "$FAULT_CASE" == "after-nginx-reload" ]]; } \
    || { [[ "$FIRST_DEPLOY" == "true" ]] \
      && [[ "$FAULT_CASE" == "first-after-nginx-reload" ]]; }; then
    if [[ ! -f "${FAKE_STATE}/fault-injected" ]]; then
      : > "${FAKE_STATE}/fault-injected"
      kill -TERM "$PPID"
    fi
  fi
  exit 0
fi
exit 1
FAKE_NGINX

  chmod 0755 "${FAKE_BIN}/docker" "${FAKE_BIN}/curl" \
    "${FAKE_BIN}/systemctl" "${FAKE_BIN}/ss" "${FAKE_BIN}/mv" \
    "${FAKE_BIN}/nginx"
}

prepare_case() {
  local fault_case="$1"
  local first_deploy="false"
  local target_container="aais-green"
  if [[ "$fault_case" == first-* ]]; then
    first_deploy="true"
    target_container="aais-blue"
  fi
  rm -rf -- /opt/aais "$TEST_ROOT"
  install -d -o root -g root -m 0700 /opt/aais/libexec
  install -d -o root -g root -m 0755 \
    /opt/aais/candidates /opt/aais/preloaded /opt/aais/nginx \
    /opt/aais/state /opt/aais/receipts /opt/aais/runtime "$FAKE_BIN" "$FAKE_STATE" \
    "${TEST_ROOT}/malicious-home"
  install -o root -g root -m 0500 \
    /aais-test/aais-json-v1.py /opt/aais/libexec/aais-json-v1.py

  cat > "${TEST_ROOT}/common.env" <<EOF
OLD_RELEASE=${OLD_RELEASE}
NEW_RELEASE=${NEW_RELEASE}
OLD_DIGEST=${OLD_DIGEST}
NEW_DIGEST=${NEW_DIGEST}
IMAGE_REF=${IMAGE_REF}
BUNDLE=${BUNDLE}
DATABASE_TARGET=${DATABASE_TARGET}
FAULT_CASE=${fault_case}
FAKE_STATE=${FAKE_STATE}
UPSTREAM_FILE=/opt/aais/nginx/upstream-active.conf
STATE_FILE=/opt/aais/state/active-deployment.env
RECEIPT_DIR=/opt/aais/receipts
FIRST_DEPLOY=${first_deploy}
TARGET_CONTAINER=${target_container}
EOF

  write_fake_commands

  printf 'server 127.0.0.1:3101;\n' > /opt/aais/nginx/upstream-active.conf
  cp /opt/aais/nginx/upstream-active.conf "${FAKE_STATE}/loaded-upstream"
  cp /opt/aais/nginx/upstream-active.conf "${FAKE_STATE}/expected-upstream"
  cat > /opt/aais/state/active-deployment.env <<EOF
AAIS_ACTIVE_COLOR=blue
AAIS_ACTIVE_PORT=3101
AAIS_ACTIVE_SECRET_BUNDLE_VERSION=${BUNDLE}
AAIS_ACTIVE_RELEASE_SHA=${OLD_RELEASE}
AAIS_ACTIVE_IMAGE_DIGEST=sha256:${OLD_DIGEST}
EOF
  if [[ "$first_deploy" == "true" ]]; then
    rm -f -- /opt/aais/state/active-deployment.env
  else
    cp /opt/aais/state/active-deployment.env "${FAKE_STATE}/expected-state"
  fi
  cat > /opt/aais/runtime/runtime.env <<EOF
AAIS_DATABASE_TARGET_ID=${DATABASE_TARGET}
AAIS_SECRET_BUNDLE_VERSION=${BUNDLE}
EOF
  chmod 0400 /opt/aais/runtime/runtime.env

  cat > "/opt/aais/candidates/${NEW_RELEASE}.json" <<EOF
{"schemaVersion":1,"provider":"github","stage":"ghcr_candidate","gitSha":"${NEW_RELEASE}","imageRepository":"ghcr.io/hudongpin/aais","imageTag":"ghcr.io/hudongpin/aais:${NEW_RELEASE}","imageDigest":"sha256:${NEW_DIGEST}","githubRunId":"123","githubRunAttempt":"1","packageVisibility":"private","sbomGenerated":true,"provenanceGenerated":true,"provenanceAttestationId":"attestation-1","secrets":"redacted"}
EOF
  cat > "/opt/aais/preloaded/${NEW_RELEASE}.json" <<EOF
{"schemaVersion":1,"provider":"github","stage":"ghcr_preloaded","gitSha":"${NEW_RELEASE}","imageRepository":"ghcr.io/hudongpin/aais","imageDigest":"sha256:${NEW_DIGEST}","localRepoDigest":"${IMAGE_REF}","imageRevision":"${NEW_RELEASE}","candidateRunId":"123","candidateRunAttempt":"1","pulledAt":"2026-08-31T00:00:00Z","credentialsCleaned":true,"secrets":"redacted"}
EOF
  chmod 0644 "/opt/aais/candidates/${NEW_RELEASE}.json" \
    "/opt/aais/preloaded/${NEW_RELEASE}.json"

  printf 'worker_processes 1;\n' > /opt/aais/nginx/nginx.conf
  printf 'server_name www.aais.site;\n' > /opt/aais/nginx/aais-vhost.conf
  if [[ ! -f /etc/machine-id ]]; then
    printf '0123456789abcdef0123456789abcdef\n' > /etc/machine-id
  fi
  machine_sha="$(sha256sum /etc/machine-id | awk '{ print $1 }')"
  nginx_sha="$(sha256sum /opt/aais/nginx/nginx.conf | awk '{ print $1 }')"
  vhost_sha="$(sha256sum /opt/aais/nginx/aais-vhost.conf | awk '{ print $1 }')"
  cat > /opt/aais/deploy.env <<EOF
AAIS_IMAGE_SOURCE=ghcr-preloaded
AAIS_GHCR_REPOSITORY=ghcr.io/hudongpin/aais
AAIS_EXPECTED_MACHINE_ID_SHA256=${machine_sha}
AAIS_NGINX_CONFIG_FILE=/opt/aais/nginx/nginx.conf
AAIS_EXPECTED_NGINX_CONFIG_SHA256=${nginx_sha}
AAIS_NGINX_VHOST_FILE=/opt/aais/nginx/aais-vhost.conf
AAIS_EXPECTED_NGINX_VHOST_SHA256=${vhost_sha}
AAIS_CANDIDATE_RECEIPT_DIR=/opt/aais/candidates
AAIS_PRELOADED_RECEIPT_DIR=/opt/aais/preloaded
AAIS_RUNTIME_ENV_FILE=/opt/aais/runtime/runtime.env
AAIS_NGINX_BINARY=${FAKE_BIN}/nginx
AAIS_UPSTREAM_FILE=/opt/aais/nginx/upstream-active.conf
AAIS_STATE_FILE=/opt/aais/state/active-deployment.env
AAIS_OPERATION_LOCK_FILE=/opt/aais/state/deploy.lock
AAIS_ROTATION_PENDING_FILE=/opt/aais/state/secret-rotation.pending
AAIS_ROTATION_CANONICAL_CHECK_FILE=/opt/aais/state/secret-rotation.canonical-check
AAIS_ROTATION_INVALID_FILE=/opt/aais/state/secret-rotation.invalid
AAIS_RECEIPT_DIR=/opt/aais/receipts
EOF
  chmod 0600 /opt/aais/deploy.env

  if [[ "$first_deploy" != "true" ]]; then
    : > "${FAKE_STATE}/aais-blue.exists"
    printf 'true\n' > "${FAKE_STATE}/aais-blue.running"
    printf '%s\n' "$OLD_RELEASE" > "${FAKE_STATE}/aais-blue.release"
    printf 'sha256:%s\n' "$OLD_DIGEST" > "${FAKE_STATE}/aais-blue.digest"
  fi
  if [[ "$fault_case" != "after-state-publish-email-inactive-lrs-active" ]]; then
    : > "${FAKE_STATE}/aais-email-outbox.timer.active"
  fi
  if [[ "$fault_case" != "after-state-publish-email-active-lrs-inactive" ]]; then
    : > "${FAKE_STATE}/aais-lrs-outbox.timer.active"
  fi
  : > "${FAKE_STATE}/operations.log"
  cat > "${TEST_ROOT}/malicious-home/.curlrc" <<'EOF'
proxy = "http://proxy.invalid:8443"
url = "https://proxy.invalid/should-never-be-used"
EOF
  if [[ "$fault_case" == "canonical-marker-fence" ]]; then
    : > /opt/aais/state/secret-rotation.canonical-check
  elif [[ "$fault_case" == "invalid-marker-fence" ]]; then
    : > /opt/aais/state/secret-rotation.invalid
  elif [[ "$fault_case" == "pending-without-inherited-fence" ]]; then
    : > /opt/aais/state/secret-rotation.pending
  elif [[ "$fault_case" == "candidate-receipt-dir-mode-fence" ]]; then
    chmod 0777 /opt/aais/candidates
  elif [[ "$fault_case" == "preloaded-receipt-dir-symlink-fence" ]]; then
    mv /opt/aais/preloaded /opt/aais/preloaded.real
    ln -s /opt/aais/preloaded.real /opt/aais/preloaded
  elif [[ "$fault_case" == "receipt-dir-owner-fence" ]]; then
    chown 1000:1000 /opt/aais/receipts
  fi
}

assert_recovered() {
  local fault_case="$1"
  local email_expected="active"
  local first_deploy="false"
  local lrs_expected="active"
  local target_container="aais-green"
  if [[ "$fault_case" == first-* ]]; then
    first_deploy="true"
    target_container="aais-blue"
  fi
  if [[ "$fault_case" == "after-state-publish-email-inactive-lrs-active" ]]; then
    email_expected="inactive"
  elif [[ "$fault_case" == "after-state-publish-email-active-lrs-inactive" ]]; then
    lrs_expected="inactive"
  fi
  cmp -s "${FAKE_STATE}/expected-upstream" /opt/aais/nginx/upstream-active.conf \
    || { echo "${fault_case}: upstream was not restored" >&2; return 1; }
  cmp -s "${FAKE_STATE}/expected-upstream" "${FAKE_STATE}/loaded-upstream" \
    || { echo "${fault_case}: loaded Nginx path was not restored" >&2; return 1; }
  if [[ "$first_deploy" == "true" ]]; then
    [[ ! -e /opt/aais/state/active-deployment.env ]] \
      || { echo "${fault_case}: bootstrap state was not removed" >&2; return 1; }
  else
    cmp -s "${FAKE_STATE}/expected-state" /opt/aais/state/active-deployment.env \
      || { echo "${fault_case}: active state was not restored" >&2; return 1; }
  fi
  if compgen -G '/opt/aais/receipts/*.json' >/dev/null; then
    echo "${fault_case}: a success receipt survived rollback" >&2
    return 1
  fi
  [[ ! -e "${FAKE_STATE}/${target_container}.exists" ]] \
    || { echo "${fault_case}: target container survived rollback" >&2; return 1; }
  if [[ "$first_deploy" != "true" ]]; then
    [[ "$(cat "${FAKE_STATE}/aais-blue.running")" == "true" ]] \
      || { echo "${fault_case}: prior container was not running" >&2; return 1; }
  fi
  if [[ "$email_expected" == "active" ]]; then
    [[ -f "${FAKE_STATE}/aais-email-outbox.timer.active" ]] \
      || { echo "${fault_case}: email timer was not restored active" >&2; return 1; }
  else
    [[ ! -f "${FAKE_STATE}/aais-email-outbox.timer.active" ]] \
      || { echo "${fault_case}: email timer did not remain inactive" >&2; return 1; }
  fi
  if [[ "$lrs_expected" == "active" ]]; then
    [[ -f "${FAKE_STATE}/aais-lrs-outbox.timer.active" ]] \
      || { echo "${fault_case}: LRS timer was not restored active" >&2; return 1; }
  else
    [[ ! -f "${FAKE_STATE}/aais-lrs-outbox.timer.active" ]] \
      || { echo "${fault_case}: LRS timer did not remain inactive" >&2; return 1; }
  fi
}

assert_committed() {
  local fault_case="$1"
  local receipt_count
  grep -q '3102' /opt/aais/nginx/upstream-active.conf \
    || { echo "${fault_case}: candidate upstream was not committed" >&2; return 1; }
  cmp -s /opt/aais/nginx/upstream-active.conf "${FAKE_STATE}/loaded-upstream" \
    || { echo "${fault_case}: loaded Nginx path is not the committed path" >&2; return 1; }
  grep -q "AAIS_ACTIVE_RELEASE_SHA=${NEW_RELEASE}" /opt/aais/state/active-deployment.env \
    || { echo "${fault_case}: candidate state was not committed" >&2; return 1; }
  receipt_count="$(find /opt/aais/receipts -maxdepth 1 -type f -name '*.json' \
    | wc -l | tr -d '[:space:]')"
  [[ "$receipt_count" == "1" ]] \
    || { echo "${fault_case}: committed receipt count is ${receipt_count}" >&2; return 1; }
  [[ -f "${FAKE_STATE}/fault-injected" ]] \
    || { echo "${fault_case}: TERM was not injected" >&2; return 1; }
  [[ -e "${FAKE_STATE}/aais-green.exists" \
    && "$(cat "${FAKE_STATE}/aais-green.running")" == "true" ]] \
    || { echo "${fault_case}: committed target is not running" >&2; return 1; }
  [[ "$(cat "${FAKE_STATE}/aais-blue.running")" == "false" ]] \
    || { echo "${fault_case}: prior container was not drained" >&2; return 1; }
  [[ -f "${FAKE_STATE}/aais-email-outbox.timer.active" \
    && -f "${FAKE_STATE}/aais-lrs-outbox.timer.active" ]] \
    || { echo "${fault_case}: timers are not active after commit" >&2; return 1; }
}

run_case() {
  local fault_case="$1"
  local status
  prepare_case "$fault_case"
  set +e
  PATH="${FAKE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="${TEST_ROOT}/malicious-home" \
    HTTPS_PROXY=http://proxy.invalid:8443 \
    ALL_PROXY=socks5://proxy.invalid:1080 \
    AAIS_DEPLOY_CONFIG_FILE=/opt/aais/deploy.env \
    timeout 30s /aais-test/aais-deploy.sh "$IMAGE_REF" "$NEW_RELEASE" \
    > "${FAKE_STATE}/stdout.log" 2> "${FAKE_STATE}/stderr.log"
  status=$?
  set -e
  if [[ "$fault_case" == "after-receipt-publish" ]]; then
    if [[ "$status" -ne 0 ]]; then
      echo "${fault_case}: durable receipt commit returned status=${status}" >&2
      sed -n '1,160p' "${FAKE_STATE}/stderr.log" >&2
      exit 1
    fi
    assert_committed "$fault_case"
    printf 'PASS %s status=%s\n' "$fault_case" "$status"
    return
  fi
  if [[ "$status" -eq 0 || "$status" -eq 124 ]]; then
    echo "${fault_case}: deployment did not fail promptly (status=${status})" >&2
    sed -n '1,160p' "${FAKE_STATE}/stderr.log" >&2
    exit 1
  fi
  assert_recovered "$fault_case"
  if [[ "$fault_case" == "canonical-marker-fence" \
    || "$fault_case" == "invalid-marker-fence" \
    || "$fault_case" == "pending-without-inherited-fence" \
    || "$fault_case" == "timer-query-error" \
    || "$fault_case" == "timer-state-unknown" \
    || "$fault_case" == "timer-state-failed" \
    || "$fault_case" == "timer-load-not-found" \
    || "$fault_case" == "candidate-receipt-dir-mode-fence" \
    || "$fault_case" == "preloaded-receipt-dir-symlink-fence" \
    || "$fault_case" == "receipt-dir-owner-fence" ]]; then
    if grep -Eq '^(docker|nginx|mv) |^systemctl (stop|start) ' \
      "${FAKE_STATE}/operations.log"; then
      echo "${fault_case}: a mutation crossed the preflight fence" >&2
      exit 1
    fi
  fi
  printf 'PASS %s status=%s\n' "$fault_case" "$status"
}

fault_cases="${AAIS_DEPLOY_FAULT_CASE:-after-upstream-publish after-nginx-reload after-state-publish after-receipt-publish first-after-upstream-publish first-after-nginx-reload fail-upstream-publish fail-nginx-reload canonical-marker-fence invalid-marker-fence pending-without-inherited-fence timer-query-error timer-state-unknown timer-state-failed timer-load-not-found candidate-receipt-dir-mode-fence preloaded-receipt-dir-symlink-fence receipt-dir-owner-fence after-state-publish-email-active-lrs-inactive after-state-publish-email-inactive-lrs-active ss-query-error-at-drain}"
for fault_case in $fault_cases; do
  run_case "$fault_case"
done
