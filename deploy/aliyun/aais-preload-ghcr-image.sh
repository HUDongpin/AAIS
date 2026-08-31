#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"
readonly AAIS_JSON_HELPER_SHA256="b94a6a7485c8b760cdcf3275c7cf82199e82eafa099213e640152d86dea0dd03"

aais_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

aais_stat_owner() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null
}

aais_stat_links() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1" 2>/dev/null
}

aais_stat_identity() {
  stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null
}

aais_run_json_helper() {
  local helper_path="$1"
  shift
  /usr/bin/env -i LC_ALL=C LANG=C HOME=/ TZ=UTC \
    /usr/bin/python3 -I -S -B "$helper_path" "$@"
}

aais_require_json_helper() {
  local helper_dir="/opt/aais/libexec"
  local dir_mode dir_owner helper_mode helper_owner helper_links
  local identity_before identity_after actual_sha256
  if [[ ! -x /usr/bin/env || ! -x /usr/bin/python3 ]] \
    || ! command -v stat >/dev/null 2>&1 \
    || ! command -v readlink >/dev/null 2>&1 \
    || ! command -v sha256sum >/dev/null 2>&1 \
    || ! command -v awk >/dev/null 2>&1; then
    echo "AAIS protected JSON runtime is unavailable." >&2
    return 1
  fi
  dir_mode="$(aais_stat_mode "$helper_dir" || true)"
  dir_owner="$(aais_stat_owner "$helper_dir" || true)"
  if [[ ! -d "$helper_dir" || -L "$helper_dir" \
    || "$(readlink -f "$helper_dir" 2>/dev/null || true)" != "$helper_dir" \
    || "$dir_owner" != "0" || "$dir_mode" != "700" ]]; then
    echo "AAIS protected JSON helper directory is invalid." >&2
    return 1
  fi
  helper_mode="$(aais_stat_mode "$AAIS_JSON_HELPER_PATH" || true)"
  helper_owner="$(aais_stat_owner "$AAIS_JSON_HELPER_PATH" || true)"
  helper_links="$(aais_stat_links "$AAIS_JSON_HELPER_PATH" || true)"
  identity_before="$(aais_stat_identity "$AAIS_JSON_HELPER_PATH" || true)"
  if [[ ! -f "$AAIS_JSON_HELPER_PATH" || -L "$AAIS_JSON_HELPER_PATH" \
    || "$helper_owner" != "0" || "$helper_mode" != "500" \
    || "$helper_links" != "1" || -z "$identity_before" ]]; then
    echo "AAIS protected JSON helper is invalid." >&2
    return 1
  fi
  actual_sha256="$(sha256sum "$AAIS_JSON_HELPER_PATH" 2>/dev/null | awk '{ print $1 }')"
  identity_after="$(aais_stat_identity "$AAIS_JSON_HELPER_PATH" || true)"
  if [[ "$actual_sha256" != "$AAIS_JSON_HELPER_SHA256" \
    || "$identity_after" != "$identity_before" ]]; then
    echo "AAIS protected JSON helper fingerprint does not match." >&2
    return 1
  fi
  if ! aais_run_json_helper "$AAIS_JSON_HELPER_PATH" self-test >/dev/null; then
    echo "AAIS protected JSON helper self-test failed." >&2
    return 1
  fi
}

aais_require_owner_tty() {
  if [[ ! -t 0 || ! -t 1 || ! -r /dev/tty ]]; then
    echo "AAIS GHCR preload requires an interactive controlling TTY." >&2
    return 1
  fi
}

