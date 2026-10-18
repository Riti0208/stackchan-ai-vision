#pragma once
#include <cstdint>
#include <cstddef>
#include "Behavior.h"
#ifndef FW_STAGE
#define FW_STAGE 6
#endif
namespace stackchan_fw {
#if FW_STAGE >= 3
void startWssTransport();
bool wssConnected();
bool wssSessionReady();
uint32_t wssConnectionCount();
bool takeWssSafetyReset();
void requestWssReconnect();
#if FW_STAGE >= 6
struct FrameLease { uint8_t* data=nullptr; size_t capacity=0; int slot=-1; };
struct UploadMetrics { uint32_t sent=0,dropped=0,lastSendMs=0,fpsMilli=0; };
FrameLease acquireFrame();
void publishFrame(FrameLease& lease,size_t packetLength,uint32_t generation,uint32_t capturedAt);
void discardFrame(FrameLease& lease);
bool receiveAction(ActionCommand& command);
void reportAction(Action action);
UploadMetrics uploadMetrics();
#endif
#else
inline void startWssTransport() {}
inline bool wssConnected() { return false; }
inline bool wssSessionReady() { return false; }
inline uint32_t wssConnectionCount() { return 0; }
inline bool takeWssSafetyReset() { return false; }
inline void requestWssReconnect() {}
#endif
}
