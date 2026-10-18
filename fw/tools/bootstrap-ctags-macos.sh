#!/usr/bin/env bash
# Build Arduino's prototype generator natively on Apple Silicon.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CTAGS_WORK="$ROOT_DIR/work/ctags-bootstrap"
mkdir -p "$CTAGS_WORK"
cd "$CTAGS_WORK"
curl -fL --max-time 120 https://github.com/arduino/ctags/releases/download/5.8-arduino11/ctags-5.8-arduino11.tar.xz -o ctags.tar.xz
printf '%s  ctags.tar.xz\n' '84e6bbe8a63c2d868c81bb274f78714157666833dc722f2ae2ab559a1adbd5c9e4c6661c6031bae55abe30cc021a972796d72d0c436dd9ffffaeaa7d0337a69e' | shasum -a 512 -c -
tar -xf ctags.tar.xz
cd ctags-5.8-arduino11
# The old macro collides with the current macOS SDK's attribute definition.
python3 - <<'PY'
from pathlib import Path
for path in Path('.').glob('*.[ch]'):
    path.write_bytes(path.read_bytes().replace(b'__unused__', b'CTAGS_UNUSED'))
PY
./configure --prefix="$ROOT_DIR/work/ctags-native"
make -j4
make install
