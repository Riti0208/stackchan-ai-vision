#pragma once
// Copy to secrets.h and edit locally. Never commit secrets.h.
constexpr char WIFI_SSID[] = ""; // 2.4GHz hotspot SSID
constexpr char WIFI_PASSWORD[] = "";
// Use the published device endpoint and a per-device Bearer token from back/.
constexpr char DEVICE_SERVER_URL[] = "wss://stackchan-ai-vision.k-i-wrd-setuna-g.workers.dev/ws/device?room=main&device_id=stackchan-01";
constexpr char DEVICE_TOKEN[] = "";
// OpenAI API keys belong only to the backend, not to this firmware.
