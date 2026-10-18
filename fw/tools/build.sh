#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ARDUINO_BIN="${ARDUINO_CLI:-$HOME/.local/bin/arduino-cli}"
STAGE="${FW_STAGE:-6}"
case "$STAGE" in 2|3|6) ;; *) echo 'FW_STAGE must be 2, 3 or 6' >&2; exit 2;; esac
BUILD_DIR="${FW_BUILD_DIR:-$ROOT_DIR/work/build-stage$STAGE}"
extra=()
if [[ -x "$ROOT_DIR/work/ctags-native/bin/ctags" ]]; then
  extra+=(--build-property "runtime.tools.ctags.path=$ROOT_DIR/work/ctags-native/bin")
fi
"$ARDUINO_BIN" compile --fqbn esp32:esp32:m5stack_cores3:PSRAM=enabled \
  --library "$ROOT_DIR/fw/vendor/M5StackChan" \
  --build-property "compiler.cpp.extra_flags=-DFW_STAGE=$STAGE" \
  --build-path "$BUILD_DIR" "${extra[@]}" "$ROOT_DIR/fw"
