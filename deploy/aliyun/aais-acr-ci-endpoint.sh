#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
aliyun_cli="${AAIS_ALIYUN_CLI:-aliyun}"
state_file="${AAIS_ACR_ENDPOINT_STATE_FILE:-}"
default_guard_cidr="127.0.0.1/32"

require_environment() {
  for name in \
    ACR_API_ENDPOINT \
    ACR_INSTANCE_ID \
    ACR_PUBLIC_LOGIN_SERVER
  do
    if [[ -z "${!name:-}" ]]; then
      echo "Missing required ACR endpoint binding: ${name}." >&2
      exit 1
    fi
  done
  if [[ "$action" == "open" || "$action" == "close" ]]; then
    if [[ -z "$state_file" ]]; then
      echo "Missing required ACR endpoint binding: AAIS_ACR_ENDPOINT_STATE_FILE." >&2
      exit 1
    fi
    if [[ -z "${RUNNER_TEMP:-}" || "$state_file" != "$RUNNER_TEMP"/aais-acr-endpoint-* ]]; then
      echo "ACR endpoint state must stay below the GitHub runner temporary directory." >&2
      exit 1
    fi
  fi
  if [[ ! "$ACR_API_ENDPOINT" =~ ^cr\.[a-z0-9-]+\.aliyuncs\.com$ \
    || ! "$ACR_INSTANCE_ID" =~ ^cri-[a-z0-9-]+$ \
    || ! "$ACR_PUBLIC_LOGIN_SERVER" =~ ^[a-z0-9][a-z0-9.-]*\.cr\.aliyuncs\.com$ ]]; then
    echo "ACR endpoint bindings are malformed." >&2
    exit 1
  fi
}

get_endpoint() {
  "$aliyun_cli" cr GetInstanceEndpoint \
    --endpoint "$ACR_API_ENDPOINT" \
    --InstanceId "$ACR_INSTANCE_ID" \
    --EndpointType internet \
    --ModuleName Registry
}

response_succeeded() {
  jq -e '.IsSuccess == true and .Code == "success"' >/dev/null
}

endpoint_matches_server() {
  local response="$1"
  jq -e --arg server "$ACR_PUBLIC_LOGIN_SERVER" \
    '.IsSuccess == true and ([.Domains[]?.Domain] | index($server) != null)' \
    <<<"$response" >/dev/null
}

validate_ipv4() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if not isinstance(address, ipaddress.IPv4Address) or not address.is_global:
    raise SystemExit(1)
PY
}

