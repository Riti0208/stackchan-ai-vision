/** FE / BE / FW wire contract, viewer protocol_version=1, device protocol_version=2. No Worker or Node runtime dependencies.
 * Timestamps and durations are milliseconds; angles are normalized [-1,1], not degrees.
 * TypeScript types do not validate JSON: use the parsers at the network boundary.
 */
import type { APIDebug } from './api-debug.ts';
import type { CallMetrics } from './openai.ts';
import type { APISample, Stage, snapshot } from './telemetry.ts';
export const actions = ['idle', 'look_at', 'nod', 'shake', 'happy'] as const;
export const expressions = ['neutral', 'happy', 'sad', 'surprised', 'thinking', 'sleepy', 'love', 'wink', 'angry', 'excited', 'embarrassed', 'confused', 'curious', 'relaxed', 'crying', 'tired', 'proud', 'laughing'] as const;
export const headActions = ['left', 'right', 'up', 'down', 'center', 'resume'] as const;
export type HeadAction = typeof headActions[number];
export type HeadResponse = { ok: true; device_id: string; pan: number; tilt: number; seq: number; manual_until: number };
export function isHeadCommand(value: unknown): value is { action: HeadAction } {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'action') && headActions.includes((value as { action: HeadAction }).action);
}
export type Action = typeof actions[number];
export type Expression = typeof expressions[number];
export type Role = 'device' | 'viewer' | 'controller';
export type Personality = 'curious' | 'shy' | 'cheerful' | 'calm' | 'cautious' | 'playful';
export type Intent = 'observe' | 'greet' | 'engage' | 'avert' | 'rest' | 'acknowledge_person' | 'delight';
export type Target = {
    kind: 'person' | 'device' | 'none';
    device_id: string | null;
};
/** BE -> FW only: safe bounded command; no private thought or peer inner state. */
export type Motion = {
    seq: number;
    action: Action;
    pan: number;
    tilt: number;
    expression: Expression;
    duration_ms: number;
};
/** Scores describe the fictional robot's feelings, in [0,1]. */
export type Emotion = Record<'happiness' | 'curiosity' | 'excitement' | 'shyness' | 'trust', number>;
export type Generation = {
    provider: 'openai' | 'mock' | 'fallback';
    model: 'gpt-6-luna' | null;
    reason: 'api_error' | 'cooldown' | 'rate_limit' | null;
};
/** BE -> this device's FE only. Never forward to another robot's model context. */
export type Mind = {
    device_id: string;
    revision: number;
    personality: Personality;
    intent: Intent;
    target: Target;
    thought: string;
    generation: Generation | null;
    relationships: Record<string, number>;
    cause: {
        kind: 'observation' | 'dialogue' | 'human_action';
        message_id: string | null;
        event_id?: string;
    };
    valid_until: number;
};
export type Behavior = {
    device_id: string;
    mind_revision: number;
    display_text: string;
    command: Motion;
    issued_at: number;
};
/** Public dialogue only; no private thoughts. Stream IDs prevent stale delivery on reconnect. */
export type Dialogue = {
    id: string;
    room: string;
    from_device_id: string;
    to_device_id: string;
    from_stream_id: string;
    to_stream_id: string;
    reply_to: string | null;
    speech_act: 'greet' | 'acknowledge';
    text: string;
    created_at: number;
    expires_at: number;
};
export type HumanActionChange = 'person_appeared' | 'person_left' | 'hand_raised' | 'smile_started' | 'frown_started' | 'eyes_widened' | 'mouth_opened' | 'tears_appeared' | 'looked_at_robot';
export type HumanActionEvent = {
    id: string;
    stream_id: string;
    frame_id: number;
    observed_at: number;
    expires_at: number;
    changes: HumanActionChange[];
};
export type Observation = Record<'person_present' | 'smiling' | 'looking_at_robot' | 'waving' | 'frowning' | 'eyes_wide' | 'mouth_open' | 'tears_visible', number> & {
    apparent_expression: {
        label: 'smiling' | 'sad_looking' | 'tense_looking' | 'surprised_looking' | 'neutral' | 'unclear';
        confidence: number;
    };
};
export type Affect = {
    provider: 'openai' | 'mock';
    model: 'gpt-6-luna' | null;
    previous_emotion: Emotion;
    confidence: Emotion;
    history_size: number;
    received_message_is_new: boolean;
};
export type DeviceStatus = {
    online: boolean;
    fps: number;
    wifi_rssi: number | null;
    battery: number | null;
    current_action: Action;
    face_version?: 1 | 2;
    transport?: {
        upload_rtt_ms: number | null;
    };
};
/** Normalized face rectangle [0,1]; largest area wins, ties use the smallest id. */
export type Face = {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
};
export type Detection = {
    stream_id: string;
    frame_id: number;
    faces: Face[];
    primary_face_id: number | null;
};
export type Empty = Record<string, never>;
export interface ClientData {
    device_status: DeviceStatus;
    action_ack: {
        seq: number;
        accepted: boolean;
    }; // Receipt/acceptance, not physical motor completion.
    frame_ack: {
        stream_id: string;
        frame_id: number;
    };
    detection: Detection;
    heartbeat: Empty;
    telemetry_request: Empty;
    api_debug_request: { run_id: string; stage: Stage };
}
export type DeviceMessageType = 'device_status' | 'action_ack';
export type ViewerMessageType = 'frame_ack' | 'telemetry_request' | 'api_debug_request';
export type ControllerMessageType = ViewerMessageType | 'detection' | 'heartbeat';
export type TelemetrySnapshot = ReturnType<typeof snapshot>;
export type TelemetrySummary = Omit<TelemetrySnapshot, 'samples'>;
export type Decision = {
    stream_id: string;
    frame_id: number;
    observations: Observation;
    affect: Affect;
    human_action: HumanActionEvent | null;
    reaction: {
        trigger: 'human_action' | 'dialogue' | 'companion' | 'initial' | 'periodic' | 'held';
        intent_reassessed: boolean;
        command_issued: boolean;
        selected_choice: string;
        event_id: string | null;
    };
    selected_action: Action;
    confidence: number;
    mind_revision: number;
    intent: Intent;
    ai: {
        provider: 'openai' | 'mock';
        model: string | null;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        latency_ms: number;
        request_ids: string[];
        calls: CallMetrics[];
    };
};
export interface ServerData {
    session: { room: string; device_id: string; behavior_mode?: 'follow_person' | 'autonomous' } & (
        { protocol_version: 1; role: 'viewer' | 'controller' } |
        { protocol_version: 2; role: 'device'; frame_format: 'rgb565le-v2'; width: 160; height: 120 }
    );
    stream: {
        stream_id: string | null;
    };
    action: Motion;
    frame_received: {
        stream_id: string;
        frame_id: number;
    };
    error: {
        code: string;
        message: string;
        retry_after_ms?: number;
    };
    heartbeat: Empty;
    device_status: DeviceStatus;
    emotion: Emotion;
    mind: Mind;
    behavior: Behavior | null;
    dialogue: Dialogue;
    dialogue_history: {
        messages: Dialogue[];
    };
    human_action: HumanActionEvent;
    decision: Decision;
    memory: {
        scope: 'room_device';
        first_join_at: number | null;
        last_saved_at: number | null;
        experience_count: number;
        total_experiences: number;
    };
    api_activity: {
        call_id: string; run_id: string; stream_id: string; device_id: string;
        stage: Stage; endpoint: CallMetrics['endpoint']; model: string;
    } & ({ state: 'started'; started_at: number } | { state: 'completed'; sample: APISample });
    api_debug: { device_id: string; run_id: string; stage: Stage; detail: APIDebug | null };
    telemetry: TelemetrySummary;
    telemetry_snapshot: TelemetrySnapshot;
}
export type Envelope<K extends string, D> = {
    type: K;
    timestamp: number;
    data: D;
};
export type ClientMessage<K extends keyof ClientData = keyof ClientData> = {
    [T in K]: Envelope<T, ClientData[T]>;
}[K];
export type ServerMessage<K extends keyof ServerData = keyof ServerData> = {
    [T in K]: Envelope<T, ServerData[T]>;
}[K];
export type DeviceMessage = ClientMessage<DeviceMessageType>;
export type DeviceServerMessage = ServerMessage<'session' | 'action' | 'frame_received' | 'error'>;
export const clientRoles: {
    [K in keyof ClientData]: readonly Role[];
} = {
    device_status: ['device'], action_ack: ['device'], frame_ack: ['viewer', 'controller'],
    telemetry_request: ['viewer', 'controller'], api_debug_request: ['viewer'], detection: ['controller'], heartbeat: ['controller']
};
export function serializeClient(message: ClientMessage): string { return JSON.stringify(message); }
export function serializeServer<K extends keyof ServerData>(type: K, data: ServerData[K]): string { return JSON.stringify({ type, timestamp: Date.now(), data }); }
export const finite = (x: unknown, lo = 0, hi = 1): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
export const uint = (x: unknown): x is number => finite(x, 0, 0xffffffff) && Number.isInteger(x);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const action = (v: unknown): v is Action => typeof v === 'string' && (actions as readonly string[]).includes(v);
const frame = (v: Record<string, unknown>) => typeof v.stream_id === 'string' && uint(v.frame_id);
export function isDeviceStatus(v: unknown): v is DeviceStatus {
    return record(v) && typeof v.online === 'boolean' && finite(v.fps, 0, 1000) && (v.wifi_rssi === null || finite(v.wifi_rssi, -200, 100)) && (v.battery === null || finite(v.battery, 0, 100)) && action(v.current_action) && (v.face_version === undefined || v.face_version === 1 || v.face_version === 2) && (v.transport === undefined || (record(v.transport) && (v.transport.upload_rtt_ms === null || finite(v.transport.upload_rtt_ms, 0, 60000))));
}
export function isDetection(v: unknown): v is Detection {
    if (!record(v) || !frame(v) || !Array.isArray(v.faces) || v.faces.length > 10)
        return false;
    const ids = new Set<number>();
    for (const f of v.faces as unknown[]) {
        if (!record(f) || typeof f.id !== 'number' || !Number.isSafeInteger(f.id) || f.id < 0 || ids.has(f.id) || !finite(f.x) || !finite(f.y) || !finite(f.width) || !finite(f.height) || f.width <= 0 || f.height <= 0 || f.x + f.width > 1.0000001 || f.y + f.height > 1.0000001 || !finite(f.confidence))
            return false;
        ids.add(f.id);
    }
    const faces = v.faces as Face[];
    const primary = [...faces].sort((a, b) => b.width * b.height - a.width * a.height || a.id - b.id)[0];
    return v.primary_face_id === (primary?.id ?? null);
}
const validators: {
    [K in keyof ClientData]: (v: unknown) => v is ClientData[K];
} = {
    device_status: isDeviceStatus,
    action_ack: (v): v is ClientData['action_ack'] => record(v) && uint(v.seq) && typeof v.accepted === 'boolean',
    frame_ack: (v): v is ClientData['frame_ack'] => record(v) && frame(v),
    detection: isDetection,
    heartbeat: (v): v is Empty => record(v),
    telemetry_request: (v): v is Empty => record(v),
    api_debug_request: (v): v is ClientData['api_debug_request'] => record(v) && typeof v.run_id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v.run_id) && ['perception', 'intention', 'narration'].includes(v.stage as string)
};
function parseEnvelope(raw: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(raw);
        return record(v) && typeof v.type === 'string' && Number.isSafeInteger(v.timestamp) && record(v.data) ? v : null;
    }
    catch {
        return null;
    }
}
export type ClientParseResult = {
    ok: true;
    message: ClientMessage;
} | {
    ok: false;
    code: 'forbidden' | 'invalid_message' | 'invalid_status' | 'unknown_type';
    fatal: boolean;
};
/** Shape + role validation only. Lease expiry, stream freshness and frame order stay in BE. */
export function parseClientMessage(raw: string, role: Role): ClientParseResult {
    const v = parseEnvelope(raw), invalid = { ok: false, code: 'invalid_message', fatal: false } as const;
    if (!v || typeof v.type !== 'string')
        return invalid;
    if (['action', 'emotion', 'decision', 'session', 'stream', 'error', 'mind', 'behavior', 'dialogue', 'dialogue_history', 'memory', 'human_action', 'telemetry', 'telemetry_snapshot', 'frame_received', 'api_activity', 'api_debug'].includes(v.type))
        return { ok: false, code: 'forbidden', fatal: true };
    if (!Object.hasOwn(validators, v.type))
        return { ok: false, code: 'unknown_type', fatal: false };
    const name = v.type as keyof ClientData;
    if (!clientRoles[name].includes(role))
        return { ok: false, code: 'forbidden', fatal: true };
    if (!validators[name](v.data))
        return { ok: false, code: name === 'device_status' ? 'invalid_status' : 'invalid_message', fatal: false };
    // Every member was validated by its corresponding discriminator above.
    return { ok: true, message: v as ClientMessage };
}
export function isMotion(v: unknown): v is Motion {
    return record(v) && uint(v.seq) && v.seq > 0 && action(v.action) && finite(v.pan, -1, 1) && finite(v.tilt, -1, 1) && typeof v.expression === 'string' && (expressions as readonly string[]).includes(v.expression) && finite(v.duration_ms, 100, 3000) && Number.isInteger(v.duration_ms);
}
/** FW receives only public commands/session/error. Never accepts an unchecked motor command. */
export function parseDeviceServerMessage(raw: string): DeviceServerMessage | null {
    const v = parseEnvelope(raw);
    if (!v || !record(v.data))
        return null;
    const a = v.data;
    if (v.type === 'action' && isMotion(a))
        return v as DeviceServerMessage;
    if (v.type === 'frame_received' && frame(a))
        return v as DeviceServerMessage;
    if (v.type === 'session' && a.protocol_version === 2 && a.frame_format === 'rgb565le-v2' && a.width === 160 && a.height === 120 && a.role === 'device' && typeof a.room === 'string' && typeof a.device_id === 'string')
        return v as DeviceServerMessage;
    if (v.type === 'error' && typeof a.code === 'string' && typeof a.message === 'string' && (a.retry_after_ms === undefined || finite(a.retry_after_ms, 0, Number.MAX_SAFE_INTEGER)))
        return v as DeviceServerMessage;
    return null;
}
