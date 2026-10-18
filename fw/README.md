# StackChan CoreS3 firmware

The full firmware sends raw RGB565LE camera frames to the StackChan backend over authenticated
WSS. The backend converts each frame to JPEG for the existing viewer and OpenAI Decisions API image observations and action
selection; the ESP32 does not contain an OpenAI API key. It receives validated
actions, moves the neck within small limits, and draws the selected expression.

## What the firmware does

- Captures the GC0308 camera at QQVGA 160x120 RGB565 and sends the framebuffer
  without JPEG encoding using the `SCFW` v2 raw-frame packet and 32-bit
  big-endian frame ID.
- Upload FPS depends on capture, the 38,400-byte raw transfer, and Wi-Fi; the
  serial `upload_fps` field reports the measured rate.
- Keeps only the newest unsent frame. Frames older than one second or from an
  earlier connection are discarded. The target is capped at 60 fps; actual
  delivery may be lower when the camera or network cannot keep up.
- Sends `device_status` every five seconds with measured upload FPS, Wi-Fi RSSI,
  and current action. Battery is `null` because the camera owns the shared I2C bus.
- Accepts newer action sequence numbers only. Pan is limited to ±30 degrees,
  tilt to ±15 degrees around neutral; tracking and gestures use a faster,
  responsive movement curve while staying inside those limits.
  Gestures finish before the head returns to the latest tracking target.
- Draws neutral/happy/sad/surprised/thinking faces. Press `V` in the serial
  monitor to toggle the camera preview; the default screen shows the face.
- Returns to neutral and centers the head when Wi-Fi or WSS is lost.

## Local configuration

Install the libraries if needed and create `secrets.h` only if it does not exist:

```sh
~/.local/bin/arduino-cli lib install "M5Unified@0.2.26" "M5GFX@0.2.33" "WebSockets@2.7.2" "ArduinoJson@7.4.3"
cp fw/secrets.example.h fw/secrets.h
```

Keep any existing `WIFI_SSID` and `WIFI_PASSWORD` values. Set these local values
when the service owner gives them to you:

- `DEVICE_SERVER_URL`: `wss://stackchan-ai-vision.k-i-wrd-setuna-g.workers.dev/ws/device?room=main&device_id=stackchan-01`
- `DEVICE_TOKEN`: device token for the same room and device

`secrets.h` is ignored by Git. Never add an OpenAI key to it. The WSS client
checks TLS certificates against the ESP-IDF root CA bundle and sends the device
token as a Bearer authorization header. Missing configuration leaves camera and
Wi-Fi running while WSS stays disabled.

## Build, flash, and monitor

From the repository root:

```sh
bash fw/tools/build.sh
bash fw/tools/upload.sh
```

The full flow (FW_STAGE=6) is the default. Upload uses `/dev/cu.usbmodem1101`
and opens the serial monitor at 115200 baud. Close an existing serial monitor
with Ctrl+C before flashing. `FW_PORT` can override the port. `FW_STAGE=2` and
`FW_STAGE=3` remain available for Wi-Fi or transport diagnosis.

Serial controls: `L/R/U/D/C` move left/right/up/down/center, `V` toggles preview,
`X` reconnects WSS, and `W` scans Wi-Fi when disconnected. Send the letter and
press Return in the serial monitor.

## Backend behavior

The WSS endpoint must send a protocol-version-2 device session declaring
`rgb565le-v2`, 160x120. Viewer/controller sessions remain protocol version 1.
The firmware sends status after session setup and every five seconds. Uploads
use a 16-byte `SCFW` header followed by 160x120 RGB565LE pixels; the backend
validates and converts the frame to JPEG before forwarding it to viewers or AI.
The firmware validates action fields/ranges before queueing them. `action_ack` means the action was accepted
for scheduling, not that the physical movement has completed.

The existing backend uses OpenAI Decisions API (`gpt-6-luna`) for image
observations and intent selection, and Responses separately for narration.
Default backend demos use mocks; a live API session follows the backend's
existing paid-session setup. The firmware does not enable or configure billing.

## Build notes

On Apple Silicon without Rosetta, Arduino's bundled Intel ctags may fail with
`bad CPU type in executable`. Run `bash fw/tools/bootstrap-ctags-macos.sh` once
if needed; it verifies and builds Arduino ctags under ignored `work/`.

The vendored `M5StackChan` 1.0.1 library includes the M5Unified 0.2.26 I2C API
compatibility adjustment and the firmware's neck-angle clamps. The build script
selects it explicitly.

Host checks:

```sh
c++ -std=c++17 -Wall -Wextra -Werror fw/tests/wss_config_test.cpp -o work/wss-config-test
work/wss-config-test
c++ -std=c++17 -Wall -Wextra -Werror fw/tests/behavior_test.cpp -o work/behavior-test
work/behavior-test
```

Hardware references:
- https://docs.m5stack.com/ja/arduino/stackchan/camera
- https://docs.m5stack.com/en/arduino/stackchan/servo
