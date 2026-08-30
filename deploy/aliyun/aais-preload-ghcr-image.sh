#!/usr/bin/env bash
set -Eeuo pipefail
set +x

aais_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

aais_stat_owner() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null
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

aais_validate_ghcr_candidate_receipt() {
  local receipt="$1"
  local release_sha="$2"
  local image_repository="$3"
  local image_digest="$4"
  jq -e \
    --arg gitSha "$release_sha" \
    --arg imageRepository "$image_repository" \
    --arg imageTag "${image_repository}:${release_sha}" \
    --arg imageDigest "$image_digest" '
      .schemaVersion == 1
      and .provider == "github"
      and .stage == "ghcr_candidate"
      and .gitSha == $gitSha
      and .imageRepository == $imageRepository
      and .imageTag == $imageTag
      and .imageDigest == $imageDigest
      and .packageVisibility == "private"
      and .sbomGenerated == true
      and .provenanceGenerated == true
      and (.provenanceAttestationId | type) == "string"
      and (.provenanceAttestationId | test("^[A-Za-z0-9._:-]+$"))
      and (.githubRunId | type) == "string"
      and (.githubRunId | test("^[0-9]+$"))
      and (.githubRunAttempt | type) == "string"
      and (.githubRunAttempt | test("^[0-9]+$"))
      and .secrets == "redacted"
    ' "$receipt" >/dev/null
}

aais_validate_ghcr_preloaded_receipt() {
  local receipt="$1"
  local release_sha="$2"
  local image_repository="$3"
  local image_digest="$4"
  local candidate_run_id="$5"
  local candidate_run_attempt="$6"
  jq -e \
    --arg gitSha "$release_sha" \
    --arg imageRepository "$image_repository" \
    --arg imageDigest "$image_digest" \
    --arg localRepoDigest "${image_repository}@${image_digest}" \
    --arg candidateRunId "$candidate_run_id" \
    --arg candidateRunAttempt "$candidate_run_attempt" '
      .schemaVersion == 1
      and .provider == "github"
      and .stage == "ghcr_preloaded"
      and .gitSha == $gitSha
      and .imageRepository == $imageRepository
      and .imageDigest == $imageDigest
      and .localRepoDigest == $localRepoDigest
      and .imageRevision == $gitSha
      and .candidateRunId == $candidateRunId
      and .candidateRunAttempt == $candidateRunAttempt
      and .credentialsCleaned == true
      and (.pulledAt | type) == "string"
      and (.pulledAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
      and .secrets == "redacted"
    ' "$receipt" >/dev/null
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
    || "$AAIS_CANDIDATE_RECEIPT_DIR" != /opt/aais/* \
    || "$AAIS_PRELOADED_RECEIPT_DIR" != /opt/aais/* \
    || -L "$AAIS_CANDIDATE_RECEIPT_DIR" \
    || -L "$AAIS_PRELOADED_RECEIPT_DIR" ]]; then
    echo "AAIS GHCR preload bindings are invalid." >&2
    return 1
  fi
  aais_validate_ghcr_username "$AAIS_GHCR_USERNAME"

  local required_command
  for required_command in chmod chown date docker find getent install jq mktemp \
    mv readlink rmdir stat; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      echo "AAIS GHCR preload dependency is unavailable: ${required_command}." >&2
      return 1
    fi
  done

  local candidate_receipt="${AAIS_CANDIDATE_RECEIPT_DIR}/${release_sha}.json"
  aais_require_protected_file "$candidate_receipt" 644 \
    "AAIS GHCR candidate receipt"
  local image_digest
  image_digest="$(jq -er '.imageDigest | select(test("^sha256:[a-f0-9]{64}$"))' \
    "$candidate_receipt")"
  aais_validate_ghcr_candidate_receipt "$candidate_receipt" "$release_sha" \
    "$AAIS_GHCR_REPOSITORY" "$image_digest" || {
      echo "AAIS GHCR candidate receipt does not match the requested release." >&2
      return 1
    }
  local candidate_run_id candidate_run_attempt
  candidate_run_id="$(jq -er '.githubRunId' "$candidate_receipt")"
  candidate_run_attempt="$(jq -er '.githubRunAttempt' "$candidate_receipt")"
  local image_ref="${AAIS_GHCR_REPOSITORY}@${image_digest}"

  aais_require_owner_tty
  install -d -o root -g root -m 0755 "$AAIS_PRELOADED_RECEIPT_DIR"
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

  local preloaded_receipt="${AAIS_PRELOADED_RECEIPT_DIR}/${release_sha}.json"
  if [[ -e "$preloaded_receipt" || -L "$preloaded_receipt" ]]; then
    aais_require_protected_file "$preloaded_receipt" 644 \
      "AAIS existing preloaded receipt"
  fi
  local receipt_candidate pulled_at
  receipt_candidate="$(mktemp \
    "${AAIS_PRELOADED_RECEIPT_DIR}/.preloaded-${release_sha}.XXXXXX")"
  pulled_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  jq -n \
    --arg gitSha "$release_sha" \
    --arg imageRepository "$AAIS_GHCR_REPOSITORY" \
    --arg imageDigest "$image_digest" \
    --arg localRepoDigest "$image_ref" \
    --arg imageRevision "$image_revision" \
    --arg candidateRunId "$candidate_run_id" \
    --arg candidateRunAttempt "$candidate_run_attempt" \
    --arg pulledAt "$pulled_at" '
      {
        schemaVersion: 1,
        provider: "github",
        stage: "ghcr_preloaded",
        gitSha: $gitSha,
        imageRepository: $imageRepository,
        imageDigest: $imageDigest,
        localRepoDigest: $localRepoDigest,
        imageRevision: $imageRevision,
        candidateRunId: $candidateRunId,
        candidateRunAttempt: $candidateRunAttempt,
        pulledAt: $pulledAt,
        credentialsCleaned: true,
        secrets: "redacted"
      }
    ' > "$receipt_candidate"
  chown root:root "$receipt_candidate"
  chmod 0644 "$receipt_candidate"
  mv -Tf -- "$receipt_candidate" "$preloaded_receipt"
  trap - EXIT INT TERM HUP
  printf 'AAIS GHCR image preloaded: %s %s\n' "$release_sha" "$image_digest"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  aais_preload_main "$@"
fi
