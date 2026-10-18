// Compiled by npm run typecheck: these failures must stay failures as the contract evolves.
import { serializeClient, serializeServer, type ClientMessage, type DeviceMessage, type DeviceServerMessage, type Motion } from '../src/protocol.ts';
serializeClient({ type: 'action_ack', timestamp: 0, data: { seq: 1, accepted: true } });
serializeServer('action', { seq: 1, action: 'nod', pan: 0, tilt: 0, expression: 'neutral', duration_ms: 500 });
// @ts-expect-error frame_ack must include the stream identity
serializeClient({ type: 'frame_ack', timestamp: 0, data: { frame_id: 1 } });
// @ts-expect-error message discriminant must match its payload
serializeClient({ type: 'action_ack', timestamp: 0, data: { stream_id: 's', frame_id: 1 } });
// @ts-expect-error clients cannot send a BE-only motor command
serializeClient({ type: 'action', timestamp: 0, data: {} });
// @ts-expect-error FW cannot send controller detections
const wrongRole: DeviceMessage = { type: 'detection', timestamp: 0, data: { stream_id: 's', frame_id: 1, faces: [], primary_face_id: null } };
// @ts-expect-error a private mind is not part of BE -> FW messages
const privateToFW: DeviceServerMessage = { type: 'mind', timestamp: 0, data: {} };
// @ts-expect-error physical commands cannot contain private thoughts
const leaked: Motion = { seq: 1, action: 'idle', pan: 0, tilt: 0, expression: 'neutral', duration_ms: 500, thought: 'private' };
// @ts-expect-error nonexistent action is not a valid output
serializeServer('action', { seq: 1, action: 'run', pan: 0, tilt: 0, expression: 'neutral', duration_ms: 500 });
function narrow(message: ClientMessage) {
  if (message.type === 'action_ack') {
    const accepted: boolean = message.data.accepted;
    // @ts-expect-error action_ack cannot be confused with detection
    message.data.faces;
    return accepted;
  }
}
void narrow; void wrongRole; void privateToFW; void leaked;
