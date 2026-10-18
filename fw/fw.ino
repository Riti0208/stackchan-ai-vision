#include <M5StackChan.h>
#include <esp_camera.h>
#include <esp_heap_caps.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <atomic>
#include "secrets.h"
#include "src/WssTransport.h"
#if FW_STAGE >= 6
#include "src/Behavior.h"
#include "src/Face.h"
#include "src/Vision.h"
#endif

// Stage 2 was verified on hardware; stage 3 adds the authenticated WSS transport.
constexpr int PAN_LIMIT = 300;    // 0.1 degree units
constexpr int TILT_CENTER = 450;
constexpr int TILT_LIMIT = 150;
constexpr int SERVO_SPEED = 350; // Official Motion scale: 0..1000
bool cameraReady = false;
uint32_t frames = 0;
uint32_t reportAt = 0;
int pan = 0, tilt = 0;
constexpr uint32_t WIFI_RETRY_MS = 10000;
uint32_t wifiAttemptAt = 0;
bool wifiWasConnected = false;
bool wifiConfigured = false;
uint32_t wifiConnections = 0;
bool wifiScanActive = false;
uint32_t wifiScanAt = 0;
uint8_t wifiRetriesSinceScan = 0;
std::atomic<int> wifiDisconnectReason{-1};
#if FW_STAGE >= 6
stackchan_fw::Behavior behavior;
bool cameraPreview = false;
uint32_t behaviorAt = 0, servoAt = 0, faceAt = 0, metricsAt = 0;
#endif

const char* wifiReasonName(int reason) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND: return "ssid_not_found";
    case WIFI_REASON_AUTH_FAIL: return "authentication_failed";
    case WIFI_REASON_HANDSHAKE_TIMEOUT: return "handshake_timeout";
    case WIFI_REASON_BEACON_TIMEOUT: return "beacon_timeout";
    case WIFI_REASON_ASSOC_FAIL: return "association_failed";
    case WIFI_REASON_ASSOC_LEAVE: return "local_disconnect";
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "security_incompatible";
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD: return "security_below_minimum";
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD: return "signal_below_minimum";
    default: return "other";
  }
}

String comparableSSID(String name) {
  name.trim();
  name.toLowerCase();
  name.replace("\xe2\x80\x99", "'"); // Typographic apostrophe in iPhone names.
  name.replace("\xe2\x80\x98", "'");
  name.replace("\xc2\xa0", " "); // Nonbreaking space.
  return name;
}

void beginWiFiAttempt() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttemptAt = millis();
  Serial.println("WIFI connecting (2.4GHz), retry interval=10000ms");
}

void beginWiFiScan() {
  if (!wifiConfigured || wifiScanActive) return;
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WIFI scan skipped: already connected");
    return;
  }
  // Pause association while scanning; the main loop keeps servicing the camera.
  WiFi.disconnect(false, false);
  WiFi.scanDelete();
  wifiScanAt = millis();
  wifiRetriesSinceScan = 0;
  int16_t result = WiFi.scanNetworks(true, true, false, 200);
  if (result == WIFI_SCAN_FAILED) {
    Serial.println("WIFI scan start failed; resuming connection");
    beginWiFiAttempt();
    return;
  }
  wifiScanActive = true;
  Serial.println("WIFI scan started; network names and credentials are not logged");
}

