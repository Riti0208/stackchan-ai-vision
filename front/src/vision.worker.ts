/// <reference lib="webworker" />
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Face } from "./protocol";
let detector: FaceDetector | null = null;
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event) => {
  const d = event.data;
  if (d.type === "init") {
    try {
      const vision = await FilesetResolver.forVisionTasks(`${d.origin}/vision`);
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `${d.origin}/models/blaze_face_short_range.tflite`,
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
      worker.postMessage({ type: "ready" });
    } catch (error) {
      console.warn("Face detector initialization failed:", error);
      worker.postMessage({ type: "error" });
    }
    return;
  }
  if (d.type !== "detect") return;
  const bitmap = d.bitmap as ImageBitmap;
  try {
    if (!detector) throw new Error("not ready");
    const result = detector.detect(bitmap);
    const faces: Face[] = [];
    for (const detection of result.detections.slice(0, 10)) {
      const b = detection.boundingBox;
      if (!b) continue;
      const x = Math.max(0, Math.min(1, b.originX / bitmap.width));
      const y = Math.max(0, Math.min(1, b.originY / bitmap.height));
      const width = Math.max(
        0,
        Math.min(1 - x, (b.originX + b.width) / bitmap.width - x),
      );
      const height = Math.max(
        0,
        Math.min(1 - y, (b.originY + b.height) / bitmap.height - y),
      );
      if (width <= 0 || height <= 0) continue;
      faces.push({
        id: faces.length,
        x,
        y,
        width,
        height,
        confidence: Math.max(
          0,
          Math.min(1, detection.categories[0]?.score || 0),
        ),
      });
    }
    const primary = [...faces].sort(
      (a, b) => b.width * b.height - a.width * a.height || a.id - b.id,
    )[0];
    worker.postMessage({
      type: "result",
      key: d.key,
      generation: d.generation,
      stream: d.stream,
      frame: d.frame,
      faces,
      primary: primary?.id ?? null,
    });
  } catch {
    worker.postMessage({ type: "failed", key: d.key });
  } finally {
    bitmap.close();
  }
};
