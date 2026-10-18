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
  int dx=static_cast<int>(pan/5),dy=static_cast<int>(-tilt/4);
  if(faceCacheValid() && lastFaceExpression()==expression && lastFaceDx()==dx && lastFaceDy()==dy) return;
  faceCacheValid()=true;lastFaceExpression()=expression;lastFaceDx()=dx;lastFaceDy()=dy;
  auto& d=M5.Display;
  d.startWrite();d.fillScreen(TFT_BLACK);
  int x1=94+dx,x2=226+dx,y=94+dy;
  if(expression==Expression::Happy) {
    for(int x : {x1,x2}) {d.drawLine(x-17,y+7,x,y-7,TFT_WHITE);d.drawLine(x,y-7,x+17,y+7,TFT_WHITE);}
    d.drawLine(135,158,160,174,TFT_WHITE);d.drawLine(160,174,185,158,TFT_WHITE);
  } else if(expression==Expression::Love) {
    for(int x : {x1,x2}) {
      d.fillCircle(x-5,y-3,7,TFT_WHITE);d.fillCircle(x+5,y-3,7,TFT_WHITE);
      d.fillTriangle(x-12,y,x+12,y,x,y+15,TFT_WHITE);
    }
    d.drawLine(136,164,160,178,TFT_WHITE);d.drawLine(160,178,184,164,TFT_WHITE);
  } else if(expression==Expression::Wink) {
    d.drawLine(x1-14,y+2,x1,y+8,TFT_WHITE);d.drawLine(x1,y+8,x1+14,y+2,TFT_WHITE);
    d.fillRoundRect(x2-10,y-16,20,32,9,TFT_WHITE);
    d.drawLine(137,168,160,178,TFT_WHITE);d.drawLine(160,178,183,168,TFT_WHITE);
  } else {
    int h=expression==Expression::Thinking?18:expression==Expression::Sleepy?8:40;
    if(expression==Expression::Sleepy) {
      for(int x : {x1,x2}) {d.drawLine(x-15,y+3,x,y+9,TFT_WHITE);d.drawLine(x,y+9,x+15,y+3,TFT_WHITE);}
      d.drawLine(151,170,169,170,TFT_WHITE);
    } else {
      for(int x : {x1,x2}) d.fillRoundRect(x-12,y-h/2,24,h,10,TFT_WHITE);
    }
    if(expression==Expression::Surprised) d.drawEllipse(160,166,11,16,TFT_WHITE);
    else if(expression==Expression::Sad) {
      d.drawLine(136,173,160,161,TFT_WHITE);d.drawLine(160,161,184,173,TFT_WHITE);
      d.drawLine(x1-18,y-29,x1+15,y-38,TFT_WHITE);d.drawLine(x2-15,y-38,x2+18,y-29,TFT_WHITE);
    } else if(expression==Expression::Thinking) {
      d.drawLine(145,165,175,159,TFT_WHITE);d.drawLine(x1-18,y-27,x1+18,y-35,TFT_WHITE);
    } else if(expression!=Expression::Sleepy) d.drawLine(141,164,179,164,TFT_WHITE);
  }
  d.endWrite();
}
}
