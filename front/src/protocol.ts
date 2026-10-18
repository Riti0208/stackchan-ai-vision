import {
  actions,
  finite,
  uint,
  isDeviceStatus,
  isMotion,
} from "../../back/src/protocol";
import type { ServerMessage, Emotion } from "../../back/src/protocol";
export type {
  Emotion,
  Mind,
  Behavior,
  Decision,
  Face,
  Dialogue,
  Personality,
} from "../../back/src/protocol";
export const emotionKeys = [
  "happiness",
  "curiosity",
  "excitement",
  "shyness",
  "trust",
] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const emotions = (v: unknown): v is Emotion =>
  object(v) && emotionKeys.every((k) => finite(v[k]));
const personalities = [
  "curious",
  "shy",
  "cheerful",
  "calm",
  "cautious",
  "playful",
];
const intents = [
  "observe",
  "greet",
  "engage",
  "avert",
  "rest",
  "acknowledge_person",
  "delight",
];
// Validate the fields actually consumed by this UI. Unknown events/extra fields are ignored.
export function parseMessage(raw: string): ServerMessage | null {
  if (new TextEncoder().encode(raw).length > 16384) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !object(v) ||
    !Number.isSafeInteger(v.timestamp) ||
    typeof v.type !== "string"
  )
    return null;
  const d = v.data;
  if (v.type === "behavior" && d === null) return v as ServerMessage;
  if (!object(d)) return null;
  let valid = false;
  switch (v.type) {
    case "session":
      valid =
        d.protocol_version === 1 &&
        ["viewer", "controller"].includes(String(d.role)) &&
        typeof d.room === "string" &&
        typeof d.device_id === "string";
      break;
    case "stream":
      valid = d.stream_id === null || typeof d.stream_id === "string";
      break;
    case "emotion":
      valid = emotions(d);
      break;
    case "device_status":
      valid = isDeviceStatus(d);
      break;
    case "mind":
      valid =
        typeof d.thought === "string" &&
        personalities.includes(String(d.personality)) &&
        intents.includes(String(d.intent)) &&
        typeof d.device_id === "string" &&
        Number.isSafeInteger(d.revision) &&
        (d.generation === null ||
          (object(d.generation) &&
            ["openai", "mock", "fallback"].includes(
              String(d.generation.provider),
            )));
      break;
    case "behavior":
      valid =
        typeof d.device_id === "string" &&
        typeof d.display_text === "string" &&
        Number.isSafeInteger(d.mind_revision) &&
        isMotion(d.command);
      break;
    case "decision":
      valid =
        typeof d.stream_id === "string" &&
        uint(d.frame_id) &&
        (actions as readonly unknown[]).includes(d.selected_action) &&
        finite(d.confidence) &&
        object(d.observations) &&
        [
          "person_present",
          "smiling",
          "looking_at_robot",
          "waving",
          "frowning",
          "eyes_wide",
          "mouth_open",
          "tears_visible",
        ].every((k) =>
          finite((d.observations as Record<string, unknown>)[k]),
        ) &&
        (d.human_action === null ||
          (object(d.human_action) &&
            Array.isArray(d.human_action.changes) &&
            d.human_action.changes.every((c) => typeof c === "string"))) &&
        object(d.reaction) &&
        typeof d.reaction.command_issued === "boolean" &&
        typeof d.reaction.selected_choice === "string" &&
        object(d.ai) &&
        ["mock", "openai"].includes(String(d.ai.provider));
      break;
    case "error":
      valid = typeof d.code === "string" && typeof d.message === "string";
      break;
    default:
      return null;
  }
  return valid ? (v as ServerMessage) : null;
}
