/* Local-only native acceptance for the single Mimi presence (macOS).
 * Needs Accessibility (to post input) and Screen Recording (window captures)
 * for the calling terminal. It moves the real pointer, so it is never run in CI.
 *
 * Boundaries, all recorded in the receipt:
 * - WindowServer on-screen list (CGWindowList) of the owned test process: the
 *   compositor's own view of which windows are on screen, sampled every 5 ms.
 * - Per-window captures (`screencapture -l`) of the owned Mimi windows only,
 *   never full frames, so other applications' content is not recorded.
 * - Native pointer/keyboard events are posted only inside an owned fullscreen
 *   Space, and only after the window stack at that point shows the owned Mimi
 *   with nothing but click-through overlays above it.
 * - No CUA driver, no capture through the CUA channel, no model calls, and no
 *   ⌘⇧Esc (a live CodeShell host may own that same global shortcut).
 * Build Desktop first, then:
 * node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-mimi-presence-native.mjs
 */
/* global window */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  assertOfflinePluginBootstrapHeld,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";

const run = promisify(execFile);
assert.equal(process.platform, "darwin", "Native Mimi acceptance requires macOS");
assert.equal(
  process.env.CODE_SHELL_TEST_HOME,
  join(process.env.HOME, ".code-shell"),
  "Use scripts/run-isolated-node-smoke.mjs so the fixture never inherits provider credentials",
);
const args = process.argv.slice(2);
let receiptArg;
for (let index = 0; index < args.length; index++) {
  assert.equal(args[index], "--receipt", `Unknown option ${args[index]}`);
  receiptArg = args[++index];
}
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await access(join(appDir, "out/main/index.mjs")).catch(() => {
  throw Error("Build Desktop before this acceptance run");
});
const isolated = await makeIsolatedElectronHome("codeshell-mimi-native-");
const receiptPath = receiptArg
  ? resolve(receiptArg)
  : join(appDir, "out", `mimi-presence-native-${Date.now()}.json`);
const evidenceDir = `${receiptPath.replace(/\.json$/, "")}-captures`;
const probePath = join(isolated.home, "mimi-window-server-probe");
const receipt = {
  schemaVersion: 1,
  boundary:
    "WindowServer on-screen list + per-window captures of owned Mimi windows + native input inside an owned fullscreen Space. No CUA capture channel, no ⌘⇧Esc, single built-in display only.",
  passed: false,
  checks: [],
  gaps: [],
};
const rendererErrors = [];
let model, app, monitor, main, cursor;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const probe = async (...probeArgs) =>
  JSON.parse((await run(probePath, probeArgs.map(String))).stdout.trim());
async function until(check, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(80);
  }
  throw Error(`${label} (last: ${JSON.stringify(last)})`);
}

