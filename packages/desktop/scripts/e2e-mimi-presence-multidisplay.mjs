/* Local-only multi-display / mixed-DPI acceptance for the single Mimi presence (macOS).
 * Needs at least two attached displays, plus Accessibility (native input) and
 * Screen Recording (per-window captures) for the calling terminal. It moves the
 * real pointer, so it is never run in CI.
 *
 * What is real and what is not — every part is labelled in the receipt:
 * - Topology: Electron screen.getAllDisplays() matched one-to-one with
 *   CoreGraphics (CGDisplayBounds + display mode pixels) of the attached screens.
 * - Placement/switching matrix (ordinary Spaces, no native input): the production
 *   renderer IPC paths (pet.moveWidget, mimiCompanion drag messages, setPresence/
 *   previewPresence); BrowserWindow ↔ WindowServer identity via getMediaSourceId;
 *   per-window captures sized by each display's real backing scale.
 * - Cross-display drags: native CGEvent drags of the real windows, posted only
 *   inside test-owned fullscreen Spaces on every display, after the start point's
 *   window stack shows the owned Mimi in front.
 * - Topology loss: the test app's own Electron `screen` answers are replaced and
 *   `display-removed` / `display-metrics-changed` are emitted inside the test
 *   process. Real windows then move on the real displays. NO cable was unplugged
 *   and no display setting of the operator was changed.
 * - Cold restarts of the same isolated HOME restore each form on its display.
 * No CUA driver, no CUA capture channel, no ⌘⇧Esc, no model calls, no full-screen
 * or desktop captures (only owned Mimi windows), the pointer is restored at the end.
 * Build the workspace and Desktop first, then:
 * node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-mimi-presence-multidisplay.mjs --receipt <abs path>
 */
/* global window, document */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import {
  clampDockedAnchor,
  clampMovingAnchor,
  classifyOwnedWindow,
  displayIndexOf,
  dockedAnchorForFeet,
  dockedFeet,
  dockedInside,
  isUnclassifiedLarge,
  movingAnchorForFeet,
  movingFeet,
  movingInside,
  nearestDisplay,
  pixelBoxToGlobal,
} from "./mimi-multidisplay-geometry.mjs";
import { decodePng, opaquePixels } from "./mimi-window-pixels.mjs";

const run = promisify(execFile);
assert.equal(process.platform, "darwin", "Mimi multi-display acceptance requires macOS");
assert.equal(
  process.env.CODE_SHELL_TEST_HOME,
  join(process.env.HOME, ".code-shell"),
  "Use scripts/run-isolated-node-smoke.mjs so the fixture never inherits provider credentials",
);
const args = process.argv.slice(2);
let receiptArg;
let skipNative = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--skip-native") skipNative = true;
  else {
    assert.equal(args[index], "--receipt", `Unknown option ${args[index]}`);
    receiptArg = args[++index];
    assert.ok(receiptArg && !receiptArg.startsWith("--"), "Missing value for --receipt");
  }
}
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [
  "out/main/index.mjs",
  "out/preload/mimi-companion.cjs",
  "out/renderer/mimi-companion.html",
])
  await access(join(appDir, file)).catch(() => {
    throw Error(`Missing ${file}; build the workspace and Desktop before this acceptance run`);
  });

const isolated = await makeIsolatedElectronHome("codeshell-mimi-multidisplay-");
const receiptPath = receiptArg
  ? resolve(receiptArg)
  : join(appDir, "out", `mimi-presence-multidisplay-${Date.now()}.json`);
const evidenceDir = `${receiptPath.replace(/\.json$/, "")}-captures`;
const probePath = join(isolated.home, "mimi-window-server-probe");
const statePath = join(isolated.codeShellHome, "desktop", "mimi-presence.json");
const git = async (...gitArgs) =>
  (await run("git", ["-C", appDir, ...gitArgs]).catch(() => ({ stdout: "" }))).stdout.trim();
const receipt = {
  schemaVersion: 1,
  boundary:
    "Real attached displays (Electron ↔ CoreGraphics matched). Placement matrix through production renderer IPC in ordinary Spaces; cross-display drags as native CGEvent drags inside test-owned fullscreen Spaces; WindowServer identity via getMediaSourceId and 5 ms all-display sampling; per-window captures only. Display loss is simulated inside the test process's Electron screen module (real windows move on real screens); no cable was unplugged and no display setting changed. No CUA capture channel, no ⌘⇧Esc, no model calls.",
  startedAt: new Date().toISOString(),
  source: {
    commit: await git("rev-parse", "HEAD"),
    dirtyPaths: (await git("status", "--porcelain")).split("\n").filter(Boolean),
  },
  passed: false,
  topology: null,
  launches: [],
  matrix: [],
  edges: [],
  switching: [],
  drags: [],
  simulatedTopology: [],
  restarts: [],
  gate: [],
  checks: [],
  observations: [],
  gaps: [],
};
const rendererErrors = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let model, fixture, cursor, helper;
/** The current launch: { app, main, monitor, label }. */
let L;
const probe = async (...probeArgs) =>
  JSON.parse((await run(probePath, probeArgs.map(String))).stdout.trim());
async function until(check, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last && !last.__pending) return last;
    await sleep(80);
  }
  throw Error(`${label} (last: ${JSON.stringify(last)})`);
}
const pending = (detail) => ({ __pending: true, ...detail });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const round2 = (value) => Math.round(value * 100) / 100;
const pid = () => L.app.process().pid;

/* ---------------------------------------------------------------- topology */
/** Electron displays, ordered built-in first, then by x. */
let displays = [];
const displayRects = () =>
  displays.map(({ bounds: b }) => `${b.x},${b.y},${b.width},${b.height}`).join(";");
const displayName = (index) => (index < 0 ? "none" : displays[index].name);

async function readTopology() {
  const electron = await L.app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label,
      internal: display.internal,
      bounds: display.bounds,
      workArea: display.workArea,
      size: display.size,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      primary: display.id === screen.getPrimaryDisplay().id,
    })),
  );
  const coreGraphics = await probe("displays");
  const matched = electron.map((display) => {
    const cg = coreGraphics.find(
      (item) =>
        item.x === display.bounds.x &&
        item.y === display.bounds.y &&
        item.width === display.bounds.width &&
        item.height === display.bounds.height,
    );
    assert.ok(cg, `No CoreGraphics display at ${JSON.stringify(display.bounds)}`);
    assert.equal(cg.id, display.id, "Electron display id is the CGDirectDisplayID");
    assert.ok(!cg.mirrored && cg.active && !cg.asleep, `Display ${cg.id} is not a live screen`);
    const pixelScale = cg.pixelWidth / cg.width;
    assert.equal(pixelScale, cg.pixelHeight / cg.height, "Non-uniform backing scale");
    assert.equal(
      display.scaleFactor,
      pixelScale,
      `Electron scaleFactor ${display.scaleFactor} ≠ CG pixel ratio ${pixelScale} on ${display.label}`,
    );
    return {
      ...display,
      name: `${display.label || `display ${display.id}`} (${display.scaleFactor}×)`,
      cg,
    };
  });
  assert.equal(coreGraphics.length, electron.length, "Electron and CoreGraphics disagree on count");
  matched.sort((a, b) =>
    a.internal === b.internal ? a.bounds.x - b.bounds.x : a.internal ? -1 : 1,
  );
  return { electron: matched, coreGraphics };
}

/* ----------------------------------------------------------- observation */
async function mimiWindows() {
  return L.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => {
        const url = win.webContents.getURL();
        const kind = url.includes("popout=pet")
          ? "docked"
          : url.endsWith("/mimi-companion.html")
            ? "moving"
            : null;
        if (!kind) return null;
        const match = /^window:(\d+):/.exec(win.getMediaSourceId());
        return {
          kind,
          cgId: match ? Number(match[1]) : null,
          bounds: win.getBounds(),
          visible: win.isVisible(),
        };
      })
      .filter(Boolean),
  );
}

