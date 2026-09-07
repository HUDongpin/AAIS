#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 0 && "$(/usr/bin/uname -s)" == Darwin ]] || exit 1
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
/bin/mkdir -p output/native-confirmation-check
build_dir="$(/usr/bin/mktemp -d "$repo_root/output/native-confirmation-check/build.XXXXXX")"
/bin/chmod 0700 "$build_dir"
source_digest="$(/usr/bin/shasum -a 256 native/confirmation-check/*.swift native/confirmation-check/origin.c native/confirmation-check/origin.h native/launch-check/check.c native/launch-check/check.h native/launch-check/main.c scripts/build-aais-confirmation-check.sh | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
/usr/bin/xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -fstack-protector-strong "-DAAIS_SOURCE_DIGEST=\"$source_digest\"" -c native/confirmation-check/origin.c -o "$build_dir/origin.o"
/usr/bin/xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -c native/launch-check/check.c -o "$build_dir/check.o"
/usr/bin/xcrun swiftc -swift-version 5 -O -import-objc-header native/confirmation-check/origin.h \
  native/confirmation-check/ConfirmationCore.swift native/confirmation-check/main.swift \
  "$build_dir/origin.o" "$build_dir/check.o" -framework Security -framework LocalAuthentication \
  -o "$build_dir/aais-confirmation-check"
/usr/bin/codesign --force --sign - --identifier org.aais.confirmation-check --options runtime "$build_dir/aais-confirmation-check"
/bin/chmod 0500 "$build_dir/aais-confirmation-check"
/usr/bin/codesign --verify --strict "$build_dir/aais-confirmation-check"
printf 'BINARY=%s\nSOURCE_DIGEST=%s\n' "$build_dir/aais-confirmation-check" "$source_digest"
/usr/bin/shasum -a 256 "$build_dir/aais-confirmation-check"