/** Minimal PNG (8-bit RGBA, non-interlaced) decoder → opaque pixel bbox/count. */
function opaquePixels(png) {
  assert.equal(png.readUInt32BE(12), 0x49484452, "PNG IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png[24];
  const color = png[25];
  assert.ok(depth === 8 && (color === 6 || color === 2), `Unsupported PNG ${depth}/${color}`);
  const channels = color === 6 ? 4 : 3;
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const data = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  let count = 0;
  const box = { left: width, top: height, right: -1, bottom: -1 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = channels === 4 ? pixels[(y * width + x) * 4 + 3] : 255;
      if (alpha <= 32) continue;
      count++;
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
  return { width, height, count, box: count ? box : null };
}

async function captureWindow(id, name) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const file = join(evidenceDir, `${name}.png`);
  await run("screencapture", ["-x", "-o", `-l${id}`, file]);
  return { file, ...opaquePixels(await readFile(file)) };
}

const pid = () => app.process().pid;
/** Owned Mimi windows on screen per WindowServer, classified by size. */
async function ownedMimi(display) {
  const windows = await probe("list", pid());
  return windows
    .map((win) => ({
      ...win,
      form:
        (win.width === 112 && win.height === 112) || (win.width === 400 && win.height === 380)
          ? "docked"
          : win.width === display.bounds.width &&
              win.height === display.bounds.height &&
              win.layer > 0
            ? "moving"
            : null,
    }))
    .filter((win) => win.form);
}
async function shown(display, form) {
  return until(async () => {
    const snapshot = await main.evaluate(() => window.codeshell.pet.getPresence());
    const forms = await ownedMimi(display);
    return snapshot.shown === form &&
      forms.length === (form ? 1 : 0) &&
      (!form || forms[0].form === form)
      ? (forms[0] ?? true)
      : false;
  }, `WindowServer never showed exactly ${form}`);
}
/** Post input only where the owned window is reachable through click-through overlays. */
async function safePoint(x, y, ownedId) {
  const stack = await probe("stack", Math.round(x), Math.round(y));
  const index = stack.findIndex((hit) => hit.id === ownedId);
  assert.ok(
    index >= 0,
    `Owned window ${ownedId} is not under (${x}, ${y}): ${JSON.stringify(stack)}`,
  );
  for (const hit of stack.slice(0, index)) {
    const overlay = hit.layer >= 1000 && hit.width >= 1000; // transparent click-through overlay
    assert.ok(
      hit.pid === pid() || overlay,
      `A foreign window covers the target: ${JSON.stringify(hit)}`,
    );
  }
  return { x: Math.round(x), y: Math.round(y), stack };
}

try {
  await run("swiftc", [
    "-O",
    "-o",
    probePath,
    join(appDir, "scripts", "mimi-window-server-probe.swift"),
  ]);
  const permissions = {
    accessibility: (await probe("trusted")).trusted,
    screenRecording: (await probe("capture-access")).granted,
  };
  receipt.permissions = permissions;
  assert.ok(permissions.accessibility, "The calling terminal needs Accessibility permission");
  assert.ok(permissions.screenRecording, "The calling terminal needs Screen Recording permission");
  cursor = await probe("cursor");

  model = await startMockProviderServer();
  const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: false } }),
  );
  app = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: fixture.env,
      runtimeTimeoutMs: 240_000,
    },
    { watch: (child, settings) => (monitor = watchElectronTestProcess(child, settings)) },
  );
  await findCodeShellWindow(app);
  main = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  rendererErrors.push(captureRendererErrors(main));
  await main.waitForFunction(() => !!window.codeshell?.pet?.getPresence);
  const trust = main.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ state: "visible", timeout: 4_000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  await main.waitForFunction(
    async () => (await window.codeshell.pet.getPresence()).movingAvailable,
  );
  const display = await app.evaluate(({ screen }) => ({
    displays: screen.getAllDisplays().map(({ id, bounds, scaleFactor, internal }) => ({
      id,
      bounds,
      scaleFactor,
      internal,
    })),
    bounds: screen.getPrimaryDisplay().bounds,
    workArea: screen.getPrimaryDisplay().workArea,
  }));
  receipt.display = display;
  if (display.displays.length < 2)
    receipt.gaps.push(
      "Only one display is attached: multi-display, hot-unplug and mixed-DPI not exercised",
    );
  else if (new Set(display.displays.map((item) => item.scaleFactor)).size < 2)
    receipt.gaps.push("Displays share one scale factor: mixed-DPI not exercised");

  // An owned fullscreen Space: everything the pointer can reach there is ours
  // or an all-Spaces click-through overlay.
  await app.evaluate(async ({ BrowserWindow }) => {
    const backdrop = new BrowserWindow({
      show: false,
      backgroundColor: "#2d4a6b",
      title: "Mimi native acceptance backdrop",
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    globalThis.__mimiBackdrop = backdrop;
    await backdrop.loadURL(
      "data:text/html,<body style='margin:0;background:%232d4a6b;color:white;font:24px system-ui;display:grid;place-items:center;height:100vh'>Mimi native acceptance (owned test window)</body>",
    );
    backdrop.show();
    backdrop.setFullScreen(true);
  });
  await until(
    () => app.evaluate(() => globalThis.__mimiBackdrop.isFullScreen()),
    "Backdrop did not enter fullscreen",
  );
  await sleep(1500); // Space transition animation
  await probe("move", display.bounds.width / 2, display.bounds.height / 2);

  // 1. Docked in the fullscreen Space, as WindowServer and its own pixels show it.
  await main.evaluate(() => window.codeshell.pet.setPresence({ visible: true, mode: "docked" }));
  const docked = await shown(display, "docked");
  const dockedPixels = await captureWindow(docked.id, "docked");
  assert.ok(dockedPixels.count > 500, `Docked window rendered no pet: ${dockedPixels.count}`);
  receipt.docked = { window: docked, pixels: dockedPixels };
  receipt.checks.push(
    "fullscreen Space: docked on screen (WindowServer) with rendered pet pixels; moving absent",
  );

  // 2. Native right-click on the docked pet opens its native menu; keyboard picks "switch to moving".
  const widget = await until(
    () => app.windows().find((page) => page.url().includes("popout=pet")),
    "Docked renderer not found",
  );
  await widget.evaluate(() => {
    window.__mimiContextMenus = 0;
    window.addEventListener("contextmenu", () => window.__mimiContextMenus++, true);
  });
  const dockedPoint = await safePoint(docked.x + 56, docked.y + 56, docked.id);
  receipt.dockedPoint = dockedPoint;
  await probe("move", dockedPoint.x, dockedPoint.y);
  await sleep(200);
  await probe("click", dockedPoint.x, dockedPoint.y, "right");
  const nativeMenu = await until(async () => {
    const windows = await probe("list", pid());
    return windows.find((win) => win.layer !== 1000 && win.layer > 0 && win.height > 40);
  }, "Native docked context menu did not open").catch(async (error) => {
    receipt.dockedMenuDiagnostics = {
      rendererContextMenus: await widget.evaluate(() => window.__mimiContextMenus),
      ownedWindows: await probe("list", pid()),
    };
    throw error;
  });
  receipt.dockedMenu = nativeMenu;
  await probe("key", "down");
  await sleep(120);
  await probe("key", "down");
  await sleep(120);
  await probe("key", "return");
  const moving = await shown(display, "moving");
  receipt.checks.push(
    "native right-click on docked opens its native menu; native keys choose moving; docked withdrawn first",
  );

  // 3. Moving: own pixels and a native right-click → DOM menu → native click "switch to docked".
  const overlay = await until(
    () =>
      app.windows().find((page) => new URL(page.url()).pathname.endsWith("/mimi-companion.html")),
    "Companion renderer not found",
  );
  rendererErrors.push(captureRendererErrors(overlay));
  const body = overlay.getByRole("button", { name: "打开 Mimi 聊天，拖动可移动" });
  await body.waitFor({ state: "visible" });
  const bodyBox = await body.boundingBox();
  const state = await overlay.evaluate(() => window.mimiCompanion.getState());
  receipt.moving = { window: moving, size: state.size, bodyBox };
  assert.equal(state.size, 200, "Default moving size is 200 DIP");
  const movingPixels = await captureWindow(moving.id, "moving");
  assert.ok(movingPixels.count > 500, `Companion rendered no character: ${movingPixels.count}`);
  // The character's opaque pixels stay inside its 0.7×200 box (plus label), in device pixels.
  const scale = movingPixels.width / display.bounds.width;
  const allowed = {
    left: (state.position.x - 8) * scale,
    right: (state.position.x + state.size * 0.7 + 8) * scale,
    top: (state.position.y - 60) * scale,
    bottom: (state.position.y + state.size + 40) * scale,
  };
  assert.ok(
    movingPixels.box.left >= allowed.left &&
      movingPixels.box.right <= allowed.right &&
      movingPixels.box.top >= allowed.top &&
      movingPixels.box.bottom <= allowed.bottom,
    `Character pixels ${JSON.stringify(movingPixels.box)} outside ${JSON.stringify(allowed)}`,
  );
  receipt.moving.pixels = movingPixels;
  receipt.moving.drawnDipHeight = Math.round(
    (movingPixels.box.bottom - movingPixels.box.top) / scale,
  );
  receipt.checks.push(
    "moving on screen in the fullscreen Space; its pixels fit the 200 DIP box (0.7× wide); docked absent",
  );

  const bodyPoint = await safePoint(
    moving.x + bodyBox.x + bodyBox.width / 2,
    moving.y + bodyBox.y + bodyBox.height * 0.45,
    moving.id,
  );
  await probe("move", bodyPoint.x, bodyPoint.y);
  await sleep(250);
  await probe("click", bodyPoint.x, bodyPoint.y, "right");
  const menuItem = overlay.getByRole("menuitem", { name: "切换到停靠模式" });
  await menuItem.waitFor({ state: "visible", timeout: 5_000 });
  const itemBox = await menuItem.boundingBox();
  const itemPoint = await safePoint(
    moving.x + itemBox.x + itemBox.width / 2,
    moving.y + itemBox.y + itemBox.height / 2,
    moving.id,
  );
  await probe("click", itemPoint.x, itemPoint.y);
  await shown(display, "docked");
  receipt.checks.push(
    "native right-click hits the moving character; native click on its menu docks Mimi",
  );

  // 4. Rapid interleaved switching while WindowServer is sampled every 5 ms.
  const sampling = probe("sample", pid(), 7000, 5, display.bounds.width, display.bounds.height);
  await sleep(150);
  await main.evaluate(async () => {
    const pet = window.codeshell.pet;
    for (let round = 0; round < 6; round++) {
      await pet.setPresence({ mode: "moving" });
      await pet.setPresence({ mode: "docked" });
      await Promise.all([
        pet.setPresence({ mode: "moving" }),
        pet.setWidgetVisible(false),
        pet.setPresence({ visible: true, mode: "docked" }),
        window.codeshell.computerUse.setCompanion({ enabled: true }),
      ]);
    }
    const preview = pet.previewPresence().catch(() => {});
    await pet.setPresence({ visible: false });
    await preview;
    await pet.setPresence({ visible: true, mode: "docked" });
  });
  receipt.windowServerSampling = await sampling;
  assert.ok(receipt.windowServerSampling.samples > 100);
  assert.ok(receipt.windowServerSampling.moving > 0 && receipt.windowServerSampling.docked > 0);
  assert.equal(
    receipt.windowServerSampling.both,
    0,
    "WindowServer showed docked and moving together",
  );
  receipt.checks.push(
    "WindowServer 5 ms sampling during interleaved switching: never both on screen",
  );

  receipt.gaps.push(
    "CUA screenshot hiding not exercised natively (needs the CUA driver capture channel); covered by the real-host subprocess test",
  );
  receipt.gaps.push("⌘⇧Esc not posted: the live CodeShell host may own the same global shortcut");
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error?.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (app) {
    await app
      .evaluate(async () => {
        const backdrop = globalThis.__mimiBackdrop;
        if (!backdrop || backdrop.isDestroyed()) return;
        backdrop.setFullScreen(false);
        await new Promise((done) => setTimeout(done, 1200));
        backdrop.destroy();
      })
      .catch(() => {});
    if (cursor) await probe("move", cursor.x, cursor.y).catch(() => {});
    await app.close().catch(() => monitor?.terminate());
  }
  const settlement = await monitor?.completed;
  receipt.cleanup = settlement?.status ?? "not-launched";
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (receipt.rendererErrors.length || (monitor && settlement?.status !== "cleaned")) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  await model?.close();
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome).catch(() => {});
  if (!monitor || settlement?.status === "cleaned") {
    await isolated.cleanup();
    receipt.homeRemoved = true;
  }
  await rm(probePath, { force: true }).catch(() => {});
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ phase: "mimi-native-finished", passed: receipt.passed, receipt: receiptPath }),
  );
}