/** BrowserWindow identity joined with WindowServer's on-screen list for the test PID. */
async function observe() {
  const [electron, cg] = await Promise.all([mimiWindows(), probe("list", pid())]);
  const onScreen = electron
    .map((win) => ({ ...win, cg: cg.find((item) => item.id === win.cgId) }))
    .filter((win) => win.cg && win.cg.alpha > 0);
  const geometric = cg
    .map((win) => ({ ...win, form: classifyOwnedWindow(win, displays) }))
    .filter((win) => win.form);
  return {
    electron,
    onScreen,
    geometric,
    unidentified: geometric.filter((win) => !onScreen.some((item) => item.cgId === win.id)),
    unclassified: cg.filter((win) => isUnclassifiedLarge(win, displays)),
  };
}

const sameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const presence = () => L.main.evaluate(() => window.codeshell.pet.getPresence());

/** Exactly one Mimi form on screen per WindowServer, BrowserWindow and the owner. */
async function waitShown(form, label, accept = () => true, ms = 15_000) {
  return until(
    async () => {
      const [snapshot, seen] = await Promise.all([presence(), observe()]);
      if (form === null)
        return snapshot.shown === null && !seen.onScreen.length && !seen.geometric.length
          ? { snapshot, seen }
          : pending({ shown: snapshot.shown, onScreen: seen.onScreen.length });
      const [win] = seen.onScreen;
      const ok =
        snapshot.shown === form &&
        seen.onScreen.length === 1 &&
        win.kind === form &&
        seen.geometric.length === 1 &&
        seen.geometric[0].id === win.cgId &&
        seen.geometric[0].form === form &&
        !seen.unclassified.length &&
        sameRect(win.bounds, win.cg);
      if (!ok)
        return pending({
          shown: snapshot.shown,
          onScreen: seen.onScreen.map(({ kind, bounds, cg }) => ({ kind, bounds, cg })),
          geometric: seen.geometric,
          unclassified: seen.unclassified,
        });
      const display = displayIndexOf(win.cg, displays);
      const result = { snapshot, win, rect: win.cg, display, displayName: displayName(display) };
      return (await accept(result))
        ? result
        : pending({ rect: win.cg, display: result.displayName });
    },
    `${label}: WindowServer never showed exactly ${form}`,
    ms,
  );
}

/* ------------------------------------------------------------- renderers */
const pageFor = (match, label) =>
  until(() => {
    const pages = L.app.windows().filter((page) => !page.isClosed() && match(page.url()));
    return pages.at(-1) ?? pending({ label });
  }, `${label} renderer not found`);
const widgetPage = () => pageFor((url) => url.includes("popout=pet"), "Docked widget");
const overlayPage = async () => {
  const page = await pageFor(
    (url) => new URL(url).pathname.endsWith("/mimi-companion.html"),
    "Moving companion",
  );
  if (!page.__errorsHooked) {
    page.__errorsHooked = true;
    rendererErrors.push(captureRendererErrors(page));
  }
  return page;
};
async function movingState() {
  const overlay = await overlayPage();
  const state = await overlay.evaluate(() => window.mimiCompanion.getState());
  const origin = state.windowOrigin ?? { x: 0, y: 0 };
  return {
    ...state,
    anchor: { x: origin.x + state.position.x, y: origin.y + state.position.y },
  };
}
const setPresence = (patch) =>
  L.main.evaluate((value) => window.codeshell.pet.setPresence(value), patch);

/* ---------------------------------------------------------------- pixels */
async function capture(win, name) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const file = join(evidenceDir, `${name}.png`);
  // A just-shown or just-moved window may not have composited its first frame.
  let pixels;
  let attempts = 0;
  for (const deadline = Date.now() + 5_000; ; ) {
    attempts++;
    await run("screencapture", ["-x", "-o", `-l${win.cgId}`, file]);
    pixels = opaquePixels(await readFile(file));
    if (pixels.count > 400 || Date.now() > deadline) break;
    await sleep(250);
  }
  const global = pixelBoxToGlobal(pixels, win.cg);
  const display = displays[displayIndexOf(win.cg, displays)];
  assert.ok(display, `${name}: window is on no display`);
  const expected = display.scaleFactor;
  assert.equal(
    pixels.width,
    win.cg.width * expected,
    `${name}: capture width ${pixels.width}px ≠ ${win.cg.width} pt × ${expected}`,
  );
  assert.equal(
    pixels.height,
    win.cg.height * expected,
    `${name}: capture height ${pixels.height}px ≠ ${win.cg.height} pt × ${expected}`,
  );
  assert.ok(pixels.count > 400, `${name}: no rendered Mimi pixels (${pixels.count})`);
  return {
    file,
    attempts,
    display: display.name,
    scaleFactor: expected,
    png: { width: pixels.width, height: pixels.height },
    opaquePixels: pixels.count,
    pixelBox: pixels.box,
    drawnDip: { width: round2(global.width), height: round2(global.height) },
    drawnPx: {
      width: pixels.box.right - pixels.box.left + 1,
      height: pixels.box.bottom - pixels.box.top + 1,
    },
    footCenter: { x: round2(global.footCenter.x), y: round2(global.footCenter.y) },
  };
}
/** Drawn size per form per display, to compare 1× and 2× in DIP. */
const drawn = { docked: [], moving: [] };

/**
 * What the compositor shows: a screen-region capture around an owned window, taken
 * only when every sampled point of the region is covered by windows of the test
 * PID (the owned fullscreen backdrop and Mimi), so no other application is captured.
 */
async function compositedEdge(win, name) {
  const pad = 8;
  const region = {
    x: win.cg.x - pad,
    y: win.cg.y - pad,
    width: win.cg.width + pad * 2,
    height: win.cg.height + pad * 2,
  };
  for (const [fx, fy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
  ]) {
    const stack = await probe(
      "stack",
      Math.round(region.x + (region.width - 1) * fx),
      Math.round(region.y + (region.height - 1) * fy),
    );
    // Below the owned fullscreen backdrop nothing is drawn on this Space; anything of
    // another process above it (an all-Spaces overlay) means this region is not ours.
    const backdrop = stack.findIndex((hit) => hit.pid === pid() && hit.layer === 0);
    const foreign = stack
      .slice(0, backdrop < 0 ? stack.length : backdrop)
      .find((hit) => hit.pid !== pid());
    if (backdrop < 0 || foreign)
      return {
        skipped: `another process's window is in the region (layer ${foreign?.layer ?? "?"})`,
      };
  }
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const file = join(evidenceDir, `${name}-composited.png`);
  await run("screencapture", [
    "-x",
    `-R${region.x},${region.y},${region.width},${region.height}`,
    file,
  ]);
  const image = decodePng(await readFile(file));
  const scale = image.width / region.width;
  const at = (gx, gy) =>
    image.pixel(Math.floor((gx - region.x) * scale), Math.floor((gy - region.y) * scale));
  const backdrop = at(region.x + 1, region.y + 1);
  // Just inside the window's top edge, centred: the pet is not drawn there.
  const insideEdge = at(win.cg.x + win.cg.width / 2, win.cg.y + 3);
  const same = (a, b) => a.slice(0, 3).every((value, i) => Math.abs(value - b[i]) <= 6);
  return { file, scale, backdrop, insideEdge, transparentEdge: same(insideEdge, backdrop) };
}

/* ---------------------------------------------------------------- placing */
const dockedAnchorOf = (shown) => ({ x: shown.rect.x, y: shown.rect.y });

async function placeDocked(origin, display, label) {
  const widget = await widgetPage();
  await widget.evaluate((value) => window.codeshell.pet.moveWidget(value), origin);
  const expected = clampDockedAnchor(origin, display.workArea);
  return waitShown(
    "docked",
    label,
    (shown) => shown.rect.x === expected.x && shown.rect.y === expected.y,
  );
}

/** The renderer's own drag protocol (begin → move → end → leave), without native input. */
async function placeMoving(anchor, display, label) {
  const overlay = await overlayPage();
  await overlay.evaluate((value) => {
    window.mimiCompanion.interaction("begin");
    window.mimiCompanion.move(value);
    window.mimiCompanion.interaction("end");
    window.mimiCompanion.interaction("leave");
  }, anchor);
  const expected = clampMovingAnchor(anchor, display.workArea, 200);
  let state;
  const shown = await waitShown("moving", label, async (result) => {
    if (displays[result.display] !== display) return false;
    state = await movingState();
    return state.anchor.x === expected.x && state.anchor.y === expected.y;
  });
  return { shown, state, expected };
}

