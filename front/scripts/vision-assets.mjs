import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
await rm(new URL("public/vision/", root), { recursive: true, force: true });
await mkdir(new URL("public/vision/", root), { recursive: true });
await cp(
  new URL("node_modules/@mediapipe/tasks-vision/wasm/", root),
  new URL("public/vision/", root),
  { recursive: true },
);
const model = new URL("public/models/blaze_face_short_range.tflite", root);
const expected =
  "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f";
const valid = (bytes) =>
  createHash("sha256").update(bytes).digest("hex") === expected;
let existing;
try {
  existing = await readFile(model);
} catch {}
if (!existing || !valid(existing)) {
  const url =
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new Error(`Face model download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error("Face model checksum mismatch");
  await mkdir(new URL("public/models/", root), { recursive: true });
  await writeFile(model, bytes);
}
console.log(
  `Self-hosted face detection assets ready: ${fileURLToPath(new URL("public/", root))}`,
);

// MediaPipe loads its WASM with importScripts: a classic worker is required.
await build({
  entryPoints: [fileURLToPath(new URL("src/vision.worker.ts", root))],
  outfile: fileURLToPath(new URL("public/vision/face-worker.js", root)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
});
