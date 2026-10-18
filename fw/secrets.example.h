#pragma once
// Copy to secrets.h and edit locally. Never commit secrets.h.
constexpr char WIFI_SSID[] = ""; // 2.4GHz hotspot SSID
constexpr char WIFI_PASSWORD[] = "";
// Stage 3: use device_id and the per-device Bearer token required by back/.
constexpr char DEVICE_SERVER_URL[] = "wss://<DOMAIN>/ws/device?room=main&device_id=stackchan-01";
constexpr char DEVICE_TOKEN[] = "";
// OpenAI API keys belong only to the backend, not to this firmware.
