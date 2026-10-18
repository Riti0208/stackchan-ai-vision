#pragma once
#include "Behavior.h"
#include <M5Unified.h>
namespace stackchan_fw {
inline bool& faceCacheValid() { static bool valid=false; return valid; }
inline Expression& lastFaceExpression() { static Expression value=Expression::Neutral; return value; }
inline int& lastFaceDx() { static int value=0; return value; }
inline int& lastFaceDy() { static int value=0; return value; }
inline void invalidateFace() { faceCacheValid()=false; }
inline void drawFace(Expression expression,float pan,float tilt) {
  const int dx=static_cast<int>(pan/5),dy=static_cast<int>(-tilt/4);
  if(faceCacheValid() && lastFaceExpression()==expression && lastFaceDx()==dx && lastFaceDy()==dy) return;
  // Compose in PSRAM and present the complete face without a blank-screen phase.
  static M5Canvas canvas(&M5.Display);
  static bool attempted=false,buffered=false;
  if(!attempted) {
    attempted=true;canvas.setColorDepth(16);canvas.setPsram(true);
    buffered=canvas.createSprite(320,240)!=nullptr;
    if(!buffered) Serial.println("FACE buffer unavailable; using direct drawing");
  }
  lgfx::LGFXBase& d=buffered ? static_cast<lgfx::LGFXBase&>(canvas) : static_cast<lgfx::LGFXBase&>(M5.Display);
  d.startWrite();d.fillScreen(TFT_BLACK);
  const int x1=86+dx,x2=234+dx,y=82+dy;
  auto line=[&](int ax,int ay,int bx,int by,uint32_t color) {
    for(int o=-2;o<=2;++o) {d.drawLine(ax+o,ay,bx+o,by,color);d.drawLine(ax,ay+o,bx,by+o,color);}
  };
  auto ellipse=[&](int x,int cy,int rx,int ry,uint32_t color) {
    for(int o=-2;o<=2;++o) d.drawEllipse(x,cy,rx+o,ry+o,color);
  };
  auto eye=[&](int x,int h,uint32_t color) {
    d.fillRoundRect(x-21,y-h/2,42,h,18,color);
    if(h>=38) {d.fillCircle(x-8,y-h/2+12,6,TFT_WHITE);d.fillCircle(x+9,y+h/2-10,3,TFT_WHITE);}
  };
  auto closed=[&](int x,bool happy,uint32_t color) {
    const int mid=happy?-14:10;
    line(x-28,y+3,x,y+mid,color);line(x,y+mid,x+28,y+3,color);
  };
  auto cheeks=[&](uint32_t color) {for(int x : {x1,x2}) d.fillEllipse(x,127+dy,29,11,color);};
  auto smile=[&](uint32_t color) {
    line(122,158,143,178,color);line(143,178,177,178,color);line(177,178,198,158,color);
  };
  auto sparkle=[&](int x,int cy,uint32_t color) {
    d.fillTriangle(x,cy-15,x-5,cy,x+5,cy,color);d.fillTriangle(x,cy+15,x-5,cy,x+5,cy,color);
    d.fillTriangle(x-12,cy,x,cy-4,x,cy+4,color);d.fillTriangle(x+12,cy,x,cy-4,x,cy+4,color);
  };
  switch(expression) {
    case Expression::Happy:
      for(int x : {x1,x2}) closed(x,true,TFT_YELLOW);
      cheeks(TFT_ORANGE);smile(TFT_YELLOW);break;
    case Expression::Sad:
      for(int x : {x1,x2}) eye(x,42,TFT_SKYBLUE);
      line(x1-29,y-26,x1+24,y-43,TFT_SKYBLUE);line(x2-24,y-43,x2+29,y-26,TFT_SKYBLUE);
      line(125,184,160,161,TFT_SKYBLUE);line(160,161,195,184,TFT_SKYBLUE);
      d.fillCircle(x1-27,y+35,8,TFT_CYAN);break;
    case Expression::Surprised:
      for(int x : {x1,x2}) {ellipse(x,y,30,34,TFT_CYAN);d.fillCircle(x-6,y-9,7,TFT_WHITE);}
      ellipse(160,174,25,33,TFT_YELLOW);sparkle(35,143,TFT_CYAN);break;
    case Expression::Thinking:
      for(int x : {x1,x2}) eye(x,19,TFT_MAGENTA);
      line(x1-29,y-23,x1+27,y-39,TFT_MAGENTA);
      for(int x : {136,160,184}) d.fillCircle(x,175,6,TFT_CYAN);break;
    case Expression::Sleepy:
      for(int x : {x1,x2}) closed(x,false,TFT_SKYBLUE);
      line(145,174,175,174,TFT_SKYBLUE);
      line(270,18,295,18,TFT_CYAN);line(295,18,270,43,TFT_CYAN);line(270,43,295,43,TFT_CYAN);
      line(246,45,260,45,TFT_CYAN);line(260,45,246,59,TFT_CYAN);line(246,59,260,59,TFT_CYAN);break;
    case Expression::Love:
      for(int x : {x1,x2}) {
        d.fillCircle(x-13,y-7,20,TFT_PINK);d.fillCircle(x+13,y-7,20,TFT_PINK);
        d.fillTriangle(x-33,y-1,x+33,y-1,x,y+36,TFT_PINK);d.fillCircle(x-15,y-14,5,TFT_WHITE);
      }
      cheeks(TFT_MAGENTA);smile(TFT_PINK);sparkle(35,164,TFT_YELLOW);sparkle(285,164,TFT_YELLOW);break;
    case Expression::Wink:
      closed(x1,false,TFT_GREEN);eye(x2,60,TFT_GREEN);cheeks(TFT_PINK);
      line(126,174,164,180,TFT_GREEN);line(164,180,193,159,TFT_GREEN);sparkle(281,30,TFT_YELLOW);break;
    case Expression::Angry:
      for(int x : {x1,x2}) eye(x,27,TFT_ORANGE);
      d.fillTriangle(x1-34,y-37,x1+29,y-11,x1+29,y-25,TFT_RED);
      d.fillTriangle(x2+34,y-37,x2-29,y-11,x2-29,y-25,TFT_RED);
      d.fillRoundRect(119,158,82,32,9,TFT_WHITE);d.fillRoundRect(124,163,72,22,5,TFT_BLACK);
      line(126,174,194,174,TFT_RED);for(int x : {145,175}) line(x,164,x,184,TFT_RED);break;
    case Expression::Excited:
      for(int x : {x1,x2}) {
        d.fillTriangle(x,y-36,x-11,y,x+11,y,TFT_YELLOW);d.fillTriangle(x,y+36,x-11,y,x+11,y,TFT_YELLOW);
        d.fillTriangle(x-34,y,x,y-10,x,y+10,TFT_YELLOW);d.fillTriangle(x+34,y,x,y-10,x,y+10,TFT_YELLOW);
        d.fillCircle(x-3,y-5,4,TFT_WHITE);
      }
      d.fillEllipse(160,169,30,29,TFT_ORANGE);d.fillEllipse(160,184,17,8,TFT_PINK);
      sparkle(35,151,TFT_CYAN);sparkle(285,151,TFT_CYAN);break;
    case Expression::Embarrassed:
      for(int x : {x1,x2}) closed(x,true,TFT_PINK);
      cheeks(TFT_PINK);for(int x : {x1,x2}) for(int o : {-13,0,13}) line(x+o-3,132+dy,x+o+3,122+dy,TFT_RED);
      line(144,172,153,178,TFT_PINK);line(153,178,161,170,TFT_PINK);line(161,170,174,177,TFT_PINK);break;
    case Expression::Confused:
      ellipse(x1,y,26,30,TFT_MAGENTA);d.fillCircle(x2,y+7,12,TFT_ORANGE);
      line(x1-26,y-43,x1+26,y-46,TFT_MAGENTA);line(x2-27,y-32,x2+25,y-19,TFT_ORANGE);
      line(149,19,170,19,TFT_YELLOW);line(170,19,177,29,TFT_YELLOW);line(177,29,160,41,TFT_YELLOW);d.fillCircle(160,53,4,TFT_YELLOW);
      line(128,176,147,166,TFT_MAGENTA);line(147,166,168,181,TFT_MAGENTA);line(168,181,191,168,TFT_MAGENTA);break;
    case Expression::Curious:
      for(int x : {x1,x2}) {ellipse(x,y,x==x1?33:26,x==x1?35:27,TFT_GREEN);d.fillCircle(x+9,y-7,12,TFT_YELLOW);d.fillCircle(x+5,y-13,4,TFT_WHITE);}
      line(x1-31,y-45,x1+30,y-50,TFT_GREEN);ellipse(167,175,12,15,TFT_YELLOW);break;
    case Expression::Relaxed:
      for(int x : {x1,x2}) closed(x,false,TFT_GREEN);
      cheeks(TFT_CYAN);smile(TFT_GREEN);break;
    case Expression::Crying:
      for(int x : {x1,x2}) {
        closed(x,true,TFT_SKYBLUE);d.fillRoundRect(x-17,y+12,34,68,12,TFT_CYAN);
        line(x-6,y+20,x-6,y+67,TFT_WHITE);
      }
      ellipse(160,181,28,19,TFT_SKYBLUE);break;
    case Expression::Tired:
      for(int x : {x1,x2}) {eye(x,22,TFT_LIGHTGREY);line(x-27,y-12,x+27,y-12,TFT_MAGENTA);line(x-23,y+24,x+23,y+28,TFT_PURPLE);}
      ellipse(160,177,14,24,TFT_MAGENTA);break;
    case Expression::Proud:
      for(int x : {x1,x2}) {closed(x,true,TFT_YELLOW);line(x-27,y-29,x+27,y-29,TFT_ORANGE);}
      d.fillTriangle(134,29,123,4,154,20,TFT_YELLOW);d.fillTriangle(145,29,160,0,175,29,TFT_YELLOW);
      d.fillTriangle(166,20,197,4,186,29,TFT_YELLOW);d.fillRect(134,25,52,9,TFT_YELLOW);d.fillCircle(160,27,4,TFT_CYAN);
      line(125,181,166,181,TFT_ORANGE);line(166,181,194,157,TFT_ORANGE);sparkle(35,158,TFT_YELLOW);sparkle(285,158,TFT_YELLOW);break;
    case Expression::Laughing:
      line(x1-24,y-21,x1+9,y,TFT_ORANGE);line(x1+9,y,x1-24,y+21,TFT_ORANGE);
      line(x2+24,y-21,x2-9,y,TFT_ORANGE);line(x2-9,y,x2+24,y+21,TFT_ORANGE);
      cheeks(TFT_PINK);d.fillEllipse(160,166,45,41,TFT_ORANGE);d.fillRect(112,123,96,29,TFT_BLACK);
      d.fillEllipse(160,190,25,11,TFT_PINK);sparkle(35,172,TFT_YELLOW);sparkle(285,172,TFT_YELLOW);break;
    default:
      for(int x : {x1,x2}) eye(x,60,TFT_CYAN);
      line(143,169,160,177,TFT_CYAN);line(160,177,177,169,TFT_CYAN);break;
  }
  d.endWrite();if(buffered) canvas.pushSprite(0,0);
  faceCacheValid()=true;lastFaceExpression()=expression;lastFaceDx()=dx;lastFaceDy()=dy;
}
}
