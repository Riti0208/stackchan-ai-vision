/** Bounds image messages already sent to a viewer, without retaining their payloads.
 * ACKs are cumulative in send order, including across uint32 frame-ID wraparound.
 */
export const VIEWER_MAX_FRAMES = 120;
export const VIEWER_MAX_BYTES = 8 * 1024 * 1024;
export const VIEWER_ACK_TIMEOUT_MS = 2000;
export class FrameWindow {
  private frames = new Map<number, { at: number; bytes: number }>();
  private bytes = 0;
  expired(now: number): boolean {
    const oldest = this.frames.values().next().value;
    return oldest !== undefined && now - oldest.at >= VIEWER_ACK_TIMEOUT_MS;
  }
  canSend(bytes: number, now: number): boolean {
    return !this.expired(now) && this.frames.size < VIEWER_MAX_FRAMES && this.bytes + bytes <= VIEWER_MAX_BYTES;
  }
  sent(id: number, bytes: number, now: number) {
    this.frames.set(id, { at: now, bytes }); this.bytes += bytes;
  }
  acknowledge(id: number, now: number): number | undefined {
    const frame = this.frames.get(id);
    if (!frame) return undefined;
    for (const [key, value] of this.frames) {
      this.bytes -= value.bytes; this.frames.delete(key);
      if (key === id) break;
    }
    return now - frame.at;
  }
  clear() { this.frames.clear(); this.bytes = 0; }
}
