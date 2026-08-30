#!/usr/bin/env bash
set -Eeuo pipefail

validation_only="false"
validation_source=""
if [[ "$#" -eq 2 && "${1:-}" == "--validate-file" \
  && ( "${2:-}" == "/etc/aais/secrets/runtime.env.candidate" \
    || "${2:-}" == "/etc/aais/secrets/runtime.env.previous" ) ]]; then
  validation_only="true"
  validation_source="$2"
elif [[ "$#" -ne 0 ]]; then
  echo "AAIS secret bootstrap accepts only the protected validation candidate." >&2
  exit 1
fi

bootstrap_config="${AAIS_SECRETS_BOOTSTRAP_CONFIG:-/etc/aais/secrets-bootstrap.env}"
if [[ ! -r "$bootstrap_config" ]]; then
  echo "AAIS secret bootstrap configuration is unavailable." >&2
  exit 1
fi
bootstrap_mode="$(stat -c '%a' "$bootstrap_config")"
bootstrap_owner="$(stat -c '%u' "$bootstrap_config")"
if [[ "$bootstrap_owner" != "0" || "$bootstrap_mode" != "600" ]]; then
  echo "AAIS secret bootstrap configuration must be root-owned with mode 0600." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$bootstrap_config"

: "${AAIS_SECRET_SOURCE:=file}"
: "${AAIS_ALIYUN_CLI:=/usr/local/bin/aliyun}"
: "${AAIS_ALIYUN_CLI_PROFILE:=aais-ecs-role}"
: "${AAIS_OPERATION_LOCK_FILE:=/opt/aais/state/deploy.lock}"
: "${AAIS_STATE_FILE:=/opt/aais/state/active-deployment.env}"
: "${AAIS_ROTATION_PENDING_FILE:=/opt/aais/state/secret-rotation.pending}"

for command_name in install mktemp chown chmod mv awk flock readlink sha256sum ln cp stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "AAIS secret bootstrap dependency is unavailable: ${command_name}." >&2
    exit 1
  fi
done

