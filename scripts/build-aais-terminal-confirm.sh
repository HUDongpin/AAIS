#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 0 && "$(/usr/bin/uname -s)" == Darwin ]] || exit 1
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
/bin/mkdir -p output/native-terminal-confirm
build_dir="$(/usr/bin/mktemp -d "$repo_root/output/native-terminal-confirm/build.XXXXXX")"
/bin/chmod 0700 "$build_dir"
source_digest="$(/usr/bin/shasum -a 256 native/terminal-confirm/core.h native/terminal-confirm/core.c native/terminal-confirm/main.c native/launch-check/check.h native/launch-check/check.c native/launch-check/main.c scripts/build-aais-terminal-confirm.sh | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
/usr/bin/xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -fstack-protector-strong -D_FORTIFY_SOURCE=2 "-DAAIS_SOURCE_DIGEST=\"$source_digest\"" \
  native/terminal-confirm/core.c native/terminal-confirm/main.c native/launch-check/check.c \
  -framework Security -framework CoreFoundation -o "$build_dir/aais-terminal-confirm"
/usr/bin/codesign --force --sign - --identifier org.aais.terminal-confirm --options runtime "$build_dir/aais-terminal-confirm"
/bin/chmod 0500 "$build_dir/aais-terminal-confirm"
/usr/bin/codesign --verify --strict "$build_dir/aais-terminal-confirm"
printf 'BINARY=%s\nSOURCE_DIGEST=%s\n' "$build_dir/aais-terminal-confirm" "$source_digest"
/usr/bin/shasum -a 256 "$build_dir/aais-terminal-confirm"
