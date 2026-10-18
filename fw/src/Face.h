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
  } else {
    int h=expression==Expression::Thinking?18:40;
    for(int x : {x1,x2}) d.fillRoundRect(x-12,y-h/2,24,h,10,TFT_WHITE);
    if(expression==Expression::Surprised) d.drawEllipse(160,166,11,16,TFT_WHITE);
    else if(expression==Expression::Sad) {
      d.drawLine(136,173,160,161,TFT_WHITE);d.drawLine(160,161,184,173,TFT_WHITE);
      d.drawLine(x1-18,y-29,x1+15,y-38,TFT_WHITE);d.drawLine(x2-15,y-38,x2+18,y-29,TFT_WHITE);
    } else if(expression==Expression::Thinking) {
      d.drawLine(145,165,175,159,TFT_WHITE);d.drawLine(x1-18,y-27,x1+18,y-35,TFT_WHITE);
    } else d.drawLine(141,164,179,164,TFT_WHITE);
  }
  d.endWrite();
}
}
