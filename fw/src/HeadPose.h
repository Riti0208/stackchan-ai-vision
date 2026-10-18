#pragma once
namespace stackchan_fw {
// Application pose: pan negative=left, tilt positive=up, in 0.1 degrees.
// On the current robot, manual L/R confirmed that negating pan reverses motion.
// Keep pitch unchanged: manual up/down was confirmed correct independently.
struct ServoHeadTarget { int yaw; int pitch; };
constexpr ServoHeadTarget servoHeadTarget(int pan, int tilt, int pitchCenter = 450) {
  return {pan, pitchCenter + tilt};
}
}
