// A single isolated browser integration check: real Worker + mock FW, no paid API.
// Run after npm run build, with back dependencies installed. Never touches live devices.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import { Simulator } from "../../back/scripts/fw-simulator.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "http://127.0.0.1:8793";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(`${root}/front/.wrangler`, { recursive: true });
const temp = await mkdtemp(`${root}/front/.wrangler/smoke-`);
let worker, browser, sim;
let output = "";
try {
  const config = JSON.parse(
    await readFile(`${root}/back/wrangler.jsonc`, "utf8"),
  );
  assert.equal(config.assets.directory, "../front/dist");
  assert.equal(config.assets.binding, "ASSETS");
  delete config.$schema;
  delete config.build;
  config.name = "stackchan-front-smoke";
  config.main = `${root}/back/src/index.ts`;
  config.assets.directory = `${root}/front/dist`;
  config.vars = {
    AI_MODE: "mock",
    ENABLE_LAB: "false",
    ALLOWED_ORIGIN: origin,
    SESSION_SECRET: "smoke-only-signing-key",
    ROOM_CONFIG: JSON.stringify({
      main: {
        control_token: "smoke-only-controller",
        devices: { "stackchan-01": "smoke-only-device" },
      },
    }),
  };
  await writeFile(`${temp}/wrangler.jsonc`, JSON.stringify(config));
  worker = spawn(
    process.execPath,
    [
      `${root}/back/node_modules/wrangler/bin/wrangler.js`,
      "dev",
      "--local",
      "--config",
      `${temp}/wrangler.jsonc`,
      "--ip",
      "127.0.0.1",
      "--port",
      "8793",
      "--inspector-port",
      "9233",
      "--persist-to",
      `${temp}/state`,
    ],
    {
      cwd: temp,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: `${temp}/wrangler.log`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout.on("data", (d) => {
    output += d;
  });
  worker.stderr.on("data", (d) => {
    output += d;
  });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (worker.exitCode !== null) throw new Error(output);
    try {
      const h = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (h.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  assert.ok(ready, "isolated Worker started");
  sim = new Simulator({
    base: origin,
    id: "stackchan-01",
    token: "smoke-only-device",
    fps: 2,
  });
  sim.start();
  for (let n = 0; n < 40 && !sim.connected; n++) await sleep(100);
  assert.ok(sim.connected, "FW simulator authenticated");
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  const errors = [],
    sent = [],
    frames = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) external.push(r.url());
  });
  let sockets = 0;
  page.on("websocket", (ws) => {
    sockets++;
    ws.on("framesent", (e) => {
      if (typeof e.payload === "string") sent.push(JSON.parse(e.payload));
    });
    ws.on("framereceived", (e) => {
      if (Buffer.isBuffer(e.payload)) frames.push(e.payload);
    });
  });
  await page.goto(origin);
  await page.getByTestId("boot-overlay").waitFor({ state: "visible" });
  await page
    .getByTestId("boot-overlay")
    .waitFor({ state: "hidden", timeout: 13000 });
  assert.equal(
    await page.locator("main").getAttribute("inert"),
    null,
    "boot fade releases dashboard interaction",
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[role="status"]')?.textContent === "CONNECTED",
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".detector-state")?.textContent ===
      "FACE DETECTION ACTIVE",
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".activity-list li").length >= 2,
  );
  const first = await page.locator(".viewport-bottom").innerText();
  await page.waitForFunction(
    (first) =>
      document.querySelector(".viewport-bottom")?.textContent !== first,
    first,
  );
  // UI updates and image ACKs arrive independently. Wait for the fifth ACK
  // itself so slower evaluation/CI scheduling cannot race this assertion.
  const ackDeadline = performance.now() + 10000;
  while (
    sent.filter((m) => m.type === "frame_ack").length < 5 &&
    performance.now() < ackDeadline
  )
    await sleep(100);
  assert.ok(
    sent.filter((m) => m.type === "frame_ack").length >= 5,
    "viewer continuously ACKs at least five images within 10 seconds",
  );
  assert.equal(sockets, 1, "viewer stays connected; no reconnect loop");
  assert.ok(
    !sent.some((m) => ["detection", "heartbeat"].includes(m.type)),
    "public viewer never sends control input",
  );
  assert.equal(await page.getByRole("meter").count(), 5);
  assert.ok((await page.locator(".personality").innerText()) !== "性格：—");
  assert.ok(
    !(await page.getByTestId("thought").innerText()).includes("待っています"),
  );
  assert.ok(await page.locator(".behavior .action-badge").count());
  assert.equal(await page.locator(".demo-badge").innerText(), "DEMO");
  assert.equal(
    await page.locator("button,input").count(),
    0,
    "no token UI or control button in the monitor",
  );
  assert.ok(frames.length >= 5);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "desktop has no horizontal overflow",
  );
  for (const [width, height] of [
    [1512, 982],
    [1366, 768],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.evaluate(() => {
      const vision = document
        .querySelector(".vision-panel")
        .getBoundingClientRect();
      const right = document
        .querySelector(".right-column")
        .getBoundingClientRect();
      const image = document.querySelector(".viewport").getBoundingClientRect();
      const canvas = document.querySelector("canvas");
      return {
        topGap: Math.abs(vision.top - right.top),
        bottomGap: Math.abs(vision.bottom - right.bottom),
        imageRatio: image.width / image.height,
        sourceRatio: canvas.width / canvas.height,
        pageHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      };
    });
    assert.ok(
      geometry.topGap < 1 && geometry.bottomGap < 1,
      "PC panels align at top and bottom",
    );
    assert.ok(
      Math.abs(geometry.imageRatio - geometry.sourceRatio) < 0.005,
      "image and face overlays preserve source aspect ratio",
    );
    assert.equal(
      geometry.pageHeight,
      geometry.viewportHeight,
      "PC workspace fits vertically",
    );
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  // Growing to the history limit must scroll inside the panel, not grow the page.
  const historyLayout = await page.evaluate(() => {
    const panel = document.querySelector(".activity-panel");
    const list = document.querySelector(".activity-list");
    const scroll = document.querySelector(".activity-scroll");
    const original = [...list.children];
    const before = {
      panel: panel.getBoundingClientRect().height,
      page: document.documentElement.scrollHeight,
    };
    while (list.children.length < 20)
      list.append(original.at(-1).cloneNode(true));
    const after = {
      panel: panel.getBoundingClientRect().height,
      page: document.documentElement.scrollHeight,
      overflowing: scroll.scrollHeight > scroll.clientHeight,
    };
    scroll.scrollTop = scroll.scrollHeight;
    const scrolls = scroll.scrollTop > 0;
    list.replaceChildren(...original);
    return { before, after, scrolls };
  });
  assert.equal(
    historyLayout.after.panel,
    historyLayout.before.panel,
    "20 logs keep a fixed panel height",
  );
  assert.equal(
    historyLayout.after.page,
    historyLayout.before.page,
    "20 logs do not extend the page",
  );
  assert.ok(
    historyLayout.after.overflowing && historyLayout.scrolls,
    "older history scrolls inside the panel",
  );
  await mkdir(`${root}/front/test-results`, { recursive: true });
  await page.screenshot({
    path: `${root}/front/test-results/desktop.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await page.screenshot({
    path: `${root}/front/test-results/mobile.png`,
    fullPage: true,
    animations: "disabled",
  });
  // Device reconnect resets stream, image generation and boxes without reconnecting viewer.
  const oldStream = sent.filter((m) => m.type === "frame_ack").at(-1)
    .data.stream_id;
  sim.stop();
  await page.waitForFunction(
    () => document.querySelector(".live-badge")?.textContent === "STANDBY",
  );
  assert.equal(await page.locator(".face-box").count(), 0);
  assert.equal(await page.locator(".behavior .action-badge").count(), 0);
  await sim.restart();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="status"]')?.textContent === "CONNECTED",
  );
  for (
    let n = 0;
    n < 60 &&
    !sent.some((m) => m.type === "frame_ack" && m.data.stream_id !== oldStream);
    n++
  )
    await sleep(100);
  assert.ok(
    sent.some((m) => m.type === "frame_ack" && m.data.stream_id !== oldStream),
    "new stream resumes at reset frame IDs",
  );
  // Real WS disconnection and user retry, without pretending connection is healthy.
  await page.context().setOffline(true);
  await page.waitForFunction(
    () =>
      document.querySelector('[role="status"]')?.textContent !== "CONNECTED",
  );
  await page.context().setOffline(false);
  await page.waitForFunction(
    () =>
      document.querySelector('[role="status"]')?.textContent === "CONNECTED",
  );
  // The optional existing-cookie controller route uses the same real contract.
  const control = await browser.newPage();
  const controls = [];
  control.on("websocket", (ws) =>
    ws.on("framesent", (e) => {
      if (typeof e.payload === "string") controls.push(JSON.parse(e.payload));
    }),
  );
  await control.goto(origin);
  const login = await control.evaluate(async () => {
    const r = await fetch("/api/control/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "main", token: "smoke-only-controller" }),
    });
    return r.status;
  });
  assert.equal(
    login,
    200,
    "test-only operator token exchanged for HttpOnly cookie",
  );
  await control.goto(`${origin}/?control=1`);
  await control.waitForFunction(
    () =>
      document.querySelector(".detector-state")?.textContent ===
      "FACE DETECTION ACTIVE",
  );
  for (let n = 0; n < 100 && !controls.some((m) => m.type === "detection"); n++)
    await sleep(100);
  assert.ok(
    controls.some((m) => m.type === "detection"),
    "authenticated controller sends actual MediaPipe results",
  );
  assert.ok(
    controls
      .filter((m) => m.type === "detection")
      .every(
        (m) =>
          m.data.stream_id &&
          m.data.faces.every(
            (f) =>
              f.x >= 0 &&
              f.y >= 0 &&
              f.x + f.width <= 1.000001 &&
              f.y + f.height <= 1.000001,
          ),
      ),
    "detection matches bounded normalized contract",
  );
  await control.close();
  // Unregistered IDs stop with a useful message and render no invented data.
  const bad = await browser.newPage();
  await bad.goto(`${origin}/?device_id=unknown`);
  await bad.waitForSelector(".notice button", { timeout: 20000 });
  assert.match(await bad.locator(".notice").innerText(), /登録されていません/);
  assert.equal(await bad.locator(".face-box").count(), 0);
  assert.equal(await bad.locator(".emotion-value").first().innerText(), "—");
  await bad.close();
  assert.deepEqual(errors, [], "no browser JS errors");
  assert.deepEqual(
    external,
    [],
    "all runtime JS, model, WASM and fonts are same-origin",
  );
  console.log(
    "PASS: production assets + real Worker/FW relay, frame ACKs, face detector, received emotion/thought/behavior/logs, offline and new-stream recovery, responsive layout, invalid-device state. No external API calls.",
  );
} catch (error) {
  console.error(output.slice(-3500));
  throw error;
} finally {
  sim?.stop();
  await browser?.close();
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([once(worker, "exit"), sleep(3000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  await rm(temp, { recursive: true, force: true });
}
