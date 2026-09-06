#!/usr/bin/env bash
set -Eeuo pipefail
# Disposable Linux permission test, never applied to the live /run/aais tree.
[[ "$EUID" -eq 0 ]] || { echo 'Requires root in an isolated Linux test runner.' >&2; exit 1; }
for required in systemd-tmpfiles runuser getfacl; do command -v "$required" >/dev/null; done
getent passwd nobody >/dev/null
test_root="$(mktemp -d /tmp/aais-socket-test.XXXXXX)"
trap '[[ "$test_root" == /tmp/aais-socket-test.* ]] && rm -rf -- "$test_root"' EXIT
chmod 0755 "$test_root"
for boot in 1 2; do
  boot_root="$test_root/boot-$boot"
  mkdir -m 0755 "$boot_root"
  # Map only fixture paths/identities; exercise the checked-in tmpfiles rules.
  sed -e "s|/run/aais|$boot_root/aais|g" \
    -e 's/aais-worker/root/g' -e 's/aais-runtime/nogroup/g' \
    -e 's/ postgres / nobody /g' -e 's/u:postgres:/u:nobody:/g' \
    deploy/aliyun/aais-postgresql-socket.tmpfiles > "$boot_root/rules.conf"
  systemd-tmpfiles --create "$boot_root/rules.conf"
  runuser -u nobody -- test -x "$boot_root/aais/postgresql"
  # Bootstrap reruns install -d on the parent: the traverse-only ACL must survive.
  install -d -o root -g root -m 0750 "$boot_root/aais" "$boot_root/aais/generations"
  runuser -u nobody -- test -x "$boot_root/aais/postgresql"
  if runuser -u nobody -- test -r "$boot_root/aais/generations"; then
    echo 'PostgreSQL identity can read secret generations.' >&2; exit 1
  fi
  getfacl -cp "$boot_root/aais" | grep -qx 'user:nobody:--x'
done
echo 'AAIS_SOCKET_COLD_START=PASS (two fresh trees; no production restart)'
