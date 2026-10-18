#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ARDUINO_BIN="${ARDUINO_CLI:-$HOME/.local/bin/arduino-cli}"
BUILD_DIR="${FW_BUILD_DIR:-$ROOT_DIR/work/build-stage2}"
extra=()
if [[ -x "$ROOT_DIR/work/ctags-native/bin/ctags" ]]; then
  extra+=(--build-property "runtime.tools.ctags.path=$ROOT_DIR/work/ctags-native/bin")
fi
"$ARDUINO_BIN" compile --fqbn esp32:esp32:m5stack_cores3:PSRAM=enabled \
  --library "$ROOT_DIR/fw/vendor/M5StackChan" \
  --build-path "$BUILD_DIR" "${extra[@]}" "$ROOT_DIR/fw"