install -d -o root -g root -m 0755 "$(dirname "$AAIS_OPERATION_LOCK_FILE")"
if [[ "$AAIS_OPERATION_LOCK_FILE" != /opt/aais/state/deploy.lock \
  || "$AAIS_STATE_FILE" != /opt/aais/state/active-deployment.env \
  || "$AAIS_ROTATION_PENDING_FILE" != /opt/aais/state/secret-rotation.pending \
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

install -d -o root -g aais-worker -m 0750 /run/aais /run/aais/generations
if [[ -e /run/aais/current && ! -L /run/aais/current ]]; then
  echo "AAIS current secret generation path is not a symlink." >&2
  exit 1
fi
previous_generation_target="$(readlink /run/aais/current 2>/dev/null || true)"
if [[ -n "$previous_generation_target" \
  && ! "$previous_generation_target" =~ ^generations/generation-[a-f0-9]{64}-[0-9]+$ ]]; then
  echo "AAIS current secret generation target is invalid." >&2
  exit 1
fi
generation_candidate="$(mktemp -d /run/aais/generations/.candidate.XXXXXX)"
runtime_candidate="${generation_candidate}/runtime.env"
worker_candidate="${generation_candidate}/worker.env"
receipt_candidate="${generation_candidate}/secret-bootstrap.receipt.json"
generation_dir=""
switch_dir=""
generation_published="false"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$validation_only" != "true" && "$status" -ne 0 && -f "$AAIS_STATE_FILE" \
    && ! -e "$AAIS_ROTATION_PENDING_FILE" ]]; then
    bootstrap_failure_marker="$(mktemp "$(dirname "$AAIS_ROTATION_PENDING_FILE")/secret-bootstrap.failed.XXXXXX" 2>/dev/null || true)"
    if [[ -n "$bootstrap_failure_marker" ]]; then
      printf 'failed\n' > "$bootstrap_failure_marker" 2>/dev/null || true
      chown root:root "$bootstrap_failure_marker" >/dev/null 2>&1 || true
      chmod 0600 "$bootstrap_failure_marker" >/dev/null 2>&1 || true
      mv -Tf -- "$bootstrap_failure_marker" "$AAIS_ROTATION_PENDING_FILE" \
        >/dev/null 2>&1 || true
      rm -f -- "$bootstrap_failure_marker" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$switch_dir" && "$switch_dir" == /run/aais/.switch.* ]]; then
    rm -rf -- "$switch_dir"
  fi
  if [[ "$generation_published" != "true" ]]; then
    if [[ -n "$generation_candidate" \
      && "$generation_candidate" == /run/aais/generations/.candidate.* ]]; then
      rm -rf -- "$generation_candidate"
    fi
    if [[ -n "$generation_dir" \
      && "$generation_dir" == /run/aais/generations/generation-* ]]; then
      rm -rf -- "$generation_dir"
    fi
  fi
  unset response secret_data runtime_base64 bundle_version secret_version
  exit "$status"
}
trap cleanup EXIT

case "$AAIS_SECRET_SOURCE" in
  file)
    local_secret_dir="/etc/aais/secrets"
    local_runtime_source="/etc/aais/secrets/runtime.env"
    if [[ "$validation_only" == "true" ]]; then
      local_runtime_source="$validation_source"
    fi
    local_secret_dir_owner="$(stat -c '%u' "$local_secret_dir" 2>/dev/null || true)"
    local_secret_dir_mode="$(stat -c '%a' "$local_secret_dir" 2>/dev/null || true)"
    if [[ ! -d "$local_secret_dir" || -L "$local_secret_dir" \
      || "$(readlink -f "$local_secret_dir" 2>/dev/null || true)" != "$local_secret_dir" \
      || "$local_secret_dir_owner" != "0" \
      || "$local_secret_dir_mode" != "700" ]]; then
      echo "AAIS local secret directory must be root-owned with mode 0700." >&2
      exit 1
    fi
    local_secret_owner="$(stat -c '%u' "$local_runtime_source" 2>/dev/null || true)"
    local_secret_mode="$(stat -c '%a' "$local_runtime_source" 2>/dev/null || true)"
    local_secret_links="$(stat -c '%h' "$local_runtime_source" 2>/dev/null || true)"
    if [[ ! -f "$local_runtime_source" || -L "$local_runtime_source" \
      || "$(readlink -f "$local_runtime_source" 2>/dev/null || true)" != "$local_runtime_source" \
      || "$local_secret_owner" != "0" || "$local_secret_mode" != "400" \
      || "$local_secret_links" != "1" ]]; then
      echo "AAIS local runtime secret source must be one regular root-owned file with mode 0400." >&2
      exit 1
    fi
    local_source_sha_before="$(sha256sum "$local_runtime_source" | awk '{ print $1 }')"
    cp -- "$local_runtime_source" "$runtime_candidate"
    local_source_sha_after="$(sha256sum "$local_runtime_source" | awk '{ print $1 }')"
    local_candidate_sha="$(sha256sum "$runtime_candidate" | awk '{ print $1 }')"
    if [[ "$local_source_sha_before" != "$local_source_sha_after" \
      || "$local_source_sha_before" != "$local_candidate_sha" ]]; then
      echo "AAIS local runtime secret source changed while it was being snapshotted." >&2
      exit 1
    fi
    bundle_version="$(awk -F= '
      index($0, "AAIS_SECRET_BUNDLE_VERSION=") == 1 {
        count += 1
        value = substr($0, length("AAIS_SECRET_BUNDLE_VERSION=") + 1)
      }
      END { if (count != 1) exit 1; print value }
    ' "$runtime_candidate")"
    secret_version="$bundle_version"
    ;;
  kms)
    if [[ "$validation_only" == "true" ]]; then
      echo "AAIS KMS mode does not accept a local validation candidate." >&2
      exit 1
    fi
    : "${AAIS_KMS_SECRET_NAME:?AAIS_KMS_SECRET_NAME is required}"
    : "${AAIS_KMS_API_ENDPOINT:?AAIS_KMS_API_ENDPOINT is required}"
    for kms_command in jq base64; do
      if ! command -v "$kms_command" >/dev/null 2>&1; then
        echo "AAIS KMS bootstrap dependency is unavailable: ${kms_command}." >&2
        exit 1
      fi
    done
    if [[ ! -x "$AAIS_ALIYUN_CLI" ]]; then
      echo "AAIS Alibaba Cloud CLI is unavailable." >&2
      exit 1
    fi
    response="$("$AAIS_ALIYUN_CLI" kms GetSecretValue \
      --profile "$AAIS_ALIYUN_CLI_PROFILE" \
      --endpoint "$AAIS_KMS_API_ENDPOINT" \
      --SecretName "$AAIS_KMS_SECRET_NAME" \
      --VersionStage ACSCurrent)"
    secret_data="$(jq -er '.SecretData' <<<"$response")"
    secret_version="$(jq -er '.VersionId' <<<"$response")"
    runtime_base64="$(jq -er 'fromjson | .runtimeEnvBase64' <<<"$secret_data")"
    bundle_version="$(jq -er 'fromjson | .bundleVersion' <<<"$secret_data")"
    printf '%s' "$runtime_base64" | base64 --decode > "$runtime_candidate"
    ;;
  *)
    echo "AAIS_SECRET_SOURCE must be file or kms." >&2
    exit 1
    ;;
