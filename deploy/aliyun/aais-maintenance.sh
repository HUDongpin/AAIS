#!/usr/bin/env bash
set -Eeuo pipefail

maintenance_flag="/opt/aais/state/maintenance.enabled"
action="${1:-status}"

case "$action" in
  enable)
    install -d -o root -g root -m 0755 "$(dirname "$maintenance_flag")"
    install -o root -g root -m 0644 /dev/null "$maintenance_flag"
    echo "AAIS maintenance write freeze enabled."
    ;;
  disable)
    rm -f -- "$maintenance_flag"
    echo "AAIS maintenance write freeze disabled."
    ;;
  status)
    if [[ -f "$maintenance_flag" ]]; then
      echo "enabled"
      exit 0
    fi
    echo "disabled"
    exit 1
    ;;
  *)
    echo "Usage: aais-maintenance.sh enable|disable|status" >&2
    exit 2
    ;;
esac
