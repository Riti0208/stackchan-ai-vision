#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
namespace stackchan_fw {
enum class Action : uint8_t { Idle, LookAt, Nod, Shake, Happy };
enum class Expression : uint8_t { Neutral, Happy, Sad, Surprised, Thinking, Sleepy, Love, Wink, Angry, Excited, Embarrassed, Confused, Curious, Relaxed, Crying, Tired, Proud, Laughing, Count };
constexpr unsigned expressionCount=static_cast<unsigned>(Expression::Count);
inline const char* actionName(Action a) {
  static const char* names[]={"idle","look_at","nod","shake","happy"};
  return names[static_cast<unsigned>(a) < 5 ? static_cast<unsigned>(a) : 0];
}
inline bool parseAction(const char* s, Action& a) {
  for (int i=0;i<5;++i) if (strcmp(s,actionName(static_cast<Action>(i)))==0) { a=static_cast<Action>(i);return true; }
  return false;
}
inline bool parseExpression(const char* s, Expression& e) {
  static const char* names[]={"neutral","happy","sad","surprised","thinking","sleepy","love","wink","angry","excited","embarrassed","confused","curious","relaxed","crying","tired","proud","laughing"};
  for(unsigned i=0;i<expressionCount;++i) if(strcmp(s,names[i])==0) { e=static_cast<Expression>(i);return true; }
  return false;
}
inline const char* expressionName(Expression e) {
  static const char* names[]={"neutral","happy","sad","surprised","thinking","sleepy","love","wink","angry","excited","embarrassed","confused","curious","relaxed","crying","tired","proud","laughing"};
  const auto index=static_cast<unsigned>(e);
  return names[index<expressionCount?index:0];
}
struct ActionCommand {
  uint32_t seq=0, generation=0, receivedAt=0, duration=500;
  Action action=Action::Idle;
  Expression expression=Expression::Neutral;
  float pan=0, tilt=0;
};
inline bool validCommand(const ActionCommand& c) {
  return c.seq>0 && c.duration>=100 && c.duration<=3000 &&
    std::isfinite(c.pan) && std::isfinite(c.tilt) && std::abs(c.pan)<=1 && std::abs(c.tilt)<=1 &&
    static_cast<unsigned>(c.action)<5 && static_cast<unsigned>(c.expression)<expressionCount;
}
class Behavior {
 public:
  void idle(uint32_t /*now*/) {
    gesture=false; targetPan=targetTilt=0; nextExpression=Expression::Neutral;
    baseAction=Action::Idle;
  }
  bool accept(const ActionCommand& c,uint32_t now) {
    // The network task can enqueue after the consumer sampled now. A small
    // negative age is fresh, not an unsigned wrap to a multi-day expiry.
    const int32_t age=static_cast<int32_t>(now-c.receivedAt);
    if(!validCommand(c) || age>static_cast<int32_t>(c.duration)) return false;
    targetPan=c.action==Action::Idle?0:c.pan*30;
    targetTilt=c.action==Action::Idle?0:c.tilt*15;
    nextExpression=c.expression;
    baseAction=c.action==Action::Idle?Action::Idle:Action::LookAt;
    // Preserve the active gesture; retain the newest tracking target for its end.
    if(!gesture && (c.action==Action::Nod || c.action==Action::Shake || c.action==Action::Happy)) {
      gesture=true; gestureAction=c.action; gestureExpression=c.expression;
      gesturePan=targetPan;gestureTilt=targetTilt;gestureAt=now;gestureDuration=c.duration;
    }
    return true;
  }
  void manual(float pan,float tilt,uint32_t now) {
    idle(now);targetPan=std::clamp(pan,-30.0f,30.0f);targetTilt=std::clamp(tilt,-15.0f,15.0f);
    baseAction=Action::LookAt;
  }
  void update(uint32_t now) {
    uint32_t elapsed=now-lastUpdate;lastUpdate=now;
    if(gesture && now-gestureAt>=gestureDuration) gesture=false;
    // Keep the last gaze between AI results. Explicit idle and transport loss
    // still center the head; a quiet but connected server must not cause a snap back.
    float p=targetPan,t=targetTilt;
    if(gesture) {
      float phase=6.28318530718f*(now-gestureAt)/gestureDuration;
      p=gesturePan;t=gestureTilt;
      if(gestureAction==Action::Nod) t+=12*std::sin(phase);
      if(gestureAction==Action::Shake) p+=20*std::sin(phase);
      if(gestureAction==Action::Happy) {p+=10*std::sin(phase);t+=8*std::sin(2*phase);}
    }
    // Keep movement smooth but responsive: pan 50deg/s, tilt 35deg/s.
    float dt=std::min<uint32_t>(elapsed,100)/1000.0f;
    pan+=std::clamp(std::clamp(p,-30.0f,30.0f)-pan,-50*dt,50*dt);
    tilt+=std::clamp(std::clamp(t,-15.0f,15.0f)-tilt,-35*dt,35*dt);
  }
  float pan=0,tilt=0;
  Action action() const {return gesture?gestureAction:baseAction;}
  Expression expression() const {return gesture?gestureExpression:nextExpression;}
 private:
  float targetPan=0,targetTilt=0,gesturePan=0,gestureTilt=0;
  uint32_t lastUpdate=0,gestureAt=0,gestureDuration=100;
  bool gesture=false;
  Action baseAction=Action::Idle,gestureAction=Action::Idle;
  Expression nextExpression=Expression::Neutral,gestureExpression=Expression::Neutral;
};
}
