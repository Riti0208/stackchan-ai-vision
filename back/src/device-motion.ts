import type { Motion } from './protocol.ts';
/** Keep logical BE targets unchanged; adapt yaw polarity only at the FW boundary. */
export function toDeviceMotion(command: Motion): Motion {
  return { ...command, pan: command.pan === 0 ? 0 : -command.pan };
}
