#include "WssTransport.h"
#if FW_STAGE >= 6
#include "Vision.h"
namespace stackchan_fw {
namespace {
uint32_t lastCapture=0;
// Cap upload attempts at 60 fps. The camera/network/backend may deliver less.
constexpr uint32_t period=17;
}
void initVision() {
  Serial.println("VISION upload profile format=RGB565LE size=160x120 fps_target=60");
}
bool frameDue(uint32_t now) {
  if(!wssSessionReady() || now-lastCapture<period) return false;
  lastCapture=now;return true;
}
void encodeFrame(camera_fb_t* fb,uint32_t now) {
  if(!fb || fb->format!=PIXFORMAT_RGB565 || fb->width!=160 || fb->height!=120 || fb->len<160*120*2) return;
  auto lease=acquireFrame();if(lease.slot<0) return;
  constexpr size_t header=16, pixels=160*120*2;
  lease.data[0]='S';lease.data[1]='C';lease.data[2]='F';lease.data[3]='W';
  lease.data[4]=2;lease.data[5]=1;
  lease.data[6]=0;lease.data[7]=160;lease.data[8]=0;lease.data[9]=120;
  lease.data[10]=lease.data[11]=lease.data[12]=lease.data[13]=0; // Set by transport at send time.
  lease.data[14]=lease.data[15]=0;
  memcpy(lease.data+header,fb->buf,pixels);
  publishFrame(lease,header+pixels,wssConnectionCount(),now);
}
void adaptVision(uint32_t) {}
}
#endif