aais_validate_ghcr_username() {
  local username="$1"
  if [[ ! "$username" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; then
    echo "AAIS GHCR username is invalid." >&2
    return 1
  fi
}

aais_require_protected_file() {
  local file="$1"
  local expected_mode="$2"
  local label="$3"
  local expected_owner="${4:-0}"
  local actual_mode actual_owner
  actual_mode="$(aais_stat_mode "$file" || true)"
  actual_owner="$(aais_stat_owner "$file" || true)"
  if [[ ! -f "$file" || -L "$file" \
    || "$actual_owner" != "$expected_owner" || "$actual_mode" != "$expected_mode" ]]; then
    echo "${label} must be a protected regular file owned by the expected user with mode 0${expected_mode}." >&2
    return 1
  fi
}

aais_require_protected_directory() {
  local directory="$1"
  local expected_mode="$2"
  local label="$3"
  local expected_owner="${4:-0}"
  local actual_mode actual_owner canonical_directory
  actual_mode="$(aais_stat_mode "$directory" || true)"
  actual_owner="$(aais_stat_owner "$directory" || true)"
  canonical_directory="$(readlink -f "$directory" 2>/dev/null || true)"
  if [[ ! -d "$directory" || -L "$directory" \
    || "$canonical_directory" != "$directory" \
    || "$actual_owner" != "$expected_owner" \
    || "$actual_mode" != "$expected_mode" ]]; then
    echo "${label} must be a protected canonical directory owned by the expected user with mode 0${expected_mode}." >&2
    return 1
  fi
}

aais_validate_ghcr_candidate_receipt() {
  local receipt="$1"
  local release_sha="$2"
  local expected_digest="$3"
  local helper_path="${4:-$AAIS_JSON_HELPER_PATH}"
  aais_run_json_helper "$helper_path" candidate-metadata \
    "$receipt" "$release_sha" "$expected_digest"
}

aais_validate_ghcr_preloaded_receipt() {
  local receipt="$1"
  local release_sha="$2"
  local image_digest="$3"
  local candidate_run_id="$4"
  local candidate_run_attempt="$5"
  local helper_path="${6:-$AAIS_JSON_HELPER_PATH}"
  aais_run_json_helper "$helper_path" validate-preloaded \
    "$receipt" "$release_sha" "$image_digest" \
    "$candidate_run_id" "$candidate_run_attempt"
}

aais_write_ghcr_preloaded_receipt() {
  local release_sha="$1"
  local image_digest="$2"
  local candidate_run_id="$3"
  local candidate_run_attempt="$4"
  local pulled_at="$5"
  local helper_path="${6:-$AAIS_JSON_HELPER_PATH}"
  aais_run_json_helper "$helper_path" write-preloaded \
    "$release_sha" "$image_digest" "$candidate_run_id" \
    "$candidate_run_attempt" "$pulled_at"
}

aais_validate_local_image_provenance() {
  local repo_digests="$1"
  local image_revision="$2"
  local expected_repo_digest="$3"
  local expected_revision="$4"
  local repo_digest matched="false"
  while IFS= read -r repo_digest; do
    if [[ "$repo_digest" == "$expected_repo_digest" ]]; then
      matched="true"
      break
    fi
  done <<<"$repo_digests"
  if [[ "$matched" != "true" || "$image_revision" != "$expected_revision" ]]; then
    echo "AAIS local image digest or OCI revision does not match the candidate." >&2
    return 1
  fi
}

aais_cleanup_ghcr_credentials() {
  local config_dir="$1"
  local allowed_parent="$2"
  local registry="$3"
  local cleanup_status=0
  case "$config_dir" in
    "$allowed_parent"/ghcr-docker-config.*) ;;
    *)
      echo "AAIS temporary Docker credential path is outside its protected parent." >&2
      return 1
      ;;
  esac
  if [[ -L "$config_dir" ]]; then
    echo "AAIS temporary Docker credential directory cannot be a symlink." >&2
    return 1
  fi
  if [[ -d "$config_dir" ]]; then
    export DOCKER_CONFIG="$config_dir"
    docker logout "$registry" >/dev/null 2>&1 || cleanup_status=1
    find "$config_dir" -xdev -mindepth 1 -delete || cleanup_status=1
    rmdir "$config_dir" || cleanup_status=1
  fi
  unset DOCKER_CONFIG
  if [[ -e "$config_dir" || -L "$config_dir" ]]; then
    cleanup_status=1
  fi
  return "$cleanup_status"
}

aais_preload_docker_config_dir=""
aais_preload_credential_parent=""
aais_preload_credentials_present="false"
aais_preload_receipt_candidate=""
aais_preload_receipt_parent=""
aais_preload_receipt_release_sha=""