esac

if [[ ! "$secret_version" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ \
  || ! "$bundle_version" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
  echo "AAIS secret bundle version metadata is invalid." >&2
  exit 1
fi

if ! awk -F= -v expected_bundle="$bundle_version" '
  !/^[A-Z][A-Z0-9_]*=/ { exit 1 }
  { if (seen[$1]++) exit 1; values[$1]=substr($0, index($0, "=") + 1) }
  END {
    if (!seen["NODE_ENV"] || !seen["AAIS_DATABASE_URL"] ||
        !seen["AAIS_DATABASE_TARGET_ID"] || !seen["AAIS_SESSION_SECRET"] ||
        !seen["AAIS_PRODUCT_PSEUDONYM_SECRET"] || !seen["AAIS_RESEARCH_MODE"] ||
        !seen["AAIS_DEPLOYMENT_PROVIDER"] ||
        !seen["AAIS_DATABASE_PROVIDER"] ||
        !seen["AAIS_SECRET_BUNDLE_VERSION"] ||
        !seen["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] ||
        !seen["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"] ||
        values["NODE_ENV"] != "production" ||
        values["AAIS_DEPLOYMENT_PROVIDER"] != "aliyun" ||
        values["AAIS_DATABASE_PROVIDER"] !~ /^(neon|postgres|rds)$/ ||
        values["AAIS_SECRET_BUNDLE_VERSION"] != expected_bundle ||
        values["AAIS_RESEARCH_MODE"] != "false" ||
        values["AAIS_DATABASE_URL"] !~ /^postgres(ql)?:\/\// ||
        values["AAIS_DATABASE_TARGET_ID"] !~ /^[A-Za-z0-9][A-Za-z0-9._:-]+$/ ||
        length(values["AAIS_DATABASE_TARGET_ID"]) > 128 ||
        length(values["AAIS_SESSION_SECRET"]) < 32 ||
        length(values["AAIS_SESSION_SECRET"]) > 512 ||
        length(values["AAIS_PRODUCT_PSEUDONYM_SECRET"]) != 43 ||
        values["AAIS_PRODUCT_PSEUDONYM_SECRET"] !~ /^[A-Za-z0-9_-]+$/ ||
        length(values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"]) < 32 ||
        length(values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"]) < 32 ||
        values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] == values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"] ||
        values["AAIS_SESSION_SECRET"] == values["AAIS_PRODUCT_PSEUDONYM_SECRET"] ||
        values["AAIS_SESSION_SECRET"] == values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] ||
        values["AAIS_SESSION_SECRET"] == values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"] ||
        values["AAIS_PRODUCT_PSEUDONYM_SECRET"] == values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] ||
        values["AAIS_PRODUCT_PSEUDONYM_SECRET"] == values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"]) exit 1
    session_secret = values["AAIS_SESSION_SECRET"]
    for (index = 1; index <= length(session_secret); index += 1) {
      session_character = substr(session_secret, index, 1)
      if (!(session_character in session_characters)) {
        session_characters[session_character] = 1
        session_character_count += 1
      }
    }
    normalized_session = tolower(session_secret)
    if (session_character_count < 8 ||
        session_secret == "aais-dev-session-secret-do-not-use-for-production" ||
        normalized_session ~ /^(change|replace|todo|tbd|example|sample|test)[-_ ]?me/) exit 1
  }
' "$runtime_candidate"; then
  echo "AAIS runtime secret bundle structure is invalid." >&2
  exit 1
fi
if [[ "$validation_only" != "true" && -f "$AAIS_STATE_FILE" ]]; then
  recorded_bundle_owner="$(stat -c '%u' "$AAIS_STATE_FILE" 2>/dev/null || true)"
  recorded_bundle_mode="$(stat -c '%a' "$AAIS_STATE_FILE" 2>/dev/null || true)"
  recorded_bundle="$(awk -F= '
    $1 == "AAIS_ACTIVE_SECRET_BUNDLE_VERSION" {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END { if (count != 1) exit 1; print value }
  ' "$AAIS_STATE_FILE")"
  if [[ "$recorded_bundle_owner" != "0" || "$recorded_bundle_mode" != "644" \
    || ! "$recorded_bundle" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
    echo "AAIS atomic active deployment state is invalid." >&2
    exit 1
  fi
  if [[ "$recorded_bundle" != "$bundle_version" \
    && ! -f "$AAIS_ROTATION_PENDING_FILE" ]]; then
    echo "AAIS local secret source changed outside the guarded rotation workflow." >&2
    exit 1
  fi
fi
awk -F= '
  {
    values[$1] = substr($0, index($0, "=") + 1)
  }
  END {
    print "AAIS_SECRET_BUNDLE_VERSION=" values["AAIS_SECRET_BUNDLE_VERSION"]
    print "AAIS_LRS_OUTBOX_FLUSH_TOKEN=" values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"]
    print "AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN=" values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"]
  }
' "$runtime_candidate" > "$worker_candidate"
if ! awk -F= -v expected_bundle="$bundle_version" '
  !/^(AAIS_SECRET_BUNDLE_VERSION|AAIS_LRS_OUTBOX_FLUSH_TOKEN|AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN)=/ { exit 1 }
  {
    if (seen[$1]++) exit 1
    value=substr($0, index($0, "=") + 1)
    values[$1]=value
    if ($1 != "AAIS_SECRET_BUNDLE_VERSION" && length(value) < 32) exit 1
  }
  END {
    if (!seen["AAIS_SECRET_BUNDLE_VERSION"] ||
        values["AAIS_SECRET_BUNDLE_VERSION"] != expected_bundle ||
        !seen["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] ||
        !seen["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"] ||
        values["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] == values["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"]) exit 1
  }
' "$worker_candidate"; then
  echo "AAIS worker secret bundle structure is invalid." >&2
  exit 1
fi
if ! awk -F= '
  NR == FNR {
    runtime[$1] = substr($0, index($0, "=") + 1)
    next
  }
  { worker[$1] = substr($0, index($0, "=") + 1) }
  END {
    if (runtime["AAIS_SECRET_BUNDLE_VERSION"] != worker["AAIS_SECRET_BUNDLE_VERSION"] ||
        runtime["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] != worker["AAIS_LRS_OUTBOX_FLUSH_TOKEN"] ||
        runtime["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"] != worker["AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN"]) exit 1
  }
' "$runtime_candidate" "$worker_candidate"; then
  echo "AAIS runtime and worker secret bundles do not match." >&2
  exit 1
fi
if [[ "$validation_only" == "true" ]]; then
  echo "AAIS protected local secret candidate validation passed."
  exit 0
fi

chown root:root "$runtime_candidate"
chmod 0400 "$runtime_candidate"
chown root:aais-worker "$worker_candidate"
chmod 0440 "$worker_candidate"
printf '{"schemaVersion":1,"source":"%s","secretVersion":"%s","bundleVersion":"%s","secrets":"redacted"}\n' \
  "$AAIS_SECRET_SOURCE" "$secret_version" "$bundle_version" > "$receipt_candidate"
chown root:root "$receipt_candidate"
chmod 0444 "$receipt_candidate"
chown root:aais-worker "$generation_candidate"
chmod 0750 "$generation_candidate"

generation_id="$(printf '%s\0%s' "$bundle_version" "$secret_version" | sha256sum | awk '{ print $1 }')"
generation_dir="/run/aais/generations/generation-${generation_id}-$$"
if [[ -e "$generation_dir" ]]; then
  echo "AAIS secret generation already exists." >&2
  exit 1
fi
mv -- "$generation_candidate" "$generation_dir"
generation_candidate=""
switch_dir="$(mktemp -d /run/aais/.switch.XXXXXX)"
ln -s "generations/$(basename "$generation_dir")" "${switch_dir}/current"
mv -Tf -- "${switch_dir}/current" /run/aais/current
generation_published="true"
rmdir -- "$switch_dir"
switch_dir=""

rm -f -- /run/aais/runtime.env /run/aais/worker.env /run/aais/secret-bootstrap.receipt.json
if [[ -n "$previous_generation_target" \
  && "$previous_generation_target" != "generations/$(basename "$generation_dir")" ]]; then
  previous_generation_dir="/run/aais/${previous_generation_target}"
  if [[ "$previous_generation_dir" =~ ^/run/aais/generations/generation-[a-f0-9]{64}-[0-9]+$ ]]; then
    rm -rf -- "$previous_generation_dir"
  fi
fi
unset response secret_data runtime_base64
echo "AAIS secret bootstrap completed for bundle ${bundle_version}."
