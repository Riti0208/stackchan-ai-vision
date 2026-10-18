#include "WssTransport.h"
#if FW_STAGE >= 3
#include "WssConfig.h"
#include "../secrets.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <atomic>
#include <ctime>
#include <sys/time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#if FW_STAGE >= 6
#include <freertos/queue.h>
#include <esp_heap_caps.h>
#endif

// ESP-IDF's built-in Mozilla root bundle, linked into flash by esp_crt_bundle.
extern const uint8_t crtBundleStart[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t crtBundleEnd[] asm("_binary_x509_crt_bundle_end");

namespace stackchan_fw {
namespace {
WebSocketsClient socket;
WssConfig config;
std::atomic<bool> connected{false}, sessionReady{false}, safetyReset{false}, reconnectRequested{false};
std::atomic<uint32_t> connections{0};
bool started = false;
bool closing = false; // Only accessed by the network task and its synchronous callback.
uint32_t connectedAt = 0;
uint32_t lastStatusAt = 0;
bool statusSent = false;
uint32_t lastAcceptedSeq = 0; // Reset for each WS generation; action handling is stage 6.
#if FW_STAGE >= 6
constexpr size_t packetCapacity=16+160*120*2;
struct FrameSlot { uint8_t* data=nullptr; size_t length=0; uint32_t generation=0,capturedAt=0; int state=0; };
FrameSlot slots[3];
int pending=-1;
portMUX_TYPE frameLock=portMUX_INITIALIZER_UNLOCKED;
QueueHandle_t actionQueue=nullptr;
std::atomic<uint32_t> sentFrames{0},droppedFrames{0},lastSendMs{0},measuredFpsMilli{0};
std::atomic<uint32_t> receivedAcks{0},lastAckMs{0};
std::atomic<Action> currentAction{Action::Idle};
uint32_t nextFrameId=0,statusWindowAt=0,statusWindowFrames=0;
struct AckSample { uint32_t frameId=0,sentAt=0; bool pending=false; };
AckSample ackSamples[16];
uint8_t nextAckSample=0;
void clearPendingFrame() {
  portENTER_CRITICAL(&frameLock);
  if(pending>=0) {slots[pending].state=0;pending=-1;droppedFrames.fetch_add(1);}
  portEXIT_CRITICAL(&frameLock);
}
void sendPendingFrame() {
  int index;
  portENTER_CRITICAL(&frameLock);
  index=pending;pending=-1;
  if(index>=0) slots[index].state=3;
  portEXIT_CRITICAL(&frameLock);
  if(index<0) return;
  auto& frame=slots[index];
  if(!sessionReady.load() || frame.generation!=connections.load() || millis()-frame.capturedAt>1000) {
    droppedFrames.fetch_add(1);
  } else {
    frame.data[10]=nextFrameId>>24;frame.data[11]=nextFrameId>>16;frame.data[12]=nextFrameId>>8;frame.data[13]=nextFrameId;
    uint32_t started=millis();
    bool ok=socket.sendBIN(frame.data,frame.length);
    lastSendMs.store(millis()-started);
    if(ok) {
      const uint32_t id=nextFrameId++;
      ackSamples[nextAckSample]={id,started,true};
      nextAckSample=(nextAckSample+1)%16;
      sentFrames.fetch_add(1);
    }
    else {droppedFrames.fetch_add(1);socket.disconnect();}
  }
  portENTER_CRITICAL(&frameLock);frame.state=0;portEXIT_CRITICAL(&frameLock);
}
#endif

void markOffline() {
  if (connected.exchange(false)) safetyReset.store(true);
  sessionReady.store(false);
#if FW_STAGE >= 6
  clearPendingFrame();
  if(actionQueue) xQueueReset(actionQueue);
  measuredFpsMilli.store(0);
  currentAction.store(Action::Idle);
#endif
}
void closeSocket() {
  if (closing) return;
  closing = true;
  socket.disconnect();
  markOffline();
  closing = false;
}
void onSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    connectedAt = millis();
    lastStatusAt = connectedAt;
    lastAcceptedSeq = 0;
    statusSent = false;
    sessionReady.store(false);
    uint32_t count = connections.fetch_add(1) + 1;
    connected.store(true);
#if FW_STAGE >= 6
    for(auto& sample:ackSamples) sample.pending=false;
    clearPendingFrame();
    if(actionQueue) xQueueReset(actionQueue);
    statusWindowAt=millis();statusWindowFrames=sentFrames.load();
#endif
    Serial.printf("WSS connected connections=%u; awaiting session\n", count);
  } else if (type == WStype_DISCONNECTED) {
    markOffline();
    char reason[65] = "transport_closed";
    if (payload && length) {
      const size_t count = length < sizeof(reason) - 1 ? length : sizeof(reason) - 1;
      for (size_t i = 0; i < count; ++i) {
        const uint8_t ch = payload[i];
        reason[i] = ch >= 32 && ch <= 126 ? static_cast<char>(ch) : '?';
      }
      reason[count] = '\0';
    }
    Serial.printf("WSS disconnected reason=%s connected_ms=%u status_age_ms=%u; retry in 5s\n",
                  reason, millis() - connectedAt, millis() - lastStatusAt);
  } else if (type == WStype_ERROR) {
    // Never print raw transport errors: they could reflect headers or URL contents.
    Serial.println("WSS transport error (check DNS / clock / CA / device token / server)");
  } else if (type == WStype_TEXT) {
    if (length > 2048) { Serial.println("WSS oversized text ignored"); return; }
    JsonDocument doc;
    auto err = deserializeJson(doc, static_cast<const uint8_t*>(payload), length,
                               DeserializationOption::NestingLimit(6));
    if (err) { Serial.println("WSS invalid JSON ignored"); return; }
    const char* messageType = doc["type"] | "";
    if (strcmp(messageType, "session") == 0) {
      const char* role = doc["data"]["role"] | "";
      const char* room = doc["data"]["room"] | "";
      const char* device = doc["data"]["device_id"] | "";
      if (!doc["data"]["protocol_version"].is<int>() ||
          doc["data"]["protocol_version"].as<int>() != 2 || strcmp(role, "device") != 0 ||
          strcmp(doc["data"]["frame_format"] | "", "rgb565le-v2") != 0 ||
          doc["data"]["width"].as<int>() != 160 || doc["data"]["height"].as<int>() != 120 ||
          config.room != room || config.device != device) {
        Serial.println("WSS session mismatch; closing connection");
        closeSocket();
        return;
      }
      sessionReady.store(true);
      Serial.println("WSS session OK protocol=2 role=device format=rgb565le-v2 size=160x120");
    } else if (strcmp(messageType, "frame_received") == 0) {
#if FW_STAGE >= 6
      auto data=doc["data"];
      const char* stream=data["stream_id"] | "";
      if(stream[0]!='\0' && data["frame_id"].is<uint32_t>()) {
        const uint32_t id=data["frame_id"].as<uint32_t>();
        for(auto& sample:ackSamples) if(sample.pending && sample.frameId==id) {
          lastAckMs.store(millis()-sample.sentAt);
          receivedAcks.fetch_add(1);
          sample.pending=false;
          break;
        }
      }
#endif
    } else if (strcmp(messageType, "action") == 0) {
#if FW_STAGE >= 6
      auto data=doc["data"];
      ActionCommand command;
      if(!sessionReady.load() || !data["seq"].is<uint32_t>() || !data["duration_ms"].is<uint32_t>() ||
         !data["pan"].is<float>() || !data["tilt"].is<float>() ||
         !parseAction(data["action"] | "",command.action) ||
         !parseExpression(data["expression"] | "",command.expression)) {
        Serial.println("ACTION invalid command ignored");return;
      }
      command.seq=data["seq"].as<uint32_t>();command.duration=data["duration_ms"].as<uint32_t>();
      command.pan=data["pan"].as<float>();command.tilt=data["tilt"].as<float>();
      command.generation=connections.load();command.receivedAt=millis();
      if(!validCommand(command)) {Serial.println("ACTION invalid bounds ignored");return;}
      if(command.seq<=lastAcceptedSeq) {Serial.println("ACTION stale/duplicate seq ignored");return;}
      if(actionQueue && xQueueOverwrite(actionQueue,&command)==pdPASS) {
        lastAcceptedSeq=command.seq;
        // ACK means received/accepted for scheduling, never physical completion.
        char ack[128];snprintf(ack,sizeof(ack),"{\"type\":\"action_ack\",\"timestamp\":%lu,\"data\":{\"seq\":%lu,\"accepted\":true}}",
          static_cast<unsigned long>(millis()),static_cast<unsigned long>(command.seq));
        socket.sendTXT(ack);
      }
#else
      Serial.println("WSS action received; execution waits for stage 6");
#endif
    } else if (strcmp(messageType, "error") == 0) {
      Serial.println("WSS server reported an error");
    }
  } else if (type == WStype_PONG) {
    Serial.println("WSS pong");
  } else if (type == WStype_FRAGMENT_TEXT_START || type == WStype_FRAGMENT_BIN_START ||
             type == WStype_FRAGMENT || type == WStype_FRAGMENT_FIN) {
    Serial.println("WSS fragmented message unsupported; closing connection");
    closeSocket();
  }
}
void networkTask(void*) {
  bool timeStarted = false, clockReported = false, socketStarted = false;
  uint32_t lastClockLog = 0;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (socketStarted) closeSocket();
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }
    if (!timeStarted) {
      configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
      timeStarted = true;
    }
    if (time(nullptr) < 1700000000) {
      uint32_t now = millis();
      if (lastClockLog == 0 || now - lastClockLog >= 10000) {
        Serial.println("WSS waiting for network time before certificate verification");
        lastClockLog = now;
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    if (!clockReported) { Serial.println("WSS clock ready"); clockReported = true; }
    if (!socketStarted) {
      const auto bundleSize = static_cast<size_t>(crtBundleEnd - crtBundleStart);
      if (bundleSize == 0) { Serial.println("WSS fatal: CA bundle unavailable"); vTaskDelete(nullptr); }
      socket.beginSslWithBundle(config.host.c_str(), config.port, config.path.c_str(),
                                crtBundleStart, bundleSize, "");
      String auth = String("Bearer ") + DEVICE_TOKEN;
      socket.setAuthorization(auth.c_str()); // The library stores its own String copy.
      socket.setExtraHeaders("");
      socket.setReconnectInterval(5000);
      socket.enableHeartbeat(15000, 3000, 2);
      socket.onEvent(onSocketEvent);
      socketStarted = true;
      Serial.println("WSS configured: TLS verification enabled, retry=5000ms");
    }
    if (reconnectRequested.exchange(false)) {
      Serial.println("WSS reconnect requested");
      closeSocket();
    }
    socket.loop(); // This task alone owns the socket, including its callbacks.
    if (connected.load() && !sessionReady.load() && millis() - connectedAt > 10000) {
      Serial.println("WSS session timeout; closing connection");
      closeSocket();
    }
    // device_status is telemetry; the backend does not use it as a connection
    // timeout. WebSocket ping/pong and transport close events detect dead links.
    // Stage 3 sends an honest minimal status; measured upload FPS is stage 5.
    uint32_t now = millis();
    if (sessionReady.load() && (!statusSent || now - lastStatusAt >= 5000)) {
      timeval tv;
      gettimeofday(&tv, nullptr);
      const auto timestamp = static_cast<unsigned long long>(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
      char message[256];
#if FW_STAGE >= 6
      uint32_t total=sentFrames.load();uint32_t elapsed=now-statusWindowAt;
      uint32_t fps=elapsed?(total-statusWindowFrames)*1000000ULL/elapsed:0;
      measuredFpsMilli.store(fps);
      statusWindowAt=now;statusWindowFrames=total;
      const char* action=actionName(currentAction.load());
#else
      uint32_t fps=0;const char* action="idle";
#endif
      int length = snprintf(message, sizeof(message),
        "{\"type\":\"device_status\",\"timestamp\":%llu,\"data\":{\"online\":true,\"face_version\":2,\"fps\":%.3f,\"wifi_rssi\":%d,\"battery\":null,\"current_action\":\"%s\"}}",
        timestamp, fps/1000.0, WiFi.RSSI(),action);
      if (length > 0 && static_cast<size_t>(length) < sizeof(message) &&
          socket.sendTXT(message, static_cast<size_t>(length))) {
        lastStatusAt = now;
        statusSent = true;
      } else {
        Serial.println("WSS keepalive send failed; closing connection");
        closeSocket();
      }
    }
#if FW_STAGE >= 6
    if(sessionReady.load()) sendPendingFrame();
#endif
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
} // namespace
void startWssTransport() {
  if (started) return;
  if (!parseWssConfig(DEVICE_SERVER_URL, config) || !validDeviceToken(DEVICE_TOKEN)) {
    Serial.println("WSS disabled: configure WSS URL (room/device_id) and DEVICE_TOKEN in secrets.h");
    return;
  }
#if FW_STAGE >= 6
  bool allocated=true;
  for(auto& frame:slots) {
    frame.data=static_cast<uint8_t*>(heap_caps_malloc(packetCapacity,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if(!frame.data) allocated=false;
  }
  actionQueue=xQueueCreate(1,sizeof(ActionCommand));
  if(!allocated || !actionQueue) {
    for(auto& frame:slots) {heap_caps_free(frame.data);frame.data=nullptr;}
    if(actionQueue) {vQueueDelete(actionQueue);actionQueue=nullptr;}
    Serial.println("WSS frame/action allocation failed; remaining safely idle");return;
  }
#endif
  // Keep WSS servicing ahead of the Arduino app loop without outranking the
  // ESP-IDF Wi-Fi/TCP tasks that actually move bytes over the radio.
  if (xTaskCreatePinnedToCore(networkTask, "wss_task", 12288, nullptr, 2, nullptr, 0) != pdPASS) {
    Serial.println("WSS task creation failed (insufficient internal memory)");
#if FW_STAGE >= 6
    for(auto& frame:slots) {heap_caps_free(frame.data);frame.data=nullptr;}
    if(actionQueue) {vQueueDelete(actionQueue);actionQueue=nullptr;}
#endif
    return;
  }
  started = true;
  Serial.println("WSS worker ready; waiting for Wi-Fi");
}
bool wssConnected() { return connected.load() && WiFi.status() == WL_CONNECTED; }
bool wssSessionReady() { return sessionReady.load() && wssConnected(); }
uint32_t wssConnectionCount() { return connections.load(); }
bool takeWssSafetyReset() { return safetyReset.exchange(false); }
void requestWssReconnect() { reconnectRequested.store(true); }
#if FW_STAGE >= 6
FrameLease acquireFrame() {
  if(!wssSessionReady()) return {};
  FrameLease lease;
  portENTER_CRITICAL(&frameLock);
  for(int i=0;i<3;++i) if(slots[i].state==0 && slots[i].data) {
    slots[i].state=1;lease={slots[i].data,packetCapacity,i};break;
  }
  portEXIT_CRITICAL(&frameLock);
  if(lease.slot<0) droppedFrames.fetch_add(1);
  return lease;
}
void discardFrame(FrameLease& lease) {
  if(lease.slot<0 || lease.slot>=3) return;
  portENTER_CRITICAL(&frameLock);slots[lease.slot].state=0;portEXIT_CRITICAL(&frameLock);
  lease.slot=-1;droppedFrames.fetch_add(1);
}
void publishFrame(FrameLease& lease,size_t packetLength,uint32_t generation,uint32_t capturedAt) {
  if(lease.slot<0) return;
  if(packetLength!=16+160*120*2 || packetLength>lease.capacity ||
     lease.data[0]!='S' || lease.data[1]!='C' || lease.data[2]!='F' || lease.data[3]!='W' ||
     lease.data[4]!=2 || lease.data[5]!=1 || lease.data[6]!=0 || lease.data[7]!=160 ||
     lease.data[8]!=0 || lease.data[9]!=120 || lease.data[14]!=0 || lease.data[15]!=0 ||
     !wssSessionReady() || generation!=connections.load()) {discardFrame(lease);return;}
  portENTER_CRITICAL(&frameLock);
  if(pending>=0) {slots[pending].state=0;droppedFrames.fetch_add(1);}
  auto& frame=slots[lease.slot];frame.length=packetLength;frame.generation=generation;
  frame.capturedAt=capturedAt;frame.state=2;pending=lease.slot;
  portEXIT_CRITICAL(&frameLock);
  lease.slot=-1;
}
bool receiveAction(ActionCommand& command) {return actionQueue && xQueueReceive(actionQueue,&command,0)==pdPASS;}
void reportAction(Action action) {currentAction.store(action);}
UploadMetrics uploadMetrics() {return {sentFrames.load(),droppedFrames.load(),lastSendMs.load(),measuredFpsMilli.load(),receivedAcks.load(),lastAckMs.load()};}
#endif
} // namespace stackchan_fw
#endif
