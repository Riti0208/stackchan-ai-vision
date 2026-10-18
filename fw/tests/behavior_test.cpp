#include "../src/Behavior.h"
#include <cassert>
#include <cmath>
#include <string>

using namespace stackchan_fw;

static ActionCommand command(uint32_t seq, Action action, float pan, float tilt,
                             uint32_t duration, uint32_t receivedAt) {
  ActionCommand c;
  c.seq=seq;c.action=action;c.pan=pan;c.tilt=tilt;c.duration=duration;c.receivedAt=receivedAt;
  return c;
}

int main() {
  for (const char* name : {"neutral","happy","sad","surprised","thinking","sleepy","love","wink","angry","excited","embarrassed","confused","curious","relaxed","crying","tired","proud","laughing"}) {
    Expression expression = Expression::Neutral;
    assert(parseExpression(name, expression));
    assert(std::string(expressionName(expression)) == name);
    auto c=command(1,Action::Idle,0,0,500,0);c.expression=expression;assert(validCommand(c));
    Behavior b;assert(b.accept(c,0));assert(b.expression()==expression);
  }
  Expression invalidExpression = Expression::Neutral;
  assert(!parseExpression("not_a_face", invalidExpression));

  Behavior b;
  b.idle(0);
  auto tracking=command(1,Action::LookAt,1.0f,-1.0f,1000,0);
  assert(b.accept(tracking,0));
  for(uint32_t t=20;t<=1000;t+=20) b.update(t);
  assert(std::abs(b.pan-30.0f)<0.01f);
  assert(std::abs(b.tilt+15.0f)<0.01f);

  auto nod=command(2,Action::Nod,-0.5f,0.5f,500,1000);
  assert(b.accept(nod,1000));
  assert(b.action()==Action::Nod);
  // A fresh tracking command updates the return target without interrupting nod.
  auto follow=command(3,Action::LookAt,0.25f,-0.25f,1000,1100);
  assert(b.accept(follow,1100));
  assert(b.action()==Action::Nod);
  for(uint32_t t=1120;t<=1600;t+=20) b.update(t);
  assert(b.action()==Action::LookAt);
  for(uint32_t t=1620;t<=3000;t+=20) b.update(t);
  assert(std::abs(b.pan-7.5f)<0.01f);
  assert(std::abs(b.tilt+3.75f)<0.01f);

  auto stale=command(4,Action::LookAt,0,0,100,4000);
  assert(!b.accept(stale,4101));
  auto outside=command(5,Action::LookAt,1.01f,0,500,4100);
  assert(!b.accept(outside,4100));

  b.manual(100,-100,5000);
  for(uint32_t t=5020;t<=6000;t+=20) {
    b.update(t);
    assert(b.pan>=-30.0f && b.pan<=30.0f);
    assert(b.tilt>=-15.0f && b.tilt<=15.0f);
  }
  assert(std::abs(b.pan-30.0f)<0.01f);
  assert(std::abs(b.tilt+15.0f)<0.01f);
  // A healthy but slow AI must not cause the old 3-second recentering cycle.
  Behavior held;
  auto gaze=command(1,Action::LookAt,.5f,-.4f,250,0);
  assert(held.accept(gaze,0));
  for(uint32_t t=20;t<=10000;t+=20) held.update(t);
  assert(held.action()==Action::LookAt);
  assert(std::abs(held.pan-15.0f)<.01f && std::abs(held.tilt+6.0f)<.01f);
  // Explicit idle is also the path used on a real Wi-Fi/WebSocket disconnect.
  held.idle(10000);
  for(uint32_t t=10020;t<=11000;t+=20) held.update(t);
  assert(held.action()==Action::Idle);
  assert(std::abs(held.pan)<.01f && std::abs(held.tilt)<.01f);

}
