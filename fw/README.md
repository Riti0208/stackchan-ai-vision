# StackChan CoreS3 firmware

Current stage: **2**, pending device verification. Stage 1 passed on hardware: camera init 0x0, 8MB PSRAM, 14–20fps, stable memory, L/R/U/D/C verified by operator. Occasional FB-OVF recovered without a reset; monitor recurrence with Wi-Fi enabled. WSS is gated until stage 2 passes.

- `fw.ino`: GC0308 QVGA RGB565 preview, two PSRAM buffers, serial L/R/U/D/C, nonblocking Wi-Fi reconnect every 10 seconds. SSID/password are never logged. Wi-Fi loss centers the head.
- Pan: -30..30 degrees (negative left). Tilt: -15..15 degrees about
  official pitch 45 degrees (negative down). Motion speed is capped at 200/1000.
- `secrets.h`: ignored by Git. Copy `secrets.example.h` and set your 2.4GHz SSID/password. WSS URL/device token are for stage 3. OpenAI API keys stay in `back/`.
- `vendor/M5StackChan`: official Arduino library 1.0.1, MIT; PY32 expander
  derives directly from `I2C_Device` rather than `IOExpander_Base` and removes
  `override` annotations. Its existing register operations are retained. This
  avoids the incompatible new pure-virtual API in M5Unified 0.2.26.

Setup from repository root:

```sh
~/.local/bin/arduino-cli lib install "M5Unified@0.2.26" "M5GFX@0.2.33"
cp fw/secrets.example.h fw/secrets.h # Only on first setup; preserve existing credentials.
```

Edit `fw/secrets.h`. Then build from repository root:

```sh
bash fw/tools/build.sh
~/.local/bin/arduino-cli upload --fqbn esp32:esp32:m5stack_cores3:PSRAM=enabled --port /dev/cu.usbmodem1101 --input-dir "$PWD/work/build-stage2" fw
~/.local/bin/arduino-cli monitor --port /dev/cu.usbmodem1101 --config baudrate=115200
```

On Apple Silicon without Rosetta, Arduino's bundled Intel ctags may fail with
`bad CPU type in executable`. Run `bash fw/tools/bootstrap-ctags-macos.sh` once
(requires Xcode Command Line Tools, curl and Python 3). It verifies and builds
Arduino ctags 5.8-arduino11 under ignored `work/`; `build.sh` detects it automatically.
Its legacy `__unused__` macro is renamed to `CTAGS_UNUSED` for current macOS SDKs.
The vendored library is selected explicitly, so another installed M5StackChan
library does not override the compatibility fix.

Stage 1 acceptance: camera init succeeds, PSRAM exists, continuous frames/fps
appear without reboot; visible camera preview is correct; L/R/U/D/C move in the
expected directions and C centers. Serial command acknowledgments alone do not
prove physical movement or screen image quality.

References:
- https://docs.m5stack.com/ja/arduino/stackchan/camera
- https://docs.m5stack.com/en/arduino/stackchan/servo

Stage 2 acceptance: WIFI connected with an IP, STAGE2 wifi=online;
turn iPhone hotspot off for at least 30 seconds and observe WIFI disconnected
and WIFI retry; enable hotspot again (keep its settings screen open) and observe
a second WIFI connected with connections=2 or higher. Camera and serial neck
controls must remain responsive. No reboot or sustained heap loss.

## Integration with existing backend (stages 3–6, not yet implemented)

See [communication protocol](../doc/communication_protocol_v1.md) and
[backend setup](../back/README.md). Use
`wss://<DOMAIN>/ws/device?room=main&device_id=stackchan-01` and
`Authorization: Bearer <DEVICE_TOKEN>` during the WS upgrade. Reset the last
accepted action seq on each successful new connection: backend seq starts at 1
per connection. Frames stay `[uint32 big-endian frame_id][JPEG]`.

The existing backend already calls OpenAI Decisions (`POST /v1/decisions`,
`gpt-6-luna`) for image observations and intent selection. Its Responses API
adapter generates narration separately. Firmware sends images and executes
validated bounded `action` messages; it does not need its own OpenAI client or key.
Backend live API mode requires explicit paid-session setup; default demos use mocks.

Do not advance the firmware stage until compile → flash → 115200 serial checks
pass. Stage 2 compile passed (ESP32 core 3.3.12, flash 1,149,007 bytes, static RAM
59,804 bytes); device Wi-Fi/reconnect verification is pending. Stage 1 was
confirmed on hardware by the operator. No WSS/JPEG/status/action claims are made
for the current stage-2 binary.

## Stage 2 connection diagnostics

If the serial monitor repeats `status=1` (`WL_NO_SSID_AVAIL`), the configured
SSID was not found; `status=6` means disconnected. Neither alone identifies the
cause. The diagnostic firmware scans asynchronously at boot and after every
three failed 10-second retries. Scanning temporarily pauses connection attempts,
while camera preview and neck controls continue. Results are deleted after use;
a scan is bounded to 15 seconds. `W` requests a scan while offline; it does not
disconnect a working connection.

- `WIFI scan visible=N target=found`: exact configured SSID is visible on 2.4GHz.
  RSSI, channel and the ESP32 authentication enum are reported on the next line.
- `target=not_found similar_name=yes`: a name differs in ASCII case, outer spaces,
  typographic apostrophes or nonbreaking spaces. Match the iPhone name exactly.
  Normalization is for diagnostics only; connection always uses the original SSID.
- `target=not_found similar_name=no`: check hotspot visibility, exact SSID and
  iPhone compatibility mode. Visible=0 means this scan found no networks.
- `WIFI reason=201 (ssid_not_found)`: no configured AP found.
- `reason=202 (authentication_failed)` / `204 (handshake_timeout)`: authentication
  or handshake failed; check password and security settings, rather than assuming
  either code proves a wrong password.

Event callbacks update only an atomic reason code; the main loop logs it.
SSID names, BSSIDs and passwords are not printed. After flashing, keep the iPhone
hotspot settings screen open and capture `WIFI scan`, `WIFI target`, `WIFI reason`
and `WIFI connected` lines. Connection and hotspot off/on recovery still need
hardware verification before stage 3.