wait_for_open_endpoint() {
  local cidr="$1"
  local response
  for _ in $(seq 1 30); do
    response="$(get_endpoint)"
    if jq -e \
      --arg cidr "$cidr" \
      --arg defaultCidr "$default_guard_cidr" \
      --arg server "$ACR_PUBLIC_LOGIN_SERVER" '
      .IsSuccess == true
      and .Enable == true
      and .AclEnable == true
      and ([.Domains[]?.Domain] | index($server) != null)
      and ((.AclEntries // []) | length == 2)
      and ([.AclEntries[]?.Entry] | index($defaultCidr) != null)
      and ([.AclEntries[]?.Entry] | index($cidr) != null)
    ' <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "The temporary ACR public endpoint did not reach the guarded /32 state." >&2
  return 1
}

wait_for_default_guard_after_open() {
  local response
  for _ in $(seq 1 30); do
    response="$(get_endpoint)"
    if jq -e \
      --arg defaultCidr "$default_guard_cidr" \
      --arg server "$ACR_PUBLIC_LOGIN_SERVER" '
      .IsSuccess == true
      and .Enable == true
      and .AclEnable == true
      and ([.Domains[]?.Domain] | index($server) != null)
      and ((.AclEntries // []) | length == 1)
      and (.AclEntries[0].Entry == $defaultCidr)
    ' <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "ACR did not install its deny-all default guard after opening." >&2
  return 1
}

wait_for_closed_endpoint() {
  local cidr="$1"
  local response
  for _ in $(seq 1 30); do
    response="$(get_endpoint)"
    if jq -e \
      --arg cidr "$cidr" \
      --arg defaultCidr "$default_guard_cidr" \
      --arg server "$ACR_PUBLIC_LOGIN_SERVER" '
      .IsSuccess == true
      and .Enable == false
      and ([.Domains[]?.Domain] | index($server) != null)
      and ([.AclEntries[]? | select(.Entry == $cidr)] | length == 0)
      and ([.AclEntries[]? | select(.Entry != $defaultCidr)] | length == 0)
    ' <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "The ACR public endpoint could not be proven closed without the runner ACL." >&2
  return 1
}

disable_endpoint_exact() {
  local response
  for _ in $(seq 1 5); do
    response="$("$aliyun_cli" cr UpdateInstanceEndpointStatus \
      --endpoint "$ACR_API_ENDPOINT" \
      --InstanceId "$ACR_INSTANCE_ID" \
      --EndpointType internet \
      --Enable false \
      --ModuleName Registry 2>/dev/null || true)"
    if response_succeeded <<<"$response"; then
      response="$(get_endpoint)"
      if jq -e '.IsSuccess == true and .Enable == false' \
        <<<"$response" >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

recover_owned_cidr() {
  local response prefix cidr
  if [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ \
    || ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  prefix="aais-gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-"
  response="$(get_endpoint)"
  cidr="$(jq -er --arg prefix "$prefix" '
    [.AclEntries[]?
      | select(((.Comment // "") | tostring) | startswith($prefix))
      | .Entry]
    | if length == 1 then .[0] else empty end
  ' <<<"$response")" || return 1
  if [[ ! "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]]; then
    return 1
  fi
  validate_ipv4 "${cidr%/32}"
  printf '%s' "$cidr"
}

delete_runner_acl() {
  local cidr="$1"
  local response
  for _ in $(seq 1 5); do
    "$aliyun_cli" cr DeleteInstanceEndpointAclPolicy \
      --endpoint "$ACR_API_ENDPOINT" \
      --InstanceId "$ACR_INSTANCE_ID" \
      --EndpointType internet \
      --Entry "$cidr" \
      --ModuleName Registry >/dev/null 2>&1 || true
    response="$(get_endpoint)"
    if jq -e --arg cidr "$cidr" '
      .IsSuccess == true
      and .Enable == false
      and ([.AclEntries[]? | select(.Entry == $cidr)] | length == 0)
    ' <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

disable_after_lost_state() {
  local recovered_cidr=""
  if ! disable_endpoint_exact; then
    echo "Failed to disable ACR after losing transaction state." >&2
    return 1
  fi
  recovered_cidr="$(recover_owned_cidr || true)"
  if [[ -n "$recovered_cidr" ]]; then
    delete_runner_acl "$recovered_cidr" || true
  fi
  return 0
}

open_endpoint() {
  local before ip_first ip_second cidr comment candidate response expires_at

  if [[ -e "$state_file" ]]; then
    echo "Refusing to replace an existing ACR endpoint transaction state." >&2
    exit 1
  fi

  before="$(get_endpoint)"
  endpoint_matches_server "$before"
  if ! jq -e --arg defaultCidr "$default_guard_cidr" '
    .Enable == false
    and ([.AclEntries[]? | select(.Entry != $defaultCidr)] | length == 0)
  ' <<<"$before" >/dev/null; then
    echo "ACR public access must be explicitly disabled without a non-default ACL before this job." >&2
    exit 1
  fi

  ip_first="$(curl -4 --fail --silent --show-error --max-time 10 \
    --retry 2 https://api.ipify.org)"
  ip_second="$(curl -4 --fail --silent --show-error --max-time 10 \
    --retry 2 https://checkip.amazonaws.com | tr -d '[:space:]')"
  validate_ipv4 "$ip_first"
  validate_ipv4 "$ip_second"
  if [[ "$ip_first" != "$ip_second" ]]; then
    echo "Runner egress checks disagree; refusing to open ACR public access." >&2
    exit 1
  fi
  if [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ || ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
    echo "GitHub run identity is missing or malformed." >&2
    exit 1
  fi

  cidr="${ip_first}/32"
  expires_at="$(( $(date -u +%s) + 2700 ))"
  comment="aais-gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${expires_at}"
  candidate="${state_file}.candidate"
  umask 077
  printf 'CIDR=%s\nCOMMENT=%s\nEXPIRES_AT=%s\n' \
    "$cidr" "$comment" "$expires_at" > "$candidate"
  chmod 0600 "$candidate"
  mv -f -- "$candidate" "$state_file"

  response="$("$aliyun_cli" cr UpdateInstanceEndpointStatus \
    --endpoint "$ACR_API_ENDPOINT" \
    --InstanceId "$ACR_INSTANCE_ID" \
    --EndpointType internet \
    --Enable true \
    --ModuleName Registry)"
  response_succeeded <<<"$response"
  wait_for_default_guard_after_open

  response="$("$aliyun_cli" cr CreateInstanceEndpointAclPolicy \
    --endpoint "$ACR_API_ENDPOINT" \
    --InstanceId "$ACR_INSTANCE_ID" \
    --EndpointType internet \
    --Entry "$cidr" \
    --Comment "$comment" \
    --ModuleName Registry)"
  response_succeeded <<<"$response"
  wait_for_open_endpoint "$cidr"
}

close_endpoint() {
  local cidr comment expires_at

  if [[ ! -e "$state_file" ]]; then
    if [[ "${AAIS_ACR_REQUIRE_STATE_ON_CLOSE:-false}" == "true" ]]; then
      disable_after_lost_state || true
      echo "Expected ACR endpoint transaction state is missing." >&2
      return 1
    fi
    return 0
  fi
  if [[ -L "$state_file" || ! -f "$state_file" ]]; then
    disable_after_lost_state || true
    echo "ACR endpoint transaction state is not a regular file." >&2
    return 1
  fi
  cidr="$(sed -n 's/^CIDR=//p' "$state_file")"
  comment="$(sed -n 's/^COMMENT=//p' "$state_file")"
  expires_at="$(sed -n 's/^EXPIRES_AT=//p' "$state_file")"
  if [[ ! "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ \
    || ! "$expires_at" =~ ^[0-9]{10}$ \
    || "$comment" != "aais-gh-${GITHUB_RUN_ID:-}-${GITHUB_RUN_ATTEMPT:-}-${expires_at}" ]]; then
    disable_after_lost_state || true
    echo "ACR endpoint transaction state is malformed." >&2
    return 1
  fi
  validate_ipv4 "${cidr%/32}"

  if ! disable_endpoint_exact; then
    echo "Failed to disable the temporary ACR public endpoint." >&2
    return 1
  fi
  if ! delete_runner_acl "$cidr"; then
    echo "Failed to remove the runner ACL after ACR was disabled." >&2
    return 1
  fi
  wait_for_closed_endpoint "$cidr"
  rm -f -- "$state_file"
}

reconcile_completed_run() {
  local endpoint prefix owned_count other_run_count cidr guard_only now other_cidr other_safe
  local closed_observations=0 final_close_fence_sent=false
  if [[ ! "${AAIS_ACR_TARGET_RUN_ID:-}" =~ ^[0-9]+$ \
    || ! "${AAIS_ACR_TARGET_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
    echo "Completed-run reconciliation requires an exact GitHub run identity." >&2
    return 1
  fi
  prefix="aais-gh-${AAIS_ACR_TARGET_RUN_ID}-${AAIS_ACR_TARGET_RUN_ATTEMPT}-"
  now="$(date -u +%s)"
  owned_count=0
  for _ in $(seq 1 30); do
    endpoint="$(get_endpoint)"
    endpoint_matches_server "$endpoint"
    jq -e '.IsSuccess == true and (.Enable | type) == "boolean"' \
      <<<"$endpoint" >/dev/null
    owned_count="$(jq -r --arg prefix "$prefix" '
      [.AclEntries[]?
        | select(((.Comment // "") | tostring) | startswith($prefix))]
      | length
    ' <<<"$endpoint")"
    if [[ "$owned_count" == "1" ]]; then
      break
    fi
    if [[ "$owned_count" != "0" ]]; then
      disable_endpoint_exact || true
      echo "Completed-run reconciliation found ambiguous owned ACLs." >&2
      return 1
    fi
    if [[ "$(jq -r '.Enable' <<<"$endpoint")" == "false" ]]; then
      if [[ "$final_close_fence_sent" != "true" ]]; then
        if ! disable_endpoint_exact; then
          echo "Completed-run reconciliation could not install its final close fence." >&2
          return 1
        fi
        final_close_fence_sent=true
      fi
      closed_observations="$(( closed_observations + 1 ))"
      if (( closed_observations >= 5 )); then
        return 0
      fi
      sleep 2
      continue
    fi
    closed_observations=0
    other_run_count="$(jq -r --arg prefix "$prefix" '
      [.AclEntries[]?
        | select(((.Comment // "") | tostring)
          | test("^aais-gh-[0-9]+-[0-9]+-[0-9]{10}$"))
        | select((((.Comment // "") | tostring) | startswith($prefix)) | not)]
      | length
    ' <<<"$endpoint")"
    if (( other_run_count > 0 )); then
      other_cidr="$(jq -er \
        --arg prefix "$prefix" \
        --argjson now "$now" \
        --argjson latestAllowed "$(( now + 3300 ))" '
        [.AclEntries[]?
          | select(((.Comment // "") | tostring)
            | test("^aais-gh-[0-9]+-[0-9]+-[0-9]{10}$"))
          | select((((.Comment // "") | tostring) | startswith($prefix)) | not)
          | select((((.Comment // "") | tostring | split("-") | last) | tonumber) > $now)
          | select((((.Comment // "") | tostring | split("-") | last) | tonumber) <= $latestAllowed)
          | .Entry]
        | if length == 1 then .[0] else empty end
      ' <<<"$endpoint" || true)"
      other_safe="$(jq -r \
        --arg prefix "$prefix" \
        --arg defaultCidr "$default_guard_cidr" '
        .Enable == true
        and .AclEnable == true
        and ((.AclEntries // []) | length == 2)
        and ([.AclEntries[]? | select(.Entry == $defaultCidr)] | length == 1)
        and ([.AclEntries[]?
          | select(((.Comment // "") | tostring)
            | test("^aais-gh-[0-9]+-[0-9]+-[0-9]{10}$"))
          | select((((.Comment // "") | tostring) | startswith($prefix)) | not)]
          | length == 1)
      ' <<<"$endpoint")"
      if [[ "$other_run_count" == "1" && "$other_safe" == "true" ]] \
        && validate_ipv4 "${other_cidr%/32}" \
        && [[ "$other_cidr" == */32 ]]; then
        return 0
      fi
      disable_endpoint_exact || true
      echo "Completed-run reconciliation found an unsafe overlapping run ACL." >&2
      return 1
    fi
    guard_only="$(jq -r --arg defaultCidr "$default_guard_cidr" '
      .Enable == true
      and .AclEnable == true
      and ((.AclEntries // []) | length == 1)
      and (.AclEntries[0].Entry == $defaultCidr)
    ' <<<"$endpoint")"
    if [[ "$guard_only" != "true" ]]; then
      disable_endpoint_exact || true
      echo "Completed-run reconciliation found an unowned open endpoint." >&2
      return 1
    fi
    sleep 2
  done
  if [[ "$owned_count" == "0" ]]; then
    if ! disable_endpoint_exact; then
      echo "Completed-run reconciliation could not close a guard-only endpoint." >&2
      return 1
    fi
    endpoint="$(get_endpoint)"
    owned_count="$(jq -r --arg prefix "$prefix" '
      [.AclEntries[]?
        | select(((.Comment // "") | tostring) | startswith($prefix))]
      | length
    ' <<<"$endpoint")"
    if [[ "$owned_count" == "0" ]]; then
      return 0
    fi
    if [[ "$owned_count" != "1" ]]; then
      echo "Completed-run reconciliation found ambiguous late ACLs." >&2
      return 1
    fi
  fi
  cidr="$(jq -er --arg prefix "$prefix" '
    [.AclEntries[]?
      | select(((.Comment // "") | tostring) | startswith($prefix))
      | .Entry][0]
  ' <<<"$endpoint")"
  if [[ ! "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]]; then
    disable_endpoint_exact || true
    echo "Completed-run reconciliation found a malformed owned ACL." >&2
    return 1
  fi
  if ! validate_ipv4 "${cidr%/32}"; then
    disable_endpoint_exact || true
    echo "Completed-run reconciliation found a non-global owned ACL." >&2
    return 1
  fi
  if ! disable_endpoint_exact; then
    echo "Completed-run reconciliation could not disable ACR." >&2
    return 1
  fi
  if ! delete_runner_acl "$cidr" || ! wait_for_closed_endpoint "$cidr"; then
    echo "Completed-run reconciliation could not prove ACL cleanup." >&2
    return 1
  fi
}

require_environment
case "$action" in
  open)
    open_endpoint
    ;;
  close)
    close_endpoint
    ;;
  reconcile)
    reconcile_completed_run
    ;;
  *)
    echo "Usage: $0 open|close|reconcile" >&2
    exit 64
    ;;
esac