void serviceWiFiScan(uint32_t now) {
  int16_t count = WiFi.scanComplete();
  if (count == WIFI_SCAN_RUNNING && now - wifiScanAt < 15000) return;
  if (count == WIFI_SCAN_RUNNING) {
    esp_wifi_scan_stop();
    Serial.println("WIFI scan timed out; resuming connection");
  } else if (count < 0) {
    Serial.println("WIFI scan failed; resuming connection");
  } else {
    int best = -1;
    bool similar = false;
    String target = comparableSSID(String(WIFI_SSID));
    for (int i = 0; i < count; ++i) {
      String name = WiFi.SSID(i);
      if (name == WIFI_SSID) {
        if (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best)) best = i;
      } else if (comparableSSID(name) == target) {
        similar = true;
      }
    }
    Serial.printf("WIFI scan visible=%d target=%s similar_name=%s\n", count,
                  best >= 0 ? "found" : "not_found", similar ? "yes" : "no");
    if (best >= 0) {
      Serial.printf("WIFI target rssi=%d channel=%d auth=%d\n",
                    WiFi.RSSI(best), WiFi.channel(best),
                    static_cast<int>(WiFi.encryptionType(best)));
    } else {
      Serial.println("WIFI CHECK: exact iPhone name / hotspot enabled / compatibility enabled");
    }
  }
  WiFi.scanDelete();
  wifiScanActive = false;
  beginWiFiAttempt();
}

void startWiFi() {
  wifiConfigured = WIFI_SSID[0] != '\0';
  if (!wifiConfigured) {
    Serial.println("WIFI configuration missing: edit secrets.h");
    return;
  }
  WiFi.persistent(false); // Keep credentials out of Wi-Fi NVS storage.
  // The event callback runs on another task; only touch an atomic here.
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    wifiDisconnectReason.store(info.wifi_sta_disconnected.reason);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.setHostname("stackchan");
  if (!WiFi.mode(WIFI_STA)) {
    Serial.println("WIFI STA initialization failed; reboot to retry");
    wifiConfigured = false;
    return;
  }
  // One retry scheduler, rather than overlapping automatic connection attempts.
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(false);
  beginWiFiScan();
}

void serviceWiFi(uint32_t now) {
  if (!wifiConfigured) return;
  int reason = wifiDisconnectReason.exchange(-1);
  if (reason >= 0) {
    Serial.printf("WIFI reason=%d (%s)\n", reason, wifiReasonName(reason));
  }
  if (wifiScanActive) {
    serviceWiFiScan(now);
    return;
  }
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wifiWasConnected) {
    ++wifiConnections;
    wifiRetriesSinceScan = 0;
    Serial.printf("WIFI connected ip=%s rssi=%d connections=%u\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(), wifiConnections);
  } else if (!connected && wifiWasConnected) {
    Serial.println("WIFI disconnected; centering, will reconnect in 10s");
#if FW_STAGE >= 6
    behavior.idle(now);
#else
    moveHead(0, 0);
#endif
    wifiAttemptAt = now;
  }
  wifiWasConnected = connected;
  if (!connected && now - wifiAttemptAt >= WIFI_RETRY_MS) {
    wifiAttemptAt = now;
    Serial.printf("WIFI retry status=%d\n", static_cast<int>(WiFi.status()));
    if (++wifiRetriesSinceScan >= 3) {
      beginWiFiScan();
      return;
    }
    WiFi.disconnect(false, false);
    beginWiFiAttempt();
  }
}

void moveHead(int requestedPan, int requestedTilt) {
  pan = constrain(requestedPan, -PAN_LIMIT, PAN_LIMIT);
  tilt = constrain(requestedTilt, -TILT_LIMIT, TILT_LIMIT);
  // Application: negative pan is left; official servo: positive yaw is left.
  M5StackChan.Motion.move(-pan, TILT_CENTER + tilt, SERVO_SPEED);
  Serial.printf("HEAD pan=%.1f tilt=%.1f yaw=%d pitch=%d speed=%d\n",
                pan / 10.0, tilt / 10.0, -pan, TILT_CENTER + tilt, SERVO_SPEED);
}