async function gateSnapshot(label) {
  const status = await L.main
    .evaluate(() => window.codeshell.computerUse.status())
    .catch((error) => ({ error: String(error?.message ?? error) }));
  const dock = await L.app.evaluate(({ app }) => app.dock?.isVisible() ?? null).catch(() => null);
  const entry = {
    label,
    dockIconVisible: dock,
    enabled: status.enabled,
    active: status.active,
    input: status.input ?? null,
    ...(status.error ? { error: status.error } : {}),
  };
  receipt.gate.push(entry);
  return entry;
}
const gateKey = (entry) =>
  JSON.stringify({
    enabled: entry.enabled,
    active: entry.active,
    stopped: entry.input?.stopped ?? null,
    foregroundHeld: entry.input?.foregroundHeld ?? null,
  });

/** Switch forms and check that Mimi keeps standing where she was (DIP, exact up to rounding). */
async function switchAndCheck(from, display, label) {
  const index = displays.indexOf(display);
  if (from.form === "docked") {
    const feet = dockedFeet(from.anchor);
    await setPresence({ mode: "moving" });
    let state;
    const shown = await waitShown("moving", `${label} → moving`, async (result) => {
      if (result.display !== index) return false;
      state = await movingState();
      return state.size > 0;
    });
    const expected = clampMovingAnchor(
      movingAnchorForFeet(feet, state.size),
      display.workArea,
      state.size,
    );
    const error = distance(state.anchor, expected);
    const clamped =
      expected.x !== movingAnchorForFeet(feet, state.size).x ||
      expected.y !== movingAnchorForFeet(feet, state.size).y;
    const feetError = distance(movingFeet(state.anchor, state.size), feet);
    assert.ok(
      error <= 1,
      `${label}: moving anchor ${JSON.stringify(state.anchor)} ≠ ${JSON.stringify(expected)}`,
    );
    assert.ok(clamped || feetError <= 1, `${label}: feet moved ${feetError} DIP on switch`);
    assert.ok(
      movingInside(state.anchor, display.workArea, state.size),
      `${label}: moving outside work area`,
    );
    assert.deepEqual(
      state.windowOrigin,
      { x: shown.rect.x, y: shown.rect.y },
      `${label}: renderer origin differs from the real window origin`,
    );
    return {
      form: "moving",
      anchor: state.anchor,
      size: state.size,
      shown,
      error,
      feetError: round2(feetError),
      clamped,
    };
  }
  const feet = movingFeet(from.anchor, from.size);
  await setPresence({ mode: "docked" });
  const expected = clampDockedAnchor(dockedAnchorForFeet(feet), display.workArea);
  const shown = await waitShown(
    "docked",
    `${label} → docked`,
    (result) => result.display === index,
  );
  const anchor = dockedAnchorOf(shown);
  const error = distance(anchor, expected);
  const feetError = distance(dockedFeet(anchor), feet);
  assert.ok(
    error <= 1,
    `${label}: docked anchor ${JSON.stringify(anchor)} ≠ ${JSON.stringify(expected)}`,
  );
  assert.ok(dockedInside(anchor, display.workArea), `${label}: docked outside work area`);
  return {
    form: "docked",
    anchor,
    shown,
    error,
    feetError: round2(feetError),
    clamped:
      expected.x !== dockedAnchorForFeet(feet).x || expected.y !== dockedAnchorForFeet(feet).y,
  };
}

/* ---------------------------------------------------------------- launches */
async function launch(label) {
  let monitor;
  const app = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: fixture.env,
      runtimeTimeoutMs: 420_000,
    },
    { watch: (child, settings) => (monitor = watchElectronTestProcess(child, settings)) },
  );
  L = { label, app, monitor, main: null };
  // From the first moment: WindowServer across every display during startup.
  const startup = displays.length
    ? probe("sample", app.process().pid, 9000, 5, displayRects())
    : null;
  await findCodeShellWindow(app);
  L.main = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(L.main, "Production workbench window not found");
  rendererErrors.push(captureRendererErrors(L.main));
  await L.main.waitForFunction(() => !!window.codeshell?.pet?.getPresence);
  const trust = L.main.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ state: "visible", timeout: 4_000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__mimi = { samples: 0, violations: [] };
    globalThis.__mimiSampler = setInterval(() => {
      const kinds = BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed() && win.isVisible())
        .map((win) => win.webContents.getURL())
        .map((url) =>
          url.includes("popout=pet")
            ? "docked"
            : url.endsWith("/mimi-companion.html")
              ? "moving"
              : "",
        )
        .filter(Boolean);
      globalThis.__mimi.samples++;
      if (kinds.length > 1 && globalThis.__mimi.violations.length < 20)
        globalThis.__mimi.violations.push(kinds);
    }, 5);
  });
  await L.main.waitForFunction(
    async () => (await window.codeshell.pet.getPresence()).movingAvailable,
    undefined,
    { timeout: 20_000 },
  );
  L.startup = startup;
  return L;
}

async function closeLaunch(extra = {}) {
  const { app, monitor, label } = L;
  const sampler = await app
    .evaluate(() => {
      clearInterval(globalThis.__mimiSampler);
      return globalThis.__mimi;
    })
    .catch(() => null);
  await app.close().catch(() => monitor?.terminate());
  const settlement = await monitor?.completed;
  const entry = { label, browserWindowSampler: sampler, cleanup: settlement?.status, ...extra };
  receipt.launches.push(entry);
  assert.equal(settlement?.status, "cleaned", `${label}: test process not cleaned`);
  assert.ok(sampler && sampler.samples > 100, `${label}: BrowserWindow sampler too short`);
  assert.equal(sampler.violations.length, 0, `${label}: both forms visible together`);
  L = null;
  return entry;
}

async function savedState(accept, label) {
  return until(async () => {
    const text = await readFile(statePath, "utf8").catch(() => "");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return pending({ text });
    }
    return accept(value) ? value : pending({ value });
  }, `${label}: mimi-presence.json never reached the expected state`);
}

/* --------------------------------------------------- owned fullscreen Spaces */
async function enterOwnedSpaces() {
  await L.app.evaluate(
    async ({ BrowserWindow }, targets) => {
      globalThis.__mimiBackdrops = [];
      for (const target of targets) {
        const backdrop = new BrowserWindow({
          x: target.workArea.x + 60,
          y: target.workArea.y + 60,
          width: 640,
          height: 480,
          show: false,
          backgroundColor: "#2d4a6b",
          title: `Mimi multi-display acceptance backdrop ${target.id}`,
          webPreferences: { sandbox: true, contextIsolation: true },
        });
        globalThis.__mimiBackdrops.push(backdrop);
        await backdrop.loadURL(
          `data:text/html,<body style='margin:0;background:%232d4a6b;color:white;font:22px system-ui;display:grid;place-items:center;height:100vh'>Mimi multi-display acceptance (owned test window, ${encodeURIComponent(target.name)})</body>`,
        );
        backdrop.show();
        backdrop.setFullScreen(true);
        const deadline = Date.now() + 10_000;
        while (!backdrop.isFullScreen() && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 100));
        await new Promise((done) => setTimeout(done, 1200)); // Space animation
      }
      return globalThis.__mimiBackdrops.map((win) => win.isFullScreen());
    },
    displays.map(({ id, workArea, name }) => ({ id, workArea, name })),
  );
  // Each display's front Space now belongs to a test window of this PID. A notched
  // built-in panel keeps fullscreen content below the camera housing, so the
  // window spans the display's width and bottom but may start up to 64 pt lower.
  return until(async () => {
    const owned = await probe("list", pid());
    const spaces = displays.map((display) => {
      const b = display.bounds;
      return owned.find(
        (win) =>
          win.layer === 0 &&
          win.x === b.x &&
          win.width === b.width &&
          win.y >= b.y &&
          win.y - b.y <= 64 &&
          win.y + win.height === b.y + b.height,
      );
    });
    return spaces.every(Boolean)
      ? spaces.map((win, i) => ({ display: displays[i].name, backdrop: win }))
      : pending({ covered: spaces.map(Boolean) });
  }, "Owned fullscreen backdrops did not cover every display");
}
async function leaveOwnedSpaces() {
  if (!L) return;
  await L.app
    .evaluate(async () => {
      for (const backdrop of globalThis.__mimiBackdrops ?? []) {
        if (backdrop.isDestroyed()) continue;
        backdrop.setFullScreen(false);
        await new Promise((done) => setTimeout(done, 1300));
        backdrop.destroy();
      }
      globalThis.__mimiBackdrops = [];
    })
    .catch(() => {});
}

