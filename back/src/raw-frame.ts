import { JPEGEncoder } from './vendor/jpeg-encoder.js';
export const RAW_WIDTH = 160, RAW_HEIGHT = 120;
export const RAW_HEADER_BYTES = 16, RAW_PACKET_BYTES = RAW_HEADER_BYTES + RAW_WIDTH * RAW_HEIGHT * 2;
export const RAW_MAX_AGE_MS = 3000;
export const deviceSession = { protocol_version: 2, frame_format: 'rgb565le-v2', width: RAW_WIDTH, height: RAW_HEIGHT } as const;
export type RawFrame = { id: number; pixels: Uint8Array };
export function parseRawFrame(raw: ArrayBuffer): RawFrame | null {
  if (raw.byteLength !== RAW_PACKET_BYTES) return null;
  const b = new Uint8Array(raw), v = new DataView(raw);
  if (b[0] !== 83 || b[1] !== 67 || b[2] !== 70 || b[3] !== 87 || b[4] !== 2 || b[5] !== 1 ||
      v.getUint16(6) !== RAW_WIDTH || v.getUint16(8) !== RAW_HEIGHT || v.getUint16(14) !== 0) return null;
  return { id: v.getUint32(10), pixels: b.subarray(RAW_HEADER_BYTES) };
}
// Lazily allocate only after an authenticated, valid frame. Synchronous encoder calls
// cannot overlap in an isolate. The reusable scratch/table state contains no history.
let encoder: JPEGEncoder | undefined, rgba: Uint8Array | undefined;
export function encodeRawFrame(frame: RawFrame): Uint8Array {
  if (frame.pixels.length !== RAW_WIDTH * RAW_HEIGHT * 2) throw new Error('invalid_raw_frame');
  encoder ??= new JPEGEncoder(75); rgba ??= new Uint8Array(RAW_WIDTH * RAW_HEIGHT * 4);
  for (let i = 0, j = 0; i < frame.pixels.length; i += 2, j += 4) {
    const value = frame.pixels[i] | frame.pixels[i + 1] << 8;
    const r = value >>> 11, g = value >>> 5 & 63, b = value & 31;
    rgba[j] = r << 3 | r >>> 2; rgba[j + 1] = g << 2 | g >>> 4; rgba[j + 2] = b << 3 | b >>> 2; rgba[j + 3] = 255;
  }
  const jpeg = encoder.encode({ width: RAW_WIDTH, height: RAW_HEIGHT, data: rgba }, 75);
  const packet = new Uint8Array(4 + jpeg.length); new DataView(packet.buffer).setUint32(0, frame.id); packet.set(jpeg, 4);
  return packet;
}
/** One pending value per authorized device. Replacing a value retains send-order fairness. */
export class LatestFrames<T> {
  private pending = new Map<string, T>();
  put(key: string, frame: T): boolean { const replaced = this.pending.has(key); this.pending.set(key, frame); return replaced; }
  cancel(key: string): boolean { return this.pending.delete(key); }
  take(): T | undefined {
    const first = this.pending.entries().next().value;
    if (!first) return undefined;
    this.pending.delete(first[0]); return first[1];
  }
  get size() { return this.pending.size; }
}