bool startCamera() {
  camera_config_t c = {};
  c.pin_pwdn = -1; c.pin_reset = -1; c.pin_xclk = -1;
  c.pin_sccb_sda = 12; c.pin_sccb_scl = 11;
  c.pin_d7 = 47; c.pin_d6 = 48; c.pin_d5 = 16; c.pin_d4 = 15;
  c.pin_d3 = 42; c.pin_d2 = 41; c.pin_d1 = 40; c.pin_d0 = 39;
  c.pin_vsync = 46; c.pin_href = 38; c.pin_pclk = 45;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_RGB565; c.frame_size = FRAMESIZE_QQVGA;
  c.jpeg_quality = 0; c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  c.sccb_i2c_port = -1;
  M5.In_I2C.release(); // Camera driver owns shared internal SCCB bus.
  esp_err_t err = esp_camera_init(&c);
  Serial.printf("CAMERA init=0x%x PSRAM=%u free=%u\n", err,
                ESP.getPsramSize(), ESP.getFreePsram());
  return err == ESP_OK;
}

void setup() {
  Serial.begin(115200);
  M5StackChan.begin();
  Serial.begin(115200);
  delay(1000);
#if FW_STAGE >= 6
  Serial.println("STAGE 6: Decisions backend vision/actions / face default / V=preview / L R U D C / X=reconnect");
#elif FW_STAGE >= 3
  Serial.println("STAGE 3: QVGA RGB565 + authenticated WSS / L R U D C / W=scan / X=WS reconnect");
#else
  Serial.println("STAGE 2 DIAG: QVGA RGB565 + Wi-Fi recovery / L R U D C / W=scan");
#endif
  if (!psramFound()) {
    Serial.println("FATAL: PSRAM unavailable");
    while (true) delay(1000);
  }
#if FW_STAGE >= 6
  M5StackChan.Motion.setAutoAngleSyncEnabled(false);
  stackchan_fw::initVision();
  behavior.idle(millis());
  stackchan_fw::drawFace(stackchan_fw::Expression::Neutral, 0, 0);
#endif
  moveHead(0, 0);
  cameraReady = startCamera();
  if (!cameraReady) M5.Display.drawString("Camera init failed", 10, 100);
  startWiFi();
  stackchan_fw::startWssTransport();
  reportAt = millis();
}

