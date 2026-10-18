import { serializeClient, isDetection } from "../../back/src/protocol";
import type { ClientMessage } from "../../back/src/protocol";
import { parseMessage } from "./protocol";
import type { Emotion, Mind, Behavior, Decision, Face } from "./protocol";
export type Log = { id: string; timestamp: number; data: Decision };
export type RobotState = {
  connection: "connecting" | "connected" | "retrying" | "offline" | "error";
  online: boolean;
  role: "viewer" | "controller" | null;
  stream: string | null;
  frame: number | null;
  width: number;
  height: number;
  lastFrame: number;
  faces: Face[];
  primary: number | null;
  vision: "loading" | "ready" | "error";
  emotion: Emotion | null;
  mind: Mind | null;
  behavior: Behavior | null;
  logs: Log[];
  notice: string;
  mode: "mock" | "decisions" | null;
  paidActive: boolean | null;
  paidReason: string | null;
  paidCallsUsed: number | null;
  paidCallsMax: number | null;
};
const initial = (): RobotState => ({
  connection: "connecting",
  online: false,
  role: null,
  stream: null,
  frame: null,
  width: 320,
  height: 240,
  lastFrame: 0,
  faces: [],
  primary: null,
  vision: "loading",
  emotion: null,
  mind: null,
  behavior: null,
  logs: [],
  notice: "",
  mode: null,
  paidActive: null,
  paidReason: null,
  paidCallsUsed: null,
  paidCallsMax: null,
});
const ident = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const query = new URLSearchParams(location.search);
export const room = query.get("room") || "main";
const requestedDevice = query.get("device_id");
export class RobotConnection {
  state = initial();
  listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private abort: AbortController | null = null;
  private stopped = true;
  private attempts = 0;
  private generation = 0;
  private order = 0;
  private displayed = 0;
  private decoding = false;
  private detecting = false;
  private detectAt = 0;
  private videoRecoveryAttempted = false;
  private pending: {
    bytes: ArrayBuffer;
    frame: number;
    key: number;
    stream: string;
    generation: number;
  } | null = null;
  private device = "";
  private control = query.get("control") === "1";
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  setCanvas = (canvas: HTMLCanvasElement | null) => {
    this.canvas = canvas;
  };
  private patch(patch: Partial<RobotState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  start = () => {
    if (!this.stopped) return;
    this.stopped = false;
    this.worker = new Worker("/vision/face-worker.js");
    this.worker.onmessage = (event) => {
      if (this.stopped) return;
      const d = event.data;
      if (d.type === "ready") {
        this.patch({ vision: "ready" });
        return;
      }
      if (d.type === "error") {
        this.patch({ vision: "error" });
        return;
      }
      this.detecting = false;
      if (d.type === "failed") {
        this.patch({ vision: "error", faces: [], primary: null });
        return;
      }
      if (
        d.type !== "result" ||
        d.generation !== this.generation ||
        d.stream !== this.state.stream ||
        d.key !== this.displayed ||
        !this.state.online
      )
        return;
      const detection = {
        stream_id: d.stream,
        frame_id: d.frame,
        faces: d.faces,
        primary_face_id: d.primary,
      };
      if (!isDetection(detection)) return;
      this.patch({
        faces: detection.faces,
        primary: detection.primary_face_id,
      });
      if (this.state.role === "controller")
        this.send({
          type: "detection",
          timestamp: Date.now(),
          data: detection,
        });
    };
    this.worker.onerror = () => {
      this.detecting = false;
      this.patch({ vision: "error", faces: [], primary: null });
    };
    this.worker.postMessage({ type: "init", origin: location.origin });
    this.health();
    this.healthTimer = setInterval(() => this.health(), 5000);
    this.connect();
  };
  stop = () => {
    this.stopped = true;
    this.generation++;
    this.pending = null;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearInterval(this.healthTimer);
    this.abort?.abort();
    this.ws?.close(1000);
    this.ws = null;
    this.worker?.terminate();
    this.worker = null;
    this.detecting = false;
  };
  retry = () => {
    this.attempts = 0;
    this.connect();
  };
  private async health() {
    try {
      const r = await fetch("/health", {
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (!r.ok) return;
      const h = await r.json();
      if (!this.stopped && ["mock", "decisions"].includes(h.ai_mode))
        this.patch({
          mode: h.ai_mode,
          paidActive: h.paid_session?.active ?? null,
          paidReason: h.paid_session?.reason ?? null,
          paidCallsUsed: Number.isFinite(h.paid_session?.used_calls) ? h.paid_session.used_calls : null,
          paidCallsMax: Number.isFinite(h.paid_session?.max_calls) ? h.paid_session.max_calls : null,
        });
      if (
        !this.stopped &&
        document.visibilityState === "visible" &&
        this.state.connection === "connected" &&
        this.state.online &&
        this.state.lastFrame > 0 &&
        Date.now() - this.state.lastFrame >= 10000 &&
        !this.videoRecoveryAttempted
      ) {
        this.videoRecoveryAttempted = true;
        this.connect();
        this.patch({ notice: "映像が止まったため、ビューアを再接続しています。" });
      }
    } catch {
      /* WS state is authoritative for connectivity. */
    }
  }
  private clearStream() {
    this.generation++;
    this.pending = null;
    this.displayed = 0;
    this.canvas
      ?.getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.patch({
      stream: null,
      frame: null,
      lastFrame: 0,
      faces: [],
      primary: null,
      behavior: null,
    });
  }
  private send(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN && this.state.role)
      this.ws.send(serializeClient(message));
  }
  private async connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const old = this.ws;
    this.ws = null;
    old?.close(1000);
    this.clearStream();
    this.patch({
      connection: this.attempts ? "retrying" : "connecting",
      online: false,
      role: null,
      notice: "",
      emotion: null,
      mind: null,
      logs: [],
    });
    if (
      !ident.test(room) ||
      (requestedDevice !== null && !ident.test(requestedDevice))
    ) {
      this.patch({
        connection: "error",
        notice: "room または device_id の形式が正しくありません。",
      });
      return;
    }
    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(room)}/devices`,
        {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          cache: "no-store",
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? "バックエンドの公開設定が完了していません。"
            : response.status === 404
              ? "指定したルームが見つかりません。"
              : `デバイス一覧を取得できませんでした (${response.status})。`,
        );
      const data = await response.json();
      if (!Array.isArray(data.devices))
        throw new Error("デバイス一覧の形式が正しくありません。");
      const devices = data.devices.filter(
        (d: unknown): d is { device_id: string; online: boolean } =>
          typeof d === "object" &&
          d !== null &&
          "device_id" in d &&
          typeof d.device_id === "string" &&
          ident.test(d.device_id) &&
          "online" in d &&
          typeof d.online === "boolean",
      );
      const device = requestedDevice
        ? devices.find(
            (d: { device_id: string }) => d.device_id === requestedDevice,
          )
        : devices.find(
            (d: { device_id: string }) => d.device_id === this.device,
          ) ||
          devices.find((d: { online: boolean }) => d.online) ||
          devices[0];
      if (!device)
        throw new Error(
          requestedDevice
            ? "指定したスタックチャンは登録されていません。"
            : "このルームにはスタックチャンが登録されていません。",
        );
      if (this.stopped || abort.signal.aborted) return;
      this.device = device.device_id;
      const url = new URL("/ws/viewer", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.search = new URLSearchParams({
        room,
        device_id: this.device,
        ...(this.control ? { control: "1" } : {}),
      }).toString();
      const ws = (this.ws = new WebSocket(url));
      ws.binaryType = "arraybuffer";
      // A hanging upgrade/session must not leave the screen connecting forever.
      this.timer = setTimeout(() => {
        if (this.ws === ws && !this.state.role) ws.close();
      }, 8000);
      ws.onmessage = (event) => {
        if (this.ws !== ws || this.stopped) return;
        if (event.data instanceof ArrayBuffer) {
          this.receiveFrame(event.data);
          return;
        }
        if (typeof event.data !== "string") return;
        const m = parseMessage(event.data);
        if (!m) return;
        switch (m.type) {
          case "session":
            if (
              m.data.room !== room ||
              m.data.device_id !== this.device ||
              m.data.role === "device" ||
              (this.control && m.data.role !== "controller")
            ) {
              ws.close(1008);
              return;
            }
            clearTimeout(this.timer);
            this.attempts = 0;
            this.patch({
              connection: "connected",
              role: m.data.role,
              notice: "",
            });
            if (m.data.role === "controller")
              this.heartbeat = setInterval(
                () =>
                  this.send({
                    type: "heartbeat",
                    timestamp: Date.now(),
                    data: {},
                  }),
                5000,
              );
            break;
          case "stream":
            this.clearStream();
            this.patch({ stream: m.data.stream_id });
            break;
          case "device_status":
            this.patch({ online: m.data.online });
            if (!m.data.online) this.clearStream();
            break;
          case "emotion":
            this.patch({ emotion: m.data });
            break;
          case "mind":
            if (m.data.device_id === this.device) this.patch({ mind: m.data });
            break;
          case "behavior":
            if (m.data === null || m.data.device_id === this.device)
              this.patch({ behavior: m.data });
            break;
          case "decision":
            if (m.data.stream_id !== this.state.stream) break;
            this.patch({
              logs: [
                {
                  id: `${this.generation}:${m.data.stream_id}:${m.data.frame_id}`,
                  timestamp: m.timestamp,
                  data: m.data,
                },
                ...this.state.logs,
              ].slice(0, 20),
            });
            break;
          case "error":
            this.patch({ notice: `通信エラー: ${m.data.message}` });
            break;
        }
      };
      ws.onclose = (event) => {
        if (this.ws !== ws || this.stopped) return;
        this.ws = null;
        clearInterval(this.heartbeat);
        clearTimeout(this.timer);
        this.clearStream();
        this.patch({
          online: false,
          role: null,
          emotion: null,
          mind: null,
          connection: "offline",
        });
        const terminal = [1000, 1008, 1009, 4001, 4003].includes(event.code);
        const message =
          event.code === 4001
            ? "別の接続に置き換えられました。"
            : event.code === 4003
              ? "操作セッションの期限が切れました。設定画面から再認証してください。"
              : terminal
                ? `接続が終了しました (${event.code})。`
                : this.control
                  ? "操作接続に失敗しました。認証期限・他の操作接続を確認してください。"
                  : "接続が途切れました。";
        this.schedule(message, terminal);
      };
      ws.onerror = () => {
        /* onclose handles bounded retries and browser-hidden upgrade errors. */
      };
    } catch (error) {
      if (this.stopped || abort.signal.aborted) return;
      this.schedule(
        error instanceof Error ? error.message : "接続に失敗しました。",
      );
    }
  }
  private schedule(message: string, terminal = false) {
    if (terminal || this.attempts >= 3) {
      this.patch({ connection: "error", notice: message });
      return;
    }
    const delay =
      Math.min(10000, 1000 * 2 ** this.attempts++) + Math.random() * 300;
    this.patch({
      connection: "retrying",
      notice: `${message} 再接続しています…`,
    });
    this.timer = setTimeout(() => this.connect(), delay);
  }
  private receiveFrame(bytes: ArrayBuffer) {
    if (
      !this.state.stream ||
      !this.state.role ||
      bytes.byteLength < 8 ||
      bytes.byteLength > 256 * 1024
    )
      return;
    this.videoRecoveryAttempted = false;
    const b = new Uint8Array(bytes);
    if (
      b[4] !== 255 ||
      b[5] !== 216 ||
      b[b.length - 2] !== 255 ||
      b[b.length - 1] !== 217
    )
      return;
    const frame = new DataView(bytes).getUint32(0, false);
    this.pending = {
      bytes,
      frame,
      stream: this.state.stream,
      generation: this.generation,
      key: ++this.order,
    };
    void this.drawLatest();
  }
  private async drawLatest() {
    if (this.decoding) return;
    this.decoding = true;
    try {
      while (this.pending && !this.stopped) {
        const item = this.pending;
        this.pending = null;
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(
            new Blob([item.bytes.slice(4)], { type: "image/jpeg" }),
          );
        } catch {
          this.patch({
            notice: "映像を読み込めませんでした。次のフレームを待っています。",
          });
          continue;
        }
        if (
          this.stopped ||
          item.generation !== this.generation ||
          this.pending ||
          !this.canvas
        ) {
          bitmap.close();
          continue;
        }
        const ctx = this.canvas.getContext("2d");
        if (!ctx) {
          bitmap.close();
          this.patch({ notice: "映像キャンバスを初期化できませんでした。" });
          continue;
        }
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        this.send({
          type: "frame_ack",
          timestamp: Date.now(),
          data: { stream_id: item.stream, frame_id: item.frame },
        });
        this.displayed = item.key;
        this.patch({
          frame: item.frame,
          width: bitmap.width,
          height: bitmap.height,
          lastFrame: Date.now(),
          faces: [],
          primary: null,
        });
        if (
          this.worker &&
          this.state.vision === "ready" &&
          !this.detecting &&
          performance.now() - this.detectAt >= 500
        ) {
          this.detecting = true;
          this.detectAt = performance.now();
          this.worker.postMessage(
            {
              type: "detect",
              bitmap,
              key: item.key,
              generation: item.generation,
              stream: item.stream,
              frame: item.frame,
            },
            [bitmap],
          );
        } else bitmap.close();
      }
    } finally {
      this.decoding = false;
    }
  }
}
