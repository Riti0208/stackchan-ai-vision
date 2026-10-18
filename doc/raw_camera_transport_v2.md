# StackChan raw camera frame transport spec

Status: proposal for coordinated firmware and backend implementation

## Goal

Move RGB565-to-JPEG encoding from CoreS3 to the backend. The firmware sends the
camera framebuffer bytes without JPEG encoding. “Raw” here means uncompressed
RGB565 pixels after camera capture, not the sensor's Bayer/raw-color data. The
backend validates and encodes each frame as JPEG before passing it to the
existing viewer and AI pipeline.

This removes JPEG encoding work from the ESP32, but raw frames are larger than
JPEG. It does not guarantee higher upload FPS. Benchmark network transfer and
backend encoding before making 60 FPS a performance claim.

## Transport format

Use the existing authenticated device WSS connection and binary WebSocket
messages. Replace the device-to-backend JPEG packet with this raw packet:

```text
Offset  Size  Field
0       4     Magic ASCII "SCFW"
4       1     Version, exactly 2
5       1     Pixel format, 1 = RGB565 little-endian
6       2     Width, uint16 big-endian
8       2     Height, uint16 big-endian
10      4     Frame ID, uint32 big-endian
14      2     Reserved flags, zero in version 2
16      rest  Packed pixels, row-major RGB565LE; no row padding
```

For RGB565LE, each pixel is a 16-bit RGB565 value with the low byte first. The
payload length must equal `width * height * 2`; trailing bytes are invalid.
Version 2 accepts only 160x120 initially, with 320x240 allowed as a bounded
future option. Do not accept arbitrary dimensions. Frame IDs increment for
each captured frame sent and wrap as uint32.

### Session version

Bump the device session protocol to version 2. The backend sends the frame
format and dimensions in the existing `session` message:

```json
{"type":"session","timestamp":0,"data":{"protocol_version":2,"role":"device","room":"main","device_id":"stackchan-01","frame_format":"rgb565le-v2","width":160,"height":120}}
```

The firmware sends frames only after it has accepted protocol version 2 and
the expected raw format. Do not retain the old device-upload JPEG packet or
silently fall back to it. An old firmware that expects protocol version 1
must fail the session safely and remain offline until reflashed.

## Backend requirements

1. Accept only the raw v2 packet from device binary messages. Reject bad
   magic, version/format/flags, dimensions outside
   the allowlist, and payload lengths that do not exactly match the header.
2. Authenticate and apply room/device authorization before processing frames.
   Keep frame-ID, connection-generation, size, and stale-frame checks. Bound
   conversion concurrency and memory; discard superseded frames rather than
   building a queue.
3. Convert RGB565LE v2 to JPEG with a Cloudflare Workers-compatible encoder.
   Keep conversion server-side. If the selected encoder cannot run within the
   Worker CPU, memory, or bundle limits, stop and report that constraint before
   choosing a different service or moving conversion back to the device.
4. Normalize the result to the existing internal frame shape: original frame
   ID and receive time plus JPEG bytes. JPEG remains a backend-produced
   internal/output format for the current viewer and Decisions API input
   (`data:image/jpeg;base64,...`); it is no longer accepted as device upload.
   Do not expose the raw payload to viewers or the AI request.
5. Preserve `frame_received`, frame acknowledgements, action ordering, and
   telemetry semantics. Record the input format and conversion duration in
   bounded metrics; never log frame bytes, bearer tokens, or image contents.

## Firmware requirements

- Configure the camera for 160x120 RGB565 where the GC0308 driver supports
  that mode. Send the camera framebuffer as RGB565 v2 without calling
  `frame2jpg` or resizing it in firmware.
- Continue using PSRAM-backed frame slots and latest-frame-wins behavior. Do
  not block capture waiting for an older frame to send. Use the existing WSS
  generation and stale-frame protections.
- Keep the display face behavior independent of frame encoding. Camera preview
  may display the low-resolution capture scaled to the display; it must not
  force an image conversion for network transmission.
- If camera mode, memory allocation, or protocol version 2 is unavailable,
  do not send a frame. Log the selected format, dimensions, target FPS, and
  failure reason without logging secrets.

## Rollout

1. Backend: implement protocol v2 raw validation/conversion and reject old
   device JPEG upload packets. Test conversion and rejection paths before
   deployment.
2. Firmware: require protocol version 2 and send raw RGB565 only.
3. Deploy backend and flash firmware as one coordinated change. Between deploy
   and flash, old devices remain offline by design. Confirm protocol v2,
   backend raw reception, viewer JPEG, and Decisions API JPEG input.
4. Compare upload FPS, bytes/frame, transfer time, conversion time, dropped
   frames, memory, and CPU duration at 160x120. Keep the raw mode only if the
   measured end-to-end result improves without unbounded queues or frame loss.

## Acceptance checks

- Valid QQVGA RGB565 v2 frame becomes a decodable 160x120 JPEG with the same
  frame ID.
- JPEG v1 device upload packets are rejected; the backend and firmware both
  require protocol version 2.
- Invalid magic, version, format, dimensions, flags, truncated payload, and
  extra payload bytes are rejected without crashing or retaining the payload.
- Viewer binary output remains `[frame_id][JPEG]`; Decisions input remains a
  JPEG data URL.
- Under sustained load, memory stays bounded and stale frames are dropped.
- Metrics let us compare raw transfer and backend conversion costs against the
  current firmware-JPEG path.
