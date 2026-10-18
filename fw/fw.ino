#include <M5StackChan.h>
#include <esp_camera.h>
#include <esp_heap_caps.h>
#include <WiFi.h>
#include "secrets.h"

// Stage 2: Wi-Fi connection/recovery. WSS is gated until this stage is verified.
constexpr int PAN_LIMIT = 300;    // 0.1 degree units
constexpr int TILT_CENTER = 450;
constexpr int TILT_LIMIT = 150;
constexpr int SERVO_SPEED = 200; // Official Motion scale: 0..1000
bool cameraReady = false;
uint32_t frames = 0;
uint32_t reportAt = 0;
int pan = 0, tilt = 0;
constexpr uint32_t WIFI_RETRY_MS = 10000;
uint32_t wifiAttemptAt = 0;
bool wifiWasConnected = false;
bool wifiConfigured = false;
uint32_t wifiConnections = 0;

void startWiFi() {
  wifiConfigured = WIFI_SSID[0] != '\0';
  if (!wifiConfigured) {
    Serial.println("WIFI configuration missing: edit secrets.h");
    return;
  }
  WiFi.persistent(false); // Keep credentials out of Wi-Fi NVS storage.
  WiFi.setHostname("stackchan");
  if (!WiFi.mode(WIFI_STA)) {
    Serial.println("WIFI STA initialization failed; reboot to retry");
    wifiConfigured = false;
    return;
  }
  // One retry scheduler, rather than overlapping automatic connection attempts.
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttemptAt = millis();
  Serial.println("WIFI connecting (2.4GHz), retry interval=10000ms");
}

void serviceWiFi(uint32_t now) {
  if (!wifiConfigured) return;
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wifiWasConnected) {
    ++wifiConnections;
    Serial.printf("WIFI connected ip=%s rssi=%d connections=%u\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(), wifiConnections);
  } else if (!connected && wifiWasConnected) {
    Serial.println("WIFI disconnected; centering, will reconnect in 10s");
    moveHead(0, 0);
    wifiAttemptAt = now;
  }
  wifiWasConnected = connected;
  if (!connected && now - wifiAttemptAt >= WIFI_RETRY_MS) {
    wifiAttemptAt = now;
    Serial.printf("WIFI retry status=%d\n", static_cast<int>(WiFi.status()));
    WiFi.disconnect(false, false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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
  c.pixel_format = PIXFORMAT_RGB565; c.frame_size = FRAMESIZE_QVGA;
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
  Serial.println("STAGE 2: QVGA RGB565 + Wi-Fi recovery / L R U D C");
  if (!psramFound()) {
    Serial.println("FATAL: PSRAM unavailable");
    while (true) delay(1000);
  }
  moveHead(0, 0);
  cameraReady = startCamera();
  if (!cameraReady) M5.Display.drawString("Camera init failed", 10, 100);
  startWiFi();
  reportAt = millis();
}

void loop() {
  serviceWiFi(millis());
  // No M5StackChan.update(): avoid internal I2C users after SCCB takes ownership.
  while (Serial.available()) {
    char c = toupper(Serial.read());
    switch (c) {
      case 'L': moveHead(-PAN_LIMIT, tilt); break;
      case 'R': moveHead(PAN_LIMIT, tilt); break;
      case 'U': moveHead(pan, TILT_LIMIT); break;
      case 'D': moveHead(pan, -TILT_LIMIT); break;
      case 'C': moveHead(0, 0); break;
    }
  }
  if (cameraReady) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) {
      if (fb->format == PIXFORMAT_RGB565 && fb->width == 320 &&
          fb->height == 240 && fb->len >= 320 * 240 * 2) {
        M5.Display.pushImage(0, 0, fb->width, fb->height,
                             reinterpret_cast<uint16_t*>(fb->buf));
        ++frames;
      } else Serial.println("CAMERA unexpected frame");
      esp_camera_fb_return(fb);
    } else Serial.println("CAMERA capture failed");
  }
  uint32_t now = millis();
  if (now - reportAt >= 5000) {
    Serial.printf("STAGE2 frames=%u fps=%.2f heap=%u psram_free=%u wifi=%s rssi=%d\n",
                  frames, frames * 1000.0 / (now - reportAt),
                  ESP.getFreeHeap(), ESP.getFreePsram(),
                  WiFi.status() == WL_CONNECTED ? "online" : "offline",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    frames = 0; reportAt = now;
  }
  delay(5);
}
