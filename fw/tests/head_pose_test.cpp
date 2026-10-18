#include "../src/Behavior.h"
#include "../src/HeadPose.h"
#include <cassert>
#include <cmath>
using namespace stackchan_fw;
int main() {
  // Manual contract: left/right map to negative/positive yaw on this robot.
  assert(servoHeadTarget(-60,0).yaw<0);
  assert(servoHeadTarget(60,0).yaw>0);
  // Up/down worked before this fix; preserve exactly the previous pitch mapping.
  for(int tilt : {-150,0,150}) assert(servoHeadTarget(0,tilt).pitch==450+tilt);
  for(int x : {-1,1}) for(int y : {-1,1}) {
    Behavior b;b.idle(0);
    ActionCommand c;c.seq=1;c.action=Action::LookAt;c.duration=250;
    c.pan=x*.08f;c.tilt=y*.06f;c.receivedAt=0;
    assert(b.accept(c,0));
    for(unsigned t=20;t<=200;t+=20)b.update(t);
    auto target=servoHeadTarget(std::lround(b.pan*10),std::lround(b.tilt*10));
    assert(target.yaw*x>0);assert((target.pitch-450)*y>0);
    assert(std::abs(target.yaw)<=300&&target.pitch>=300&&target.pitch<=600);
  }
  auto center=servoHeadTarget(0,0);assert(center.yaw==0&&center.pitch==450);
}