aais_preload_exit_cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM HUP
  set +e
  unset ghcr_token
  if [[ "$aais_preload_credentials_present" == "true" ]]; then
    aais_cleanup_ghcr_credentials "$aais_preload_docker_config_dir" \
      "$aais_preload_credential_parent" ghcr.io || cleanup_status=1
    aais_preload_credentials_present="false"
  fi
  if [[ -n "$aais_preload_receipt_candidate" ]]; then
    case "$aais_preload_receipt_candidate" in
      "$aais_preload_receipt_parent"/.preloaded-"$aais_preload_receipt_release_sha".*)
        rm -f -- "$aais_preload_receipt_candidate" || cleanup_status=1
        ;;
      *) cleanup_status=1 ;;
    esac
    aais_preload_receipt_candidate=""
  fi
  if [[ "$cleanup_status" -ne 0 && "$status" -eq 0 ]]; then
    status=1
  fi
  exit "$status"
}

aais_preload_main() {
  if [[ "$EUID" -ne 0 ]]; then
    echo "AAIS GHCR preload must run as root." >&2
    return 1
  fi
  local script_path script_owner script_mode
  script_path="$(readlink -f "${BASH_SOURCE[0]}")"
  script_owner="$(aais_stat_owner "$script_path" || true)"
  script_mode="$(aais_stat_mode "$script_path" || true)"
  if [[ -L "${BASH_SOURCE[0]}" || "$script_owner" != "0" \
    || ! "$script_mode" =~ ^(700|750|755)$ ]]; then
    echo "AAIS GHCR preload helper must be a root-owned executable regular file." >&2
    return 1
  fi
  if [[ "$#" -ne 1 || ! "${1:-}" =~ ^[a-f0-9]{40}$ ]]; then
    echo "Usage: aais-preload-ghcr-image.sh <full-40-character-git-sha>" >&2
    return 1
  fi
  local release_sha="$1"
  aais_require_json_helper
  local deploy_config_file="${AAIS_DEPLOY_CONFIG_FILE:-/etc/aais/deploy.env}"
  aais_require_protected_file "$deploy_config_file" 600 \
    "AAIS deploy configuration"
  # shellcheck source=/dev/null
  source "$deploy_config_file"

  : "${AAIS_IMAGE_SOURCE:?AAIS_IMAGE_SOURCE is required}"
  : "${AAIS_GHCR_REPOSITORY:?AAIS_GHCR_REPOSITORY is required}"
  : "${AAIS_GHCR_USERNAME:?AAIS_GHCR_USERNAME is required}"
  : "${AAIS_CANDIDATE_RECEIPT_DIR:=/opt/aais/candidates}"
  : "${AAIS_PRELOADED_RECEIPT_DIR:=/opt/aais/preloaded}"
  if [[ "$AAIS_IMAGE_SOURCE" != "ghcr-preloaded" \
    || "$AAIS_GHCR_REPOSITORY" != "ghcr.io/hudongpin/aais" \
    || "$AAIS_CANDIDATE_RECEIPT_DIR" != "/opt/aais/candidates" \
    || "$AAIS_PRELOADED_RECEIPT_DIR" != "/opt/aais/preloaded" ]]; then
    echo "AAIS GHCR preload bindings are invalid." >&2
    return 1
  fi
  aais_validate_ghcr_username "$AAIS_GHCR_USERNAME"
  aais_require_protected_directory "$AAIS_CANDIDATE_RECEIPT_DIR" 755 \
    "AAIS GHCR candidate receipt directory"
  aais_require_protected_directory "$AAIS_PRELOADED_RECEIPT_DIR" 755 \
    "AAIS GHCR preloaded receipt directory"

  local required_command
  for required_command in chmod chown date docker find getent install mktemp \
    mv readlink rmdir stat; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      echo "AAIS GHCR preload dependency is unavailable: ${required_command}." >&2
      return 1
    fi
  done

  local candidate_receipt="${AAIS_CANDIDATE_RECEIPT_DIR}/${release_sha}.json"
  aais_require_protected_file "$candidate_receipt" 644 \
    "AAIS GHCR candidate receipt"
  local candidate_metadata image_digest candidate_run_id candidate_run_attempt
  candidate_metadata="$(aais_validate_ghcr_candidate_receipt \
    "$candidate_receipt" "$release_sha" -)" || {
      echo "AAIS GHCR candidate receipt does not match the requested release." >&2
      return 1
    }
  IFS=$'\t' read -r image_digest candidate_run_id candidate_run_attempt \
    <<<"$candidate_metadata"
  local image_ref="${AAIS_GHCR_REPOSITORY}@${image_digest}"

  local preloaded_receipt="${AAIS_PRELOADED_RECEIPT_DIR}/${release_sha}.json"
  if [[ -e "$preloaded_receipt" || -L "$preloaded_receipt" ]]; then
    aais_require_protected_file "$preloaded_receipt" 644 \
      "AAIS existing preloaded receipt"
    if ! aais_validate_ghcr_preloaded_receipt "$preloaded_receipt" \
      "$release_sha" "$image_digest" "$candidate_run_id" \
      "$candidate_run_attempt"; then
      echo "AAIS existing preloaded receipt does not match the candidate." >&2
      return 1
    fi
  fi

  aais_require_owner_tty
  local runtime_parent="/run/aais"
  if [[ -L "$runtime_parent" ]]; then
    echo "AAIS runtime directory cannot be a symlink." >&2
    return 1
  fi
  if ! getent group aais-worker >/dev/null; then
    echo "AAIS worker group is unavailable." >&2
    return 1
  fi
  install -d -o root -g aais-worker -m 0750 "$runtime_parent"
  aais_preload_credential_parent="${runtime_parent}/ghcr-credentials"
  if [[ -L "$aais_preload_credential_parent" ]]; then
    echo "AAIS GHCR credential parent cannot be a symlink." >&2
    return 1
  fi
  install -d -o root -g root -m 0700 "$aais_preload_credential_parent"
  aais_preload_docker_config_dir="$(mktemp -d \
    "${aais_preload_credential_parent}/ghcr-docker-config.XXXXXX")"
  chmod 0700 "$aais_preload_docker_config_dir"
  unset DOCKER_CONFIG
  export DOCKER_CONFIG="$aais_preload_docker_config_dir"

  local ghcr_token=""
  aais_preload_credentials_present="true"
  trap aais_preload_exit_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  printf 'GitHub short-lived read:packages token: ' > /dev/tty
  if ! IFS= read -r -s ghcr_token < /dev/tty; then
    printf '\n' > /dev/tty
    echo "AAIS GHCR token input was interrupted." >&2
    return 1
  fi
  printf '\n' > /dev/tty
  if [[ ${#ghcr_token} -lt 20 || ${#ghcr_token} -gt 255 \
    || "$ghcr_token" =~ [[:space:]] ]]; then
    echo "AAIS GHCR token format is invalid." >&2
    return 1
  fi
  printf '%s' "$ghcr_token" | docker login ghcr.io \
    --username "$AAIS_GHCR_USERNAME" --password-stdin >/dev/null
  ghcr_token=""
  unset ghcr_token
  docker pull "$image_ref" >/dev/null

  local repo_digests image_revision
  repo_digests="$(docker image inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref")"
  image_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image_ref")"
  aais_validate_local_image_provenance "$repo_digests" "$image_revision" \
    "$image_ref" "$release_sha"

  if ! aais_cleanup_ghcr_credentials "$aais_preload_docker_config_dir" \
    "$aais_preload_credential_parent" ghcr.io; then
    echo "AAIS GHCR credentials could not be completely removed." >&2
    return 1
  fi
  aais_preload_credentials_present="false"
  aais_preload_docker_config_dir=""

  local pulled_at
  aais_preload_receipt_parent="$AAIS_PRELOADED_RECEIPT_DIR"
  aais_preload_receipt_release_sha="$release_sha"
  aais_preload_receipt_candidate="$(mktemp \
    "${AAIS_PRELOADED_RECEIPT_DIR}/.preloaded-${release_sha}.XXXXXX")"
  pulled_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  aais_write_ghcr_preloaded_receipt "$release_sha" "$image_digest" \
    "$candidate_run_id" "$candidate_run_attempt" "$pulled_at" \
    > "$aais_preload_receipt_candidate"
  if ! aais_validate_ghcr_preloaded_receipt "$aais_preload_receipt_candidate" \
    "$release_sha" "$image_digest" "$candidate_run_id" \
    "$candidate_run_attempt"; then
    echo "AAIS generated preloaded receipt failed its validation round trip." >&2
    return 1
  fi
  chown root:root "$aais_preload_receipt_candidate"
  chmod 0644 "$aais_preload_receipt_candidate"
  mv -Tf -- "$aais_preload_receipt_candidate" "$preloaded_receipt"
  aais_preload_receipt_candidate=""
  trap - EXIT INT TERM HUP
  printf 'AAIS GHCR image preloaded: %s %s\n' "$release_sha" "$image_digest"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  aais_preload_main "$@"
fi
