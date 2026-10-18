#include "WssTransport.h"
#if FW_STAGE >= 6
#include "Vision.h"
#include <img_converters.h>
#include <esp_heap_caps.h>
namespace stackchan_fw {
namespace {
uint8_t* thumbnail=nullptr;
uint32_t lastCapture=0,lastAdapt=0,lastSent=0,lastDropped=0,encodeMs=0;
int quality=60;
// Target roughly 60 fps; the adaptive fallback reduces quality, then rate,
// then resolution if JPEG encoding or WebSocket transmission cannot keep up.
uint32_t period=17;
bool small=false;
unsigned badWindows=0,encodeFailures=0;
struct Sink { FrameLease lease; size_t length=0; bool overflow=false; };
size_t writeJpeg(void* context,size_t index,const void* data,size_t length) {
  auto& s=*static_cast<Sink*>(context);
  if(!data || !length) return 0;
  if(index>s.lease.capacity-4 || length>s.lease.capacity-4-index) {s.overflow=true;return 0;}
  memcpy(s.lease.data+4+index,data,length);s.length=std::max(s.length,index+length);return length;
}
}
void initVision() {
  thumbnail=static_cast<uint8_t*>(heap_caps_malloc(160*120*2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(!thumbnail) Serial.println("VISION thumbnail buffer unavailable; QQVGA fallback disabled");
}
bool frameDue(uint32_t now) {
  if(!wssSessionReady() || now-lastCapture<period) return false;
  lastCapture=now;return true;
}
void encodeFrame(camera_fb_t* fb,uint32_t now) {
  if(!fb || fb->format!=PIXFORMAT_RGB565 || fb->width!=320 || fb->height!=240 || fb->len<320*240*2) return;
  uint32_t generation=wssConnectionCount();
  Sink sink;sink.lease=acquireFrame();if(sink.lease.slot<0) return;
  camera_fb_t source=*fb;
  if(small && thumbnail) {
    for(unsigned y=0;y<120;++y) for(unsigned x=0;x<160;++x)
      memcpy(thumbnail+2*(y*160+x),fb->buf+2*((y*2)*320+x*2),2);
    source.buf=thumbnail;source.len=160*120*2;source.width=160;source.height=120;
  }
  uint32_t started=millis();
  bool ok=frame2jpg_cb(&source,quality,writeJpeg,&sink);
  encodeMs=millis()-started;
  if(ok && !sink.overflow && sink.length>=4) publishFrame(sink.lease,sink.length,generation,now);
  else {++encodeFailures;discardFrame(sink.lease);}
}
void adaptVision(uint32_t now) {
  if(now-lastAdapt<10000) return;
  auto m=uploadMetrics();uint32_t elapsed=now-lastAdapt,sent=m.sent-lastSent,dropped=m.dropped-lastDropped;
  lastAdapt=now;lastSent=m.sent;lastDropped=m.dropped;
  if(!wssSessionReady()) {badWindows=0;encodeFailures=0;return;}
  float fps=sent*1000.0f/elapsed;
  bool pressure=encodeFailures>=3 || encodeMs>period || (dropped>=3 && dropped>sent) ||
                (sent>0 && fps<0.6f*1000/period && m.lastSendMs>period);
  encodeFailures=0;
  badWindows=pressure?badWindows+1:0;
  if(badWindows<2) return;
  badWindows=0;
  if(quality>30) quality-=15;
  else if(period==17) period=1000;
  else if(!small && thumbnail) small=true;
  else return;
  Serial.printf("VISION pressure fallback quality=%d fps_target=%d size=%s\n",quality,period==17?60:1,small?"160x120":"320x240");
}
}
#endif