/** The point is ours: every window above the owned Mimi there belongs to the test PID. */
async function ownedPoint(point, ownedId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const stack = await probe("stack", Math.round(point.x), Math.round(point.y));
    const index = stack.findIndex((hit) => hit.id === ownedId);
    assert.ok(index >= 0, `Owned window ${ownedId} not under ${JSON.stringify(point)}`);
    const foreign = stack.slice(0, index).filter((hit) => hit.pid !== pid());
    if (!foreign.length)
      return { x: Math.round(point.x), y: Math.round(point.y), attempts: attempt + 1 };
    await L.app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed() && win.isVisible() && win.isAlwaysOnTop()) win.moveTop();
    });
    await sleep(200);
  }
  throw Error(`A foreign window stays above owned window ${ownedId} at ${JSON.stringify(point)}`);
}

/* ---------------------------------------------------------- display loss */
/** Replace the test app's Electron screen answers; real displays stay attached. */
async function simulateTopology(keepIds, override = {}) {
  await L.app.evaluate(
    ({ screen }, { keep, override: changes }) => {
      if (!globalThis.__mimiScreen) {
        globalThis.__mimiScreen = {
          getAllDisplays: screen.getAllDisplays,
          getPrimaryDisplay: screen.getPrimaryDisplay,
          getDisplayNearestPoint: screen.getDisplayNearestPoint,
          getDisplayMatching: screen.getDisplayMatching,
        };
      }
      const real = globalThis.__mimiScreen;
      const list = () =>
        real
          .getAllDisplays()
          .filter((display) => keep.includes(display.id))
          .map((display) => ({ ...display, ...(changes[display.id] ?? {}) }));
      const nearest = (point) => {
        let best;
        let bestDistance = Infinity;
        for (const display of list()) {
          const b = display.bounds;
          const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1));
          const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1));
          if (dx * dx + dy * dy < bestDistance) {
            best = display;
            bestDistance = dx * dx + dy * dy;
          }
        }
        return best;
      };
      screen.getAllDisplays = () => list();
      screen.getDisplayNearestPoint = nearest;
      screen.getDisplayMatching = (rect) =>
        nearest({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      screen.getPrimaryDisplay = () =>
        list().find((display) => display.id === real.getPrimaryDisplay().id) ?? list()[0];
    },
    { keep: keepIds, override },
  );
}
async function restoreTopology() {
  if (!L) return;
  await L.app
    .evaluate(({ screen }) => {
      const real = globalThis.__mimiScreen;
      if (!real) return;
      Object.assign(screen, real);
      delete globalThis.__mimiScreen;
    })
    .catch(() => {});
}
const emitScreen = (event, displayId) =>
  L.app.evaluate(
    ({ screen }, { event: name, displayId: id }) => {
      const removed = globalThis.__mimiScreen?.getAllDisplays().find((item) => item.id === id);
      if (name === "display-removed") screen.emit(name, {}, removed);
      else screen.emit(name, {}, removed ?? screen.getPrimaryDisplay(), []);
    },
    { event, displayId },
  );