void loop() {
  serviceWiFi(millis());
  uint32_t now = millis();
  if (stackchan_fw::takeWssSafetyReset()) {
#if FW_STAGE >= 6
    behavior.idle(now);
#else
    moveHead(0, 0);
#endif
  }
  // No M5StackChan.update(): avoid internal I2C users after SCCB takes ownership.
  while (Serial.available()) {
    char c = toupper(Serial.read());
    switch (c) {
#if FW_STAGE >= 6
      case 'L': behavior.manual(-30, behavior.tilt, millis()); break;
      case 'R': behavior.manual(30, behavior.tilt, millis()); break;
      case 'U': behavior.manual(behavior.pan, 15, millis()); break;
      case 'D': behavior.manual(behavior.pan, -15, millis()); break;
      case 'C': behavior.idle(millis()); break;
#else
      case 'L': moveHead(-PAN_LIMIT, tilt); break;
      case 'R': moveHead(PAN_LIMIT, tilt); break;
      case 'U': moveHead(pan, TILT_LIMIT); break;
      case 'D': moveHead(pan, -TILT_LIMIT); break;
      case 'C': moveHead(0, 0); break;
#endif
      case 'W': beginWiFiScan(); break;
#if FW_STAGE >= 3
      case 'X': stackchan_fw::requestWssReconnect(); break;
#endif
#if FW_STAGE >= 6
      case 'V':
        cameraPreview = !cameraPreview;
        if (!cameraPreview) stackchan_fw::invalidateFace();
        Serial.printf("DISPLAY %s\n", cameraPreview ? "preview" : "face");
        break;
#endif
    }
  }
#if FW_STAGE >= 6
  now = millis();
  if (now - behaviorAt >= 20) {
    behaviorAt = now;
    if (stackchan_fw::wssSessionReady()) {
      stackchan_fw::ActionCommand command;
      while (stackchan_fw::receiveAction(command)) {
        if (command.generation == stackchan_fw::wssConnectionCount() &&
            stackchan_fw::wssSessionReady()) {
          if (!behavior.accept(command, now)) Serial.println("ACTION expired before application");
        }
      }
    } else {
      behavior.idle(now);
    }
    behavior.update(now);
    stackchan_fw::reportAction(behavior.action());
  }
  if (now - servoAt >= 100) {
    servoAt = now;
    int nextPan = constrain(static_cast<int>(lroundf(behavior.pan * 10)), -PAN_LIMIT, PAN_LIMIT);
    int nextTilt = constrain(static_cast<int>(lroundf(behavior.tilt * 10)), -TILT_LIMIT, TILT_LIMIT);
    if (nextPan != pan || nextTilt != tilt) moveHead(nextPan, nextTilt);
  }
  if (!cameraPreview && now - faceAt >= 100) {
    faceAt = now;
    stackchan_fw::drawFace(behavior.expression(), behavior.pan, behavior.tilt);
  }
  bool sendFrame = stackchan_fw::frameDue(now);
  if (cameraReady && (cameraPreview || sendFrame)) {
#else
  if (cameraReady) {
#endif
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) {
      if (fb->format == PIXFORMAT_RGB565 && fb->width == 160 &&
          fb->height == 120 && fb->len >= 160 * 120 * 2) {
#if FW_STAGE >= 6
        if (cameraPreview) {
#endif
        M5.Display.pushImage(0, 0, fb->width, fb->height,
                             reinterpret_cast<uint16_t*>(fb->buf));
        ++frames;
#if FW_STAGE >= 6
        }
        if (sendFrame) stackchan_fw::encodeFrame(fb, now);
#else
#endif
      } else Serial.println("CAMERA unexpected frame");
      esp_camera_fb_return(fb);
    } else Serial.println("CAMERA capture failed");
  }
#if FW_STAGE >= 6
  stackchan_fw::adaptVision(now);
  if (now - metricsAt >= 5000) {
    metricsAt = now;
    auto m = stackchan_fw::uploadMetrics();
    Serial.printf("STAGE6 wifi=%s rssi=%d wss=%s session=%s ws_connections=%u upload_fps=%.2f sent=%u dropped=%u send_ms=%u action=%s expression=%s heap=%u psram_free=%u\n",
                  WiFi.status() == WL_CONNECTED ? "online" : "offline",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                  stackchan_fw::wssConnected() ? "online" : "offline",
                  stackchan_fw::wssSessionReady() ? "ready" : "waiting",
                  stackchan_fw::wssConnectionCount(),
                  m.fpsMilli / 1000.0f, m.sent, m.dropped, m.lastSendMs,
                  stackchan_fw::actionName(behavior.action()),
                  behavior.expression() == stackchan_fw::Expression::Neutral ? "neutral" :
                  behavior.expression() == stackchan_fw::Expression::Happy ? "happy" :
                  behavior.expression() == stackchan_fw::Expression::Sad ? "sad" :
                  behavior.expression() == stackchan_fw::Expression::Surprised ? "surprised" : "thinking",
                  ESP.getFreeHeap(), ESP.getFreePsram());
  }
#endif
#if FW_STAGE < 6
  now = millis();
  if (now - reportAt >= 5000) {
    Serial.printf("STAGE%d frames=%u fps=%.2f heap=%u psram_free=%u wifi=%s rssi=%d wss=%s session=%s ws_connections=%u\n",
                  FW_STAGE, frames, frames * 1000.0 / (now - reportAt),
                  ESP.getFreeHeap(), ESP.getFreePsram(),
                  WiFi.status() == WL_CONNECTED ? "online" : "offline",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                  stackchan_fw::wssConnected() ? "online" : "offline",
                  stackchan_fw::wssSessionReady() ? "ready" : "waiting",
                  stackchan_fw::wssConnectionCount());
    frames = 0; reportAt = now;
  }
#endif
  delay(5);
}
