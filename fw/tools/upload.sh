#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ARDUINO_BIN="${ARDUINO_CLI:-$HOME/.local/bin/arduino-cli}"
STAGE="${FW_STAGE:-6}"
case "$STAGE" in 2|3|6) ;; *) echo 'FW_STAGE must be 2, 3 or 6' >&2; exit 2;; esac
BUILD_DIR="${FW_BUILD_DIR:-$ROOT_DIR/work/build-stage$STAGE}"
PORT="${FW_PORT:-/dev/cu.usbmodem1101}"
FW_STAGE="$STAGE" bash "$ROOT_DIR/fw/tools/build.sh"
"$ARDUINO_BIN" upload --fqbn esp32:esp32:m5stack_cores3:PSRAM=enabled \
  --port "$PORT" --input-dir "$BUILD_DIR" "$ROOT_DIR/fw"
"$ARDUINO_BIN" monitor --port "$PORT" --config baudrate=115200