/* ================================================================== run */
try {
  await run("swiftc", [
    "-O",
    "-o",
    probePath,
    join(appDir, "scripts", "mimi-window-server-probe.swift"),
  ]);
  receipt.permissions = {
    accessibility: (await probe("trusted")).trusted,
    screenRecording: (await probe("capture-access")).granted,
  };
  assert.ok(receipt.permissions.screenRecording, "The calling terminal needs Screen Recording");
  if (!skipNative)
    assert.ok(receipt.permissions.accessibility, "The calling terminal needs Accessibility");
  cursor = await probe("cursor");

  model = await startMockProviderServer();
  fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: false } }),
  );

  /* ---------------------------------------------- launch 1: the matrix */
  await launch("launch-1-matrix");
  const topology = await readTopology();
  displays = topology.electron;
  receipt.topology = {
    displays: displays.map(({ cg, ...display }) => ({
      ...display,
      coreGraphics: {
        id: cg.id,
        main: cg.main,
        builtin: cg.builtin,
        mode: `${cg.modeWidth}×${cg.modeHeight}`,
        pixels: `${cg.pixelWidth}×${cg.pixelHeight}`,
        vendor: cg.vendor,
        model: cg.model,
      },
    })),
    negativeOrigins: displays
      .filter(({ bounds }) => bounds.x < 0 || bounds.y < 0)
      .map(({ name, bounds }) => `${name} at (${bounds.x}, ${bounds.y})`),
    scaleFactors: [...new Set(displays.map((display) => display.scaleFactor))],
  };
  // Which Space each display shows: a display's own menu bar (layer 24, at its top,
  // its full width) is on screen in an ordinary Space and absent in an application's
  // fullscreen Space (bounds only; no titles or pixels of other apps are read).
  const foreign = await probe("others", pid());
  for (const display of receipt.topology.displays)
    display.menuBarOnScreen = foreign.some(
      (win) =>
        win.layer === 24 &&
        win.x === display.bounds.x &&
        win.y === display.bounds.y &&
        win.width === display.bounds.width,
    );
  assert.ok(displays.length >= 2, "Multi-display acceptance needs at least two attached displays");
  if (receipt.topology.scaleFactors.length < 2)
    receipt.gaps.push("All displays share one scale factor: mixed DPI was not exercised");
  receipt.checks.push(
    `topology: ${displays.length} live displays, Electron id/bounds/scale = CoreGraphics id/bounds/pixel ratio`,
  );
  // Startup of launch 1 was sampled before the topology was known: none shown yet.
  await L.startup?.catch(() => null);
  await gateSnapshot("launch-1 before any Mimi");

  // A. Per display, ordinary Spaces: docked and moving placement, sizes and pixels.
  await setPresence({ visible: true, mode: "docked" });
  await waitShown("docked", "initial docked");
  for (const display of displays) {
    const index = displays.indexOf(display);
    const tag = `d${display.id}`;
    const wa = display.workArea;
    const entry = {
      display: display.name,
      displayId: display.id,
      scaleFactor: display.scaleFactor,
    };
    await setPresence({ visible: true, mode: "docked" });
    await waitShown("docked", `${tag} docked`);
    const docked = await placeDocked(
      { x: Math.round(wa.x + wa.width * 0.5 - 56), y: Math.round(wa.y + wa.height * 0.55 - 56) },
      display,
      `${tag} docked placement`,
    );
    assert.equal(docked.display, index, `${tag}: docked on the wrong display`);
    assert.deepEqual(
      { width: docked.win.bounds.width, height: docked.win.bounds.height },
      { width: 112, height: 112 },
      `${tag}: docked window is not 112×112 DIP`,
    );
    entry.docked = {
      browserWindow: docked.win.bounds,
      windowServer: docked.rect,
      capture: await capture(docked.win, `${tag}-docked`),
    };
    drawn.docked.push(entry.docked.capture.drawnDip);
    // Only the 96 DIP pet (and its shadow) is opaque: no window-sized backing.
    assert.ok(
      entry.docked.capture.drawnDip.width < 100 && entry.docked.capture.drawnDip.height < 100,
      `${tag}: docked window has an opaque backing ${JSON.stringify(entry.docked.capture.drawnDip)}`,
    );

    const toMoving = await switchAndCheck(
      { form: "docked", anchor: dockedAnchorOf(docked) },
      display,
      `${tag} docked→moving`,
    );
    assert.equal(toMoving.size, 200, `${tag}: default moving size is 200 DIP`);
    const movingWin = toMoving.shown.win;
    assert.equal(movingWin.bounds.width, display.bounds.width, `${tag}: moving not display-wide`);
    assert.equal(movingWin.bounds.height, display.bounds.height, `${tag}: moving not display-high`);
    const movingCapture = await capture(movingWin, `${tag}-moving`);
    drawn.moving.push(movingCapture.drawnDip);
    const box = movingCapture.drawnDip;
    assert.ok(
      box.width <= 200 * 0.7 + 2 && box.height <= 200 + 2,
      `${tag}: moving pixels ${JSON.stringify(box)} exceed the 140×200 DIP box`,
    );
    entry.moving = {
      browserWindow: movingWin.bounds,
      windowServer: movingWin.cg,
      displayBounds: display.bounds,
      menuBarOffset: movingWin.cg.y - display.bounds.y,
      state: { anchor: toMoving.anchor, size: toMoving.size },
      switchError: toMoving.error,
      feetError: toMoving.feetError,
      pixelFeetVsDockedPixelFeet: round2(
        distance(movingCapture.footCenter, entry.docked.capture.footCenter),
      ),
      capture: movingCapture,
    };
    const back = await switchAndCheck(toMoving, display, `${tag} moving→docked`);
    entry.backToDocked = { anchor: back.anchor, error: back.error, feetError: back.feetError };
    receipt.matrix.push(entry);

    // B. Edges and corners: docked requests beyond each corner (centre still on this
    //    display), each followed by docked→moving→docked; then moving corners.
    const corners = {
      "top-left": { x: wa.x - 20, y: wa.y - 20 },
      "top-right": { x: wa.x + wa.width - 92, y: wa.y - 20 },
      "bottom-left": { x: wa.x - 20, y: wa.y + wa.height - 92 },
      "bottom-right": { x: wa.x + wa.width - 92, y: wa.y + wa.height - 92 },
    };
    for (const [corner, origin] of Object.entries(corners)) {
      const placed = await placeDocked(origin, display, `${tag} docked ${corner}`);
      assert.equal(placed.display, index, `${tag} ${corner}: docked left its display`);
      const there = await switchAndCheck(
        { form: "docked", anchor: dockedAnchorOf(placed) },
        display,
        `${tag} ${corner} docked→moving`,
      );
      const again = await switchAndCheck(there, display, `${tag} ${corner} moving→docked`);
      receipt.edges.push({
        display: display.name,
        corner,
        form: "docked-first",
        requested: origin,
        docked: dockedAnchorOf(placed),
        clampError: distance(dockedAnchorOf(placed), clampDockedAnchor(origin, wa)),
        moving: there.anchor,
        movingClamped: there.clamped,
        movingError: there.error,
        dockedAgain: again.anchor,
        dockedAgainError: again.error,
      });
    }
    const movingCorners = {
      "top-left": { x: wa.x - 50, y: wa.y - 50 },
      "top-right": { x: wa.x + wa.width - 90, y: wa.y - 50 },
      "bottom-left": { x: wa.x - 50, y: wa.y + wa.height - 150 },
      "bottom-right": { x: wa.x + wa.width - 90, y: wa.y + wa.height - 150 },
    };
    await setPresence({ mode: "moving" });
    await waitShown("moving", `${tag} moving corners`, (shown) => shown.display === index);
    for (const [corner, anchor] of Object.entries(movingCorners)) {
      const placed = await placeMoving(anchor, display, `${tag} moving ${corner}`);
      const docked2 = await switchAndCheck(
        { form: "moving", anchor: placed.state.anchor, size: placed.state.size },
        display,
        `${tag} ${corner} moving→docked`,
      );
      const moving2 = await switchAndCheck(docked2, display, `${tag} ${corner} docked→moving`);
      receipt.edges.push({
        display: display.name,
        corner,
        form: "moving-first",
        requested: anchor,
        moving: placed.state.anchor,
        clampError: distance(placed.state.anchor, placed.expected),
        docked: docked2.anchor,
        dockedClamped: docked2.clamped,
        dockedError: docked2.error,
        movingAgain: moving2.anchor,
        movingAgainError: moving2.error,
      });
    }

    // C. Rapid interleaved switching, preview and close on this display while
    //    WindowServer is sampled every 5 ms across every display.
    const gateBefore = await gateSnapshot(`${tag} before switching`);
    const sampling = probe("sample", pid(), 6500, 5, displayRects());
    await sleep(150);
    await L.main.evaluate(async () => {
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
      await new Promise((done) => setTimeout(done, 400));
      await pet.setPresence({ visible: false });
      await preview;
      await pet.setPresence({ visible: true, mode: "docked" });
    });
    const sampled = await sampling;
    const gateAfter = await gateSnapshot(`${tag} after switching/preview/close`);
    const final = await waitShown("docked", `${tag} after switching`);
    assert.ok(sampled.samples > 100, `${tag}: sampler too short`);
    assert.equal(sampled.both, 0, `${tag}: WindowServer showed two Mimi windows together`);
    assert.equal(sampled.unclassified, 0, `${tag}: an unclassified owned overlay was on screen`);
    assert.ok(sampled.docked > 0 && sampled.moving > 0, `${tag}: both forms were not exercised`);
    const elsewhere = displays
      .map((_, i) => (i === index ? 0 : sampled.dockedOn[i] + sampled.movingOn[i]))
      .reduce((a, b) => a + b, 0);
    assert.equal(
      elsewhere + sampled.dockedOn[displays.length] + sampled.movingOn[displays.length],
      0,
      `${tag}: a Mimi form appeared on another display while switching on ${display.name}`,
    );
    assert.equal(
      gateKey(gateBefore),
      gateKey(gateAfter),
      `${tag}: switching changed the input gate`,
    );
    assert.equal(final.display, index, `${tag}: docked left its display after switching`);
    receipt.switching.push({ display: display.name, windowServer: sampled });
  }
  const spread = (list, key) =>
    round2(Math.max(...list.map((item) => item[key])) - Math.min(...list.map((item) => item[key])));
  receipt.drawnSize = {
    docked: drawn.docked,
    moving: drawn.moving,
    dockedSpreadDip: {
      width: spread(drawn.docked, "width"),
      height: spread(drawn.docked, "height"),
    },
    movingSpreadDip: {
      width: spread(drawn.moving, "width"),
      height: spread(drawn.moving, "height"),
    },
  };
  for (const form of ["docked", "moving"])
    for (const key of ["width", "height"])
      assert.ok(
        receipt.drawnSize[`${form}SpreadDip`][key] <= 3,
        `${form} drawn ${key} differs by more than 3 DIP between 1× and 2× displays`,
      );
  receipt.checks.push(
    "every display: docked 112×112 DIP and moving display-sized windows, BrowserWindow = WindowServer bounds, captures sized by that display's backing scale, drawn DIP size equal across scales",
    "every display: docked↔moving switches keep the feet (or clamp into that display's work area), corners and edges stay on the same display",
    "every display: 5 ms all-display WindowServer sampling during rapid switching/preview/close shows one form at a time and only on that display; input gate unchanged",
  );

  // D0. Docked chat focus while another (test-owned) app is active. The docked widget
  //     is now a panel: a click must still make it the key window and typed keys
  //     must reach its chat input. Keys are posted only after the active app is
  //     verified owned (helper or test app) and the pet key, so no other app can
  //     receive them.
  if (!skipNative) {
    const home = displays.find((display) => display.internal) ?? displays[0];
    await setPresence({ visible: true, mode: "docked" });
    await waitShown("docked", "focus docked");
    const placed = await placeDocked(
      {
        x: Math.round(home.workArea.x + home.workArea.width * 0.5 - 56),
        y: Math.round(home.workArea.y + home.workArea.height * 0.5 - 56),
      },
      home,
      "focus placement",
    );
    helper = spawn(probePath, ["front", "45"], { stdio: ["ignore", "pipe", "ignore"] });
    const helperInfo = await new Promise((done, fail) => {
      // The helper is active before the click; whichever owned app is active after it is recorded.
      const lines = createInterface({ input: helper.stdout });
      lines.once("line", (line) => done(JSON.parse(line)));
      helper.once("exit", () => fail(Error("Foreground helper exited early")));
    });
    const helperPid = helper.pid;
    await until(async () => {
      const front = await probe("frontmost");
      return front.pid === helperPid ? front : pending(front);
    }, "The owned foreground helper never became the active application");
    const grab = await ownedPoint(
      { x: placed.rect.x + 56, y: placed.rect.y + 56 },
      placed.win.cgId,
    );
    await probe("move", grab.x, grab.y);
    await sleep(250);
    await probe("click", grab.x, grab.y);
    const expanded = await waitShown(
      "docked",
      "focus chat expanded",
      (item) => item.rect.width === 400 && item.rect.height === 380,
    );
    const widget = await widgetPage();
    const inputState = await until(async () => {
      const state = await widget.evaluate(() => {
        const input = document.querySelector("form input");
        return {
          exists: !!input,
          disabled: input?.disabled ?? null,
          focused: document.activeElement === input,
          documentHasFocus: document.hasFocus(),
        };
      });
      return state.focused && state.documentHasFocus ? state : pending(state);
    }, "Docked chat input never received focus");
    const keyState = await L.app.evaluate(({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes("popout=pet"),
      );
      return {
        petIsKey: pet?.isFocused() ?? false,
        focusedIsPet: BrowserWindow.getFocusedWindow() === pet,
      };
    });
    const frontBeforeTyping = await probe("frontmost");
    const owner = (front) =>
      front.pid === helperPid ? "owned helper" : front.pid === pid() ? "test app" : "other";
    // Keys go to the active app's key window: post them only if both are owned.
    assert.notEqual(owner(frontBeforeTyping), "other", "A foreign app became active");
    assert.ok(
      keyState.petIsKey && keyState.focusedIsPet,
      "Docked pet did not become the key window",
    );
    const text = "mimi 3 screens";
    await probe("type", text);
    const typed = await until(async () => {
      const value = await widget.evaluate(() => document.querySelector("form input")?.value ?? "");
      return value === text ? value : pending({ value });
    }, "Native keys did not reach the docked chat input");
    const gateWhileChatting = await gateSnapshot("docked chat focused (helper active)");
    const frontAfterTyping = await probe("frontmost");
    helper.kill();
    helper = undefined;
    receipt.focus = {
      display: home.name,
      helper: { pid: helperInfo.pid, active: helperInfo.active === 1 },
      click: grab,
      expanded: expanded.rect,
      input: inputState,
      keyWindow: keyState,
      frontmostBeforeTyping: owner(frontBeforeTyping),
      frontmostAfterTyping: owner(frontAfterTyping),
      typed,
      foregroundHeldWhileChatting: gateWhileChatting.input?.foregroundHeld ?? null,
    };
    await setPresence({ visible: false });
    await waitShown(null, "focus closed");
    // Closing the chat releases the foreground hold after its 10 s grace period;
    // later gate comparisons start from that settled state.
    const closedAt = Date.now();
    await until(
      async () => {
        const status = await L.main.evaluate(() => window.codeshell.computerUse.status());
        return status.input?.foregroundHeld === false ? status : pending(status.input ?? {});
      },
      "Closing the docked chat never released the foreground hold",
      20_000,
    );
    receipt.focus.foregroundReleasedAfterMs = Date.now() - closedAt;
    await gateSnapshot("after docked chat closed and its hold released");
    await setPresence({ visible: true, mode: "docked" });
    await waitShown("docked", "focus reopened");
    receipt.checks.push(
      "docked chat as a panel: a native click while an owned helper app is active makes the pet the key window and native keys reach its chat input",
    );
  }

  // D. Native cross-display drags inside owned fullscreen Spaces on every display.
  if (skipNative) receipt.gaps.push("--skip-native: native cross-display drags were not run");
  else {
    receipt.ownedSpaces = await enterOwnedSpaces();
    receipt.checks.push("owned fullscreen Space on every display before native input");
    const builtIn = displays.find((display) => display.internal) ?? displays[0];
    const others = displays.filter((display) => display !== builtIn);
    const pairs = [];
    for (const other of others) pairs.push([builtIn, other], [other, builtIn]);
    if (others.length >= 2) pairs.push([others[0], others.at(-1)]); // through the middle screen
    const interior = (display, fx = 0.5, fy = 0.55) => ({
      x: Math.round(display.workArea.x + display.workArea.width * fx),
      y: Math.round(display.workArea.y + display.workArea.height * fy),
    });
    const neutral = async (display) => {
      // Rest the pointer on the owned backdrop, away from Mimi, so hover ends.
      const point = interior(display, 0.15, 0.3);
      await probe("move", point.x, point.y);
      await sleep(400);
    };
    for (const form of ["moving", "docked"])
      for (const [from, to] of pairs) {
        const tag = `drag-${form}-${from.id}-to-${to.id}`;
        await setPresence({ visible: true, mode: form });
        let start;
        let grab;
        if (form === "docked") {
          const center = interior(from);
          const placed = await placeDocked(
            { x: center.x - 56, y: center.y - 56 },
            from,
            `${tag} start`,
          );
          start = { anchor: dockedAnchorOf(placed), shown: placed };
          grab = { x: placed.rect.x + 56, y: placed.rect.y + 56 };
        } else {
          await waitShown("moving", `${tag} moving shown`);
          const center = interior(from);
          const placed = await placeMoving(
            { x: center.x - 70, y: center.y - 100 },
            from,
            `${tag} start`,
          );
          const overlay = await overlayPage();
          const body = overlay.getByRole("button", { name: "打开 Mimi 聊天，拖动可移动" });
          await body.waitFor({ state: "visible" });
          const bodyBox = await body.boundingBox();
          start = { anchor: placed.state.anchor, shown: placed.shown, bodyBox };
          grab = {
            x: placed.shown.rect.x + bodyBox.x + bodyBox.width / 2,
            y: placed.shown.rect.y + bodyBox.y + bodyBox.height * 0.45,
          };
        }
        await probe("move", Math.round(grab.x), Math.round(grab.y));
        await sleep(450); // hover reaches the moving host; it stops ignoring the mouse
        const fromPoint = await ownedPoint(grab, start.shown.win.cgId);
        const target = interior(to);
        const toPoint = { x: target.x, y: target.y };
        const delta = { x: toPoint.x - fromPoint.x, y: toPoint.y - fromPoint.y };
        const gateBefore = await gateSnapshot(`${tag} before`);
        const sampling = probe("sample", pid(), 3200, 5, displayRects());
        await sleep(100);
        await probe("drag", fromPoint.x, fromPoint.y, toPoint.x, toPoint.y, 60, 16);
        await sleep(300);
        await neutral(to);
        const sampled = await sampling;
        const toIndex = displays.indexOf(to);
        const fromIndex = displays.indexOf(from);
        let result;
        if (form === "docked") {
          const expected = clampDockedAnchor(
            { x: start.anchor.x + delta.x, y: start.anchor.y + delta.y },
            to.workArea,
          );
          const shown = await waitShown("docked", `${tag} end`, (item) => item.display === toIndex);
          const anchor = dockedAnchorOf(shown);
          result = {
            expected,
            actual: anchor,
            error: round2(distance(anchor, expected)),
            capture: await capture(shown.win, tag),
            composited: await compositedEdge(shown.win, tag),
            windowServer: shown.rect,
            browserWindow: shown.win.bounds,
          };
          assert.ok(
            dockedInside(anchor, to.workArea),
            `${tag}: docked outside the target work area`,
          );
          assert.ok(
            result.composited.skipped || result.composited.transparentEdge,
            `${tag}: on screen the docked edge is ${result.composited.insideEdge}, not the backdrop ${result.composited.backdrop}`,
          );
          if (to.scaleFactor === 1)
            assert.ok(!result.composited.skipped, `${tag}: no composited check on the 1× display`);
        } else {
          const expected = clampMovingAnchor(
            { x: start.anchor.x + delta.x, y: start.anchor.y + delta.y },
            to.workArea,
            200,
          );
          let state;
          let handoffOffered = null;
          // Dropping on another app's window offers a handoff bubble (8 s, nothing is
          // sent without a click; never clicked here). Measure the character after it.
          const shown = await waitShown(
            "moving",
            `${tag} end`,
            async (item) => {
              if (item.display !== toIndex) return false;
              state = await movingState();
              if (state.handoff) handoffOffered = state.handoff.app;
              return !state.humanActive && !state.handoff;
            },
            15_000,
          );
          result = {
            expected,
            actual: state.anchor,
            handoffOffered,
            size: state.size,
            pinned: state.pinned,
            error: round2(distance(state.anchor, expected)),
            capture: await capture(shown.win, tag),
            windowServer: shown.rect,
            browserWindow: shown.win.bounds,
            displayBounds: to.bounds,
          };
          assert.equal(state.size, 200, `${tag}: size changed across displays`);
          assert.ok(
            movingInside(state.anchor, to.workArea, 200),
            `${tag}: moving outside target work area`,
          );
          assert.deepEqual(
            state.windowOrigin,
            { x: shown.rect.x, y: shown.rect.y },
            `${tag}: origin mismatch`,
          );
        }
        const gateAfter = await gateSnapshot(`${tag} after`);
        assert.ok(result.error <= 2, `${tag}: landed ${result.error} DIP from the pointer path`);
        assert.equal(sampled.both, 0, `${tag}: two Mimi windows on screen during the drag`);
        assert.equal(sampled.unclassified, 0, `${tag}: unclassified owned overlay during the drag`);
        assert.equal(sampled[form === "docked" ? "multipleDocked" : "multipleMoving"], 0);
        const on = sampled[form === "docked" ? "dockedOn" : "movingOn"];
        assert.ok(on[fromIndex] > 0 && on[toIndex] > 0, `${tag}: drag did not span both displays`);
        assert.equal(on[displays.length], 0, `${tag}: the window was between/off displays`);
        assert.equal(
          gateKey(gateBefore),
          gateKey(gateAfter),
          `${tag}: drag changed the input gate`,
        );
        const ratio = form === "docked" ? drawn.docked[0] : drawn.moving[0];
        assert.ok(
          Math.abs(result.capture.drawnDip.height - ratio.height) <= 3,
          `${tag}: drawn height ${result.capture.drawnDip.height} DIP vs ${ratio.height} DIP before the drag`,
        );
        receipt.drags.push({
          tag,
          form,
          from: from.name,
          to: to.name,
          scale: `${from.scaleFactor}×→${to.scaleFactor}×`,
          pointer: { from: fromPoint, to: toPoint, attemptsToOwnPoint: fromPoint.attempts },
          start: start.anchor,
          ...result,
          windowServer: { ...result.windowServer, sampler: sampled },
        });
      }
    await leaveOwnedSpaces();
    receipt.checks.push(
      "native drags (2×↔1×, 2×↔2× across negative x, and across two boundaries): the real window lands under the pointer path within 2 DIP, inside the target work area, on the target display, never two windows or an off-display window, same DIP size, input gate unchanged",
    );
  }

  // E. Simulated topology loss inside the test app (real windows, real screens).
  const [primary] = displays;
  const removable = displays.filter((display) => display !== primary);
  for (const gone of removable) {
    const keep = displays.filter((display) => display !== gone).map((display) => display.id);
    // Moving on the display that disappears.
    await setPresence({ visible: true, mode: "moving" });
    await waitShown("moving", `remove ${gone.id} moving shown`);
    const moving = await placeMoving(
      {
        x: gone.workArea.x + gone.workArea.width * 0.6,
        y: gone.workArea.y + gone.workArea.height * 0.4,
      },
      gone,
      `remove ${gone.id} moving placed`,
    );
    await simulateTopology(keep);
    await emitScreen("display-removed", gone.id);
    const fallback = nearestDisplay(
      { x: moving.state.anchor.x + 70, y: moving.state.anchor.y + 100 },
      displays.filter((display) => display !== gone),
    );
    let movedState;
    const moved = await waitShown("moving", `remove ${gone.id} moving clamped`, async (item) => {
      if (displays[item.display] !== fallback) return false;
      movedState = await movingState();
      return movingInside(movedState.anchor, fallback.workArea, movedState.size);
    });
    // Then docked on the same lost display.
    await restoreTopology();
    await emitScreen("display-metrics-changed", gone.id);
    await setPresence({ mode: "docked" });
    await waitShown("docked", `remove ${gone.id} docked shown`);
    const docked = await placeDocked(
      {
        x: Math.round(gone.workArea.x + gone.workArea.width * 0.6),
        y: Math.round(gone.workArea.y + gone.workArea.height * 0.4),
      },
      gone,
      `remove ${gone.id} docked placed`,
    );
    await simulateTopology(keep);
    await emitScreen("display-removed", gone.id);
    const dockedFallback = nearestDisplay(
      { x: docked.rect.x + 56, y: docked.rect.y + 56 },
      displays.filter((display) => display !== gone),
    );
    const dockedMoved = await waitShown(
      "docked",
      `remove ${gone.id} docked clamped`,
      (item) =>
        displays[item.display] === dockedFallback &&
        dockedInside(dockedAnchorOf(item), dockedFallback.workArea),
    );
    // Switching after the loss stays on the remaining display.
    const after = await switchAndCheck(
      { form: "docked", anchor: dockedAnchorOf(dockedMoved) },
      dockedFallback,
      `remove ${gone.id} switch after loss`,
    );
    await restoreTopology();
    await emitScreen("display-metrics-changed", gone.id);
    receipt.simulatedTopology.push({
      kind: "display-removed (simulated in the test app; the display stayed attached)",
      removed: gone.name,
      moving: {
        before: moving.state.anchor,
        after: movedState.anchor,
        window: moved.rect,
        fallback: fallback.name,
      },
      docked: {
        before: dockedAnchorOf(docked),
        after: dockedAnchorOf(dockedMoved),
        fallback: dockedFallback.name,
      },
      switchAfterLoss: { form: after.form, anchor: after.anchor, error: after.error },
    });
  }
  // A resolution change (metrics) on the largest display: shrink its work area.
  {
    const target = displays.reduce((a, b) => (b.bounds.width > a.bounds.width ? b : a));
    await setPresence({ visible: true, mode: "docked" });
    const wa = target.workArea;
    const docked = await placeDocked(
      { x: wa.x + wa.width - 150, y: wa.y + wa.height - 150 },
      target,
      "metrics docked placed",
    );
    const smaller = {
      bounds: {
        ...target.bounds,
        width: Math.round(target.bounds.width * 0.6),
        height: Math.round(target.bounds.height * 0.6),
      },
      workArea: {
        ...wa,
        width: Math.round(wa.width * 0.6),
        height: Math.round(wa.height * 0.6) - 30,
      },
    };
    await simulateTopology(
      displays.map((display) => display.id),
      { [target.id]: smaller },
    );
    // The moving window will cover the simulated (smaller) display: classify against it too.
    const realDisplays = displays;
    displays = [...realDisplays, { ...target, name: `${target.name} simulated`, ...smaller }];
    await emitScreen("display-metrics-changed", target.id);
    const shrunk = await waitShown("docked", "metrics docked clamped", (item) =>
      dockedInside(dockedAnchorOf(item), smaller.workArea),
    );
    await setPresence({ mode: "moving" });
    let movingAfter;
    await waitShown("moving", "metrics moving after shrink", async (item) => {
      if (item.rect.width !== smaller.bounds.width) return false;
      movingAfter = await movingState();
      return movingInside(movingAfter.anchor, smaller.workArea, movingAfter.size);
    });
    await restoreTopology();
    displays = realDisplays;
    await emitScreen("display-metrics-changed", target.id);
    await setPresence({ mode: "docked" });
    await waitShown("docked", "metrics restored");
    receipt.simulatedTopology.push({
      kind: "display-metrics-changed (simulated work area shrink in the test app)",
      display: target.name,
      simulated: smaller,
      docked: { before: dockedAnchorOf(docked), after: dockedAnchorOf(shrunk) },
      moving: { anchor: movingAfter.anchor, size: movingAfter.size },
    });
  }
  receipt.checks.push(
    "simulated display removal (each non-primary display) and work-area shrink inside the test app: both forms move onto the remaining display's work area; switching afterwards stays there",
  );

  // F. Positions for the cold restarts: docked on the last display's top-right
  //    corner, moving pinned on the first non-built-in display.
  const dockedHome = displays.at(-1);
  const movingHome =
    displays.find((display) => !display.internal && display !== dockedHome) ?? displays[0];
  await setPresence({ visible: true, mode: "moving" });
  await waitShown("moving", "restart prep moving");
  const movingPin = await placeMoving(
    { x: movingHome.workArea.x + 120, y: movingHome.workArea.y + 160 },
    movingHome,
    "restart prep moving pin",
  );
  await setPresence({ mode: "docked" });
  await waitShown("docked", "restart prep docked");
  const dockedPin = await placeDocked(
    { x: dockedHome.workArea.x + dockedHome.workArea.width - 200, y: dockedHome.workArea.y + 30 },
    dockedHome,
    "restart prep docked pin",
  );
  const saved1 = await savedState(
    (value) =>
      value.visible === true &&
      value.mode === "docked" &&
      value.dockedAnchor?.x === dockedPin.rect.x &&
      value.dockedAnchor?.y === dockedPin.rect.y,
    "launch-1 save",
  );
  await gateSnapshot("launch-1 end");
  await closeLaunch({ saved: saved1 });

  /* ------------------------------------- launch 2: docked restored on its display */
  await launch("launch-2-docked-restore");
  const restoredDocked = await waitShown(
    "docked",
    "launch-2 docked restored",
    (item) => item.rect.x === dockedPin.rect.x && item.rect.y === dockedPin.rect.y,
    25_000,
  );
  const startup2 = await L.startup;
  const dockedHomeIndex = displays.indexOf(dockedHome);
  assert.equal(
    restoredDocked.display,
    dockedHomeIndex,
    "launch-2: docked restored on the wrong display",
  );
  assert.equal(startup2.moving, 0, "launch-2: the moving form appeared during a docked restore");
  assert.equal(startup2.both, 0, "launch-2: both forms on screen during startup");
  assert.equal(
    startup2.dockedOn.reduce((sum, count, i) => (i === dockedHomeIndex ? sum : sum + count), 0),
    0,
    "launch-2: docked appeared on another display during startup",
  );
  const restoredDockedCapture = await capture(restoredDocked.win, "restart-docked");
  // Now move the moving form to its home display and pin it for launch 3.
  await setPresence({ mode: "moving" });
  await waitShown("moving", "launch-2 moving", (item) => item.display === dockedHomeIndex);
  const movingPin2 = await placeMoving(
    { x: movingHome.workArea.x + 300, y: movingHome.workArea.y + 220 },
    movingHome,
    "launch-2 moving pin",
  );
  const saved2 = await savedState(
    (value) =>
      value.mode === "moving" &&
      value.movingAnchor?.x === movingPin2.state.anchor.x &&
      value.movingAnchor?.y === movingPin2.state.anchor.y,
    "launch-2 save",
  );
  receipt.restarts.push({
    launch: 2,
    expected: {
      form: "docked",
      display: dockedHome.name,
      anchor: { x: dockedPin.rect.x, y: dockedPin.rect.y },
    },
    restored: { rect: restoredDocked.rect, display: restoredDocked.displayName },
    capture: restoredDockedCapture,
    startupWindowServer: startup2,
    previousMovingPin: movingPin.state.anchor,
  });
  await closeLaunch({ saved: saved2 });

  /* ------------------------------------- launch 3: moving restored on its display */
  await launch("launch-3-moving-restore");
  const movingHomeIndex = displays.indexOf(movingHome);
  let restoredState;
  const restoredMoving = await waitShown(
    "moving",
    "launch-3 moving restored",
    async (item) => {
      if (item.display !== movingHomeIndex) return false;
      restoredState = await movingState();
      return true;
    },
    25_000,
  );
  const startup3 = await L.startup;
  assert.deepEqual(
    restoredState.anchor,
    movingPin2.state.anchor,
    "launch-3: moving anchor not restored",
  );
  assert.ok(restoredState.pinned, "launch-3: restored moving anchor is not pinned");
  assert.equal(startup3.docked, 0, "launch-3: docked appeared during a moving restore");
  assert.equal(startup3.both, 0, "launch-3: both forms on screen during startup");
  assert.equal(
    startup3.movingOn.reduce((sum, count, i) => (i === movingHomeIndex ? sum : sum + count), 0),
    0,
    "launch-3: moving appeared on another display during startup",
  );
  receipt.restarts.push({
    launch: 3,
    expected: { form: "moving", display: movingHome.name, anchor: movingPin2.state.anchor },
    restored: {
      anchor: restoredState.anchor,
      window: restoredMoving.rect,
      display: restoredMoving.displayName,
    },
    capture: await capture(restoredMoving.win, "restart-moving"),
    startupWindowServer: startup3,
  });
  // Restored forms still switch in place on their display.
  const restoredSwitch = await switchAndCheck(
    { form: "moving", anchor: restoredState.anchor, size: restoredState.size },
    movingHome,
    "launch-3 restored moving→docked",
  );
  receipt.restarts.at(-1).switchAfterRestore = {
    anchor: restoredSwitch.anchor,
    error: restoredSwitch.error,
  };
  await setPresence({ visible: false });
  await waitShown(null, "launch-3 closed");
  await gateSnapshot("launch-3 end");
  await closeLaunch();
  receipt.checks.push(
    "cold restarts in one isolated HOME: docked restored at its saved negative-y corner on its display, moving restored pinned on its display, no form flashed on another display or together during startup",
  );

  const hiddenDock = receipt.gate.filter((entry) => entry.dockIconVisible === false);
  assert.equal(
    hiddenDock.length,
    0,
    `CodeShell's Dock icon was hidden at: ${hiddenDock.map((e) => e.label)}`,
  );
  receipt.checks.push(
    "CodeShell's Dock icon stayed visible at every snapshot, moving form included",
  );
  receipt.observations.push(
    "Fixed in this run's build (3/3): presenting the moving form called setVisibleOnAllWorkspaces without skipTransformProcessType, which turned CodeShell into a UIElement app and hid its Dock icon until the docked form was created again. The panel needs no transform to join fullscreen Spaces.",
    "Fixed in this run's build (1/3): the docked widget was an ordinary NSWindow, which macOS does not draw over another application's fullscreen Space; on a display showing one it was reported visible by Electron but absent from WindowServer's on-screen list. It is now a panel, like the moving form.",
    "Fixed in this run's build (2/3): BrowserWindow.moveTop() left the 112 DIP transparent docked window on an opaque white rounded backing on the 1× display (visible on screen; independent of the panel change). On macOS the docked surface now refreshes z-order by ordering an already visible window front instead.",
    "In ordinary Spaces macOS keeps the display-sized moving panel below that display's menu bar (WindowServer y = display y + menu bar). BrowserWindow.getBounds() reports the same frame and the renderer's windowOrigin follows it, so the character is still drawn at its global DIP anchor; the classifier accepts this offset instead of requiring the exact display rect.",
  );
  receipt.gaps.push(
    "Physical hot-unplug/replug was not performed: display removal and resolution change were simulated inside the test app's Electron screen module while all displays stayed attached.",
    "CUA real capture-channel hiding and ⌘⇧Esc in fullscreen are outside this acceptance (see the native presence receipt).",
  );
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error?.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  helper?.kill();
  await restoreTopology();
  await leaveOwnedSpaces();
  if (cursor) await probe("move", cursor.x, cursor.y).catch(() => {});
  if (L) {
    const { app, monitor } = L;
    await app.close().catch(() => monitor?.terminate());
    const settlement = await monitor?.completed;
    receipt.launches.push({ label: `${L.label} (aborted)`, cleanup: settlement?.status });
    if (settlement?.status !== "cleaned") receipt.passed = false;
  }
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (receipt.rendererErrors.length) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  await model?.close();
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome).catch(() => {});
  if (receipt.launches.every((launchEntry) => launchEntry.cleanup === "cleaned")) {
    await isolated.cleanup();
    receipt.homeRemoved = true;
  }
  await rm(probePath, { force: true }).catch(() => {});
  receipt.finishedAt = new Date().toISOString();
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      phase: "mimi-multidisplay-finished",
      passed: receipt.passed,
      receipt: receiptPath,
    }),
  );
}
