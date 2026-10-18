#include "../src/Behavior.h"
#include <cassert>
#include <cmath>

using namespace stackchan_fw;

static ActionCommand command(uint32_t seq, Action action, float pan, float tilt,
                             uint32_t duration, uint32_t receivedAt) {
  ActionCommand c;
  c.seq=seq;c.action=action;c.pan=pan;c.tilt=tilt;c.duration=duration;c.receivedAt=receivedAt;
  return c;
}

int main() {
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
}
