#!/usr/bin/env bash
set -Eeuo pipefail
# Build only a non-sensitive collector. This script is NOT an Owner launcher.
[[ $# -eq 0 && "$(/usr/bin/uname -s)" == Darwin ]] || { echo 'macOS build only; no arguments.' >&2; exit 1; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
source_digest="$(/usr/bin/shasum -a 256 native/launch-check/check.h native/launch-check/check.c native/launch-check/main.c scripts/build-aais-launch-check.sh | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
[[ "$source_digest" =~ ^[a-f0-9]{64}$ ]]
/bin/mkdir -p output/native-launch-check
build_dir="$(/usr/bin/mktemp -d "$repo_root/output/native-launch-check/build.XXXXXX")"
/bin/chmod 0700 "$build_dir"
binary="$build_dir/aais-launch-check"
/usr/bin/xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -fstack-protector-strong -D_FORTIFY_SOURCE=2 -I native/launch-check \
  "-DAAIS_SOURCE_DIGEST=\"$source_digest\"" \
  native/launch-check/check.c native/launch-check/main.c \
  -framework Security -framework CoreFoundation -o "$binary"
# Ad-hoc local integrity identifier, NOT an enrolled Owner/trusted signature.
/usr/bin/codesign --force --sign - --identifier org.aais.launch-check --options runtime "$binary"
/bin/chmod 0500 "$binary"
/usr/bin/codesign --verify --strict "$binary"
printf 'BINARY=%s\nSOURCE_DIGEST=%s\n' "$binary" "$source_digest"
/usr/bin/shasum -a 256 "$binary"
