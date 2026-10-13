/*
 * Real Electron theme-pack visual smoke, in a disposable HOME.
 *
 * Build Desktop and its Core dependency first, then run:
 *   node ../../scripts/run-isolated-node-smoke.mjs scripts/e2e-themes.mjs
 * Add --screenshots <directory> to retain PNGs and a computed-style report.
 * Add --theme-source <directory> to include screenshots of a real source pack.
 * Only the native file/folder picker is scripted; review/install/selection use the UI.
 */
/* global document, getComputedStyle, Image, localStorage, window */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { officeZip as createZip } from "../../../tests/fixtures/upload-documents.mjs";
import {
  assert,
  captureRendererErrors,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-themes-e2e-");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  assert(
    value && ["--screenshots", "--theme-source"].includes(flag) && !options.has(flag),
    "Expected --screenshots <directory> or --theme-source <directory>",
  );
  options.set(flag, resolve(value));
}
const screenshotDir = options.get("--screenshots") ?? process.env.CODESHELL_THEME_SCREENSHOT_DIR;
const sourceDir = options.get("--theme-source") ?? process.env.CODESHELL_THEME_SOURCE_DIR;
const surfaces = ["window", "sidebar", "titlebar", "chat", "composer", "panel"];
const sessionId = "theme-visual-fixture";
const sessionTitle = "真姬主题 · 桌面预览";
const workspace = join(isolated.home, "Scarlet Stage");
const report = {};
let app;
let win;
let processLog = "";

// Small generated PNGs make this smoke independent of network/catalog assets.
function solidPng(red, green, blue) {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) * 0xedb88320);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, bytes) => {
    const body = Buffer.concat([Buffer.from(kind), bytes]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(32 * (1 + 32 * 3));
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 32; column++) {
      const offset = row * 97 + 1 + column * 3;
      pixels.set([red, green, blue], offset);
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fixture(id, decorations) {
  const path = join(isolated.home, id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "light.png"), solidPng(255, 0, 180));
  await writeFile(join(path, "dark.png"), solidPng(20, 180, 255));
  await writeFile(
    join(path, ".cs-theme.json"),
    JSON.stringify({ schemaVersion: 1, id, name: id, version: "1.0.0", ...decorations }),
  );
  return path;
}

async function zipFixture(source, name, wrapper = "") {
  const entries = {};
  for (const file of [".cs-theme.json", "light.png", "dark.png"]) {
    entries[`${wrapper}${file}`] = await readFile(join(source, file));
  }
  // Finder adds this sibling directory to many ordinary theme archives.
  if (wrapper) entries["__MACOSX/._theme"] = Buffer.from("Finder metadata");
  const archive = join(isolated.home, name);
  await writeFile(archive, createZip(entries));
  return archive;
}

async function seedTranscript() {
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", workspace]);
  const folder = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(folder, { recursive: true });
  const now = Date.now();
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      sessionId,
      title: sessionTitle,
      cwd: workspace,
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: now - 1000,
    }),
  );
  const events = [
    { type: "session_meta", data: { sessionId } },
    {
      type: "message",
      data: {
        role: "user",
        content: "帮我做一个西木野真姬的 CodeShell 主题，聊天背景、侧栏和边框都要。",
        clientMessageId: `${sessionId}-input`,
      },
    },
    { type: "turn_boundary", data: {} },
    {
      type: "message",
      data: {
        role: "assistant",
        content:
          '## Scarlet Stage\n\n已将真姬的绯红色调融入桌面。聊天背景、侧栏、输入框、标题栏和外边框均可由主题包独立配置。\n\n- 浅色：柔和的樱粉与清晰的深色文字\n- 深色：酒红舞台与温暖的高光\n- 装饰层保留输入、拖动与侧栏导航\n\n```ts\nconst theme = "lovelive-maki";\n```',
      },
    },
  ].map((event, index) => ({
    id: `${sessionId}-${index}`,
    timestamp: now - 1000 + index * 100,
    turnNumber: 1,
    ...event,
  }));
  await writeFile(join(folder, "transcript.jsonl"), events.map(JSON.stringify).join("\n") + "\n");
}

async function screenshot(name) {
  // Exercise the real dismiss affordance so transient install feedback does
  // not cover the composer in retained visual evidence.
  for (const close of await win.locator('[role="status"] button[aria-label]').all())
    if (await close.isVisible()) await close.click();
  const bytes = await win.screenshot({
    ...(screenshotDir ? { path: join(screenshotDir, name) } : {}),
    scale: "css",
    animations: "disabled",
  });
  if (screenshotDir) console.log(`Theme visual: ${join(screenshotDir, name)}`);
  return bytes;
}

async function dismissTrust() {
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ state: "visible", timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
}

async function appearance() {
  await navigateSettingsMenu(win, /^(打开设置|Open settings)/);
  await win.getByRole("button", { name: /^(外观|Appearance)$/ }).click();
  await win.locator("[data-theme-import]").waitFor({ state: "visible" });
}

async function backToChat() {
  await win
    .getByRole("button", { name: /^(返回应用|Back to app)$/ })
    .first()
    .click();
  await win.locator('[data-theme-surface="chat"]').waitFor({ state: "visible" });
}

async function pickPack(path, kind = "directory") {
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async (...args) => {
      globalThis.__codeshellThemePickerOptions = args.at(-1);
      return { canceled: false, filePaths: [source] };
    };
  }, path);
  await win
    .locator(kind === "zip" ? "[data-theme-import]" : "[data-theme-import-directory]")
    .click();
  const review = win.getByRole("dialog");
  await review.waitFor({ state: "visible" });
  const dialogOptions = await app.evaluate(() => globalThis.__codeshellThemePickerOptions);
  assert(
    JSON.stringify(dialogOptions.properties) ===
      JSON.stringify([kind === "zip" ? "openFile" : "openDirectory"]),
    `${kind} import opens the matching native picker`,
  );
  if (kind === "zip") {
    assert(
      dialogOptions.filters.some((filter) => filter.extensions.includes("zip")),
      "ZIP import permits ZIP files in the native picker",
    );
  }
  return review;
}

async function importPack(path, id, kind = "directory") {
  const review = await pickPack(path, kind);
  await review.getByRole("button", { name: /^(安装|Install)$/ }).click();
  await review.waitFor({ state: "hidden" });
  await win.locator(`[data-theme-pack="${id}"] button[aria-pressed="true"]`).waitFor();
  await win.waitForFunction(
    (packId) => localStorage.getItem("codeshell.theme-pack") === packId,
    id,
  );
}

async function chooseMode(mode) {
  const label = mode === "dark" ? /^(深色|Dark)/ : /^(浅色|Light)/;
  await win.getByRole("button", { name: label }).click();
  await win.waitForFunction(
    (dark) => document.documentElement.classList.contains("dark") === dark,
    mode === "dark",
  );
}

async function recordThemeAudio() {
  await win.evaluate(() => {
    if (window.__codeshellThemeAudio) return;
    const NativeAudio = window.Audio;
    window.__codeshellThemeAudio = [];
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args);
      window.__codeshellThemeAudio.push(audio);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
  });
}

async function assertThemeMusicPlayback(label) {
  await recordThemeAudio();
  assert(
    await win.evaluate(() => window.__codeshellThemeAudio.every((audio) => audio.paused)),
    `${label} does not autoplay on selection`,
  );
  assert(
    (await win.locator("[data-theme-sound-preview]").count()) === 4,
    `${label} exposes four sound previews`,
  );
  assert(
    (await win.locator("[data-theme-music-select] option").count()) === 4,
    `${label} offers an offline original and three official music links`,
  );
  await win.locator("[data-theme-music-play]").click();
  await win.waitForFunction(() =>
    window.__codeshellThemeAudio.some((audio) => !audio.paused && audio.currentTime > 0),
  );
  await backToChat();
  await win.locator("[data-theme-music-dock]").waitFor({ state: "visible" });
  assert(
    await win.evaluate(() =>
      window.__codeshellThemeAudio.some((audio) => !audio.paused && audio.currentTime > 0),
    ),
    `${label} keeps playing after returning to chat`,
  );
  await win.locator("[data-theme-music-dock-stop]").click();
  await win.waitForFunction(() => window.__codeshellThemeAudio.every((audio) => audio.paused));
  await appearance();
}

async function surfaceMetrics() {
  return win.evaluate(
    (names) =>
      Object.fromEntries(
        names.map((name) => {
          const nodes = [...document.querySelectorAll(`[data-theme-surface="${name}"]`)];
          const node = nodes.find((node) => node.getBoundingClientRect().width > 0) ?? nodes[0];
          if (!node) return [name, null];
          const base = getComputedStyle(node);
          const image = getComputedStyle(node, "::before");
          const frame = getComputedStyle(node, "::after");
          const rect = node.getBoundingClientRect();
          return [
            name,
            {
              image: image.backgroundImage,
              opacity: image.opacity,
              pointerEvents: image.pointerEvents,
              background: base.backgroundColor,
              isolation: base.isolation,
              fit: image.backgroundSize,
              position: image.backgroundPosition,
              frameWidth: frame.borderTopWidth,
              framePointerEvents: frame.pointerEvents,
              x: rect.x,
              width: rect.width,
              right: rect.right,
            },
          ];
        }),
      ),
    surfaces,
  );
}

async function decodeImages(metrics) {
  await win.evaluate(async (entries) => {
    await Promise.all(
      Object.values(entries).map(async (entry) => {
        const url = entry?.image?.match(/^url\("?(.*?)"?\)$/)?.[1];
        if (!url) return;
        const image = new Image();
        image.src = url;
        await image.decode().catch((error) => {
          throw new Error(`Theme image did not decode: ${url}: ${error}`);
        });
        if (!image.naturalWidth || !image.naturalHeight)
          throw new Error(`Undecodable image ${url}`);
      }),
    );
  }, metrics);
}

async function sampleChatPixel(bytes) {
  const point = await win.locator('[data-theme-surface="chat"]').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x + 6), y: Math.round(rect.y + rect.height / 2) };
  });
  return app.evaluate(
    ({ nativeImage }, { data, point }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      const bitmap = image.toBitmap();
      const offset = (point.y * image.getSize().width + point.x) * 4;
      return [...bitmap.subarray(offset, offset + 4)];
    },
    { data: bytes.toString("base64"), point },
  );
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  await seedTranscript();
  const legacy = await fixture("visual-legacy", {
    wallpaper: { light: "light.png", dark: "dark.png", opacity: 0.6 },
  });
  const rich = await fixture("visual-surfaces", {
    surfaces: Object.fromEntries(
      surfaces.map((name) => [
        name,
        {
          light: "light.png",
          dark: "dark.png",
          opacity: 0.2,
          fit: "cover",
          position: "bottom-right",
          background: { light: "350 35% 97%", dark: "335 20% 12%" },
          backgroundOpacity: 0.9,
        },
      ]),
    ),
    frame: { light: "350 80% 45%", dark: "350 80% 70%", width: 4, radius: 14 },
  });
  const rootZip = await zipFixture(legacy, "legacy-root.zip");
  const wrappedZip = await zipFixture(rich, "surface-theme.zip", "surface-theme/");
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    // Three bundled skins, background playback and source-pack imports extend
    // this smoke beyond the harness's default three-minute runtime budget.
    runtimeTimeoutMs: 300_000,
    // The outer guarded runner owns a different fixture HOME. Keep the Core
    // test-runner fallback attached to this Electron profile as well.
    env: { CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk).slice(-20_000);
  });
  win = await findCodeShellWindow(app);
  win.setDefaultTimeout(20_000);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 960 });
  await dismissTrust();
  await seedSessionCatalog(
    win,
    {
      __no_repo__: {
        sessions: [
          {
            id: sessionId,
            engineSessionId: sessionId,
            title: sessionTitle,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        activeSessionId: null,
      },
    },
    { replace: true },
  );
  await win.reload();
  await win.getByRole("button", { name: sessionTitle, exact: true }).click();
  await dismissTrust();
  await win.getByRole("heading", { name: "Scarlet Stage" }).waitFor();
  await appearance();
  await chooseMode("light");
  await backToChat();
  report.defaultPixel = await sampleChatPixel(await screenshot("default-light.png"));
  await appearance();
  assert(
    (await win.evaluate(() => window.codeshell.listInstalledThemes())).length === 0,
    "Fresh HOME has no imported theme packs",
  );
  const maki = win.locator('[data-theme-pack="maki"] button[aria-pressed]');
  await maki.click();
  await win.waitForFunction(() => localStorage.getItem("codeshell.theme-pack") === "maki");
  assert(
    (await win.locator('[data-theme-uninstall="maki"]').count()) === 0,
    "Bundled Maki is available without installation",
  );
  for (const mode of ["light", "dark"]) {
    await chooseMode(mode);
    await screenshot(`builtin-maki-appearance-${mode}.png`);
    await backToChat();
    await win.locator('[data-panel-action="toggle"]').click();
    await win.locator('[data-theme-surface="panel"]').waitFor({ state: "visible" });
    const metrics = await surfaceMetrics();
    report[`builtin-maki-${mode}`] = metrics;
    for (const name of surfaces) {
      assert(metrics[name], `Bundled Maki decorates the ${name} surface in ${mode} mode`);
      assert(metrics[name].isolation === "isolate", `${name} contains its decoration`);
    }
    assert(metrics.chat.image.includes("maki-stage-"), "Bundled chat uses the stage artwork");
    assert(
      metrics.sidebar.image.includes("maki-school-"),
      "Bundled sidebar uses the school artwork",
    );
    for (const name of ["chat", "sidebar"]) {
      const url = metrics[name].image.match(/^url\("?(.*?)"?\)$/)?.[1];
      assert(url && new URL(url).protocol === "file:", `${name} artwork ships in the app`);
      assert(metrics[name].pointerEvents === "none", `${name} artwork permits input`);
    }
    assert(metrics.chat.opacity === "0.28", "Bundled chat preserves its artwork opacity");
    assert(metrics.sidebar.opacity === "0.19", "Bundled sidebar preserves its artwork opacity");
    assert(metrics.window.frameWidth === "2px", "Bundled Maki preserves the outer frame");
    assert(metrics.window.framePointerEvents === "none", "Bundled frame permits window input");
    await decodeImages(metrics);
    await screenshot(`builtin-maki-chat-${mode}.png`);
    await win.locator('[data-panel-action="toggle"]').click();
    await appearance();
  }
  for (const id of ["miku", "muse"]) {
    await chooseMode("light");
    await win.locator(`[data-theme-pack="${id}"] button[aria-pressed]`).click();
    await assertThemeMusicPlayback(`Bundled ${id}`);
    for (const mode of ["light", "dark"]) {
      await chooseMode(mode);
      await screenshot(`builtin-${id}-appearance-${mode}.png`);
      await backToChat();
      const metrics = await surfaceMetrics();
      report[`builtin-${id}-${mode}`] = metrics;
      assert(metrics.chat.image.includes("stage-"), `${id} uses its bundled artwork`);
      assert(metrics.window.frameWidth === "2px", `${id} provides its window frame`);
      await decodeImages(metrics);
      await screenshot(`builtin-${id}-chat-${mode}.png`);
      await appearance();
    }
  }
  await maki.click();
  // A saved builtin selection must survive startup without installed theme data.
  await backToChat();
  await win.reload();
  await win.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--cs-frame-width").trim() ===
      "2px",
  );
  await decodeImages(await surfaceMetrics());
  await appearance();
  await win.locator('[data-theme-pack="maki"] button[aria-pressed="true"]').waitFor();
  assert(
    (await win.evaluate(() => window.codeshell.listInstalledThemes())).length === 0,
    "Bundled Maki persists independently of installed packs",
  );
  await chooseMode("light");
  const cancelledReview = await pickPack(rootZip, "zip");
  await cancelledReview.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
  await cancelledReview.waitFor({ state: "hidden" });
  assert(
    (await win.evaluate(() => window.codeshell.listInstalledThemes())).length === 0,
    "Cancelling ZIP review does not install a theme",
  );
  await importPack(rootZip, "visual-legacy", "zip");
  await backToChat();
  const rootZipMetrics = await surfaceMetrics();
  await decodeImages(rootZipMetrics);
  assert(
    rootZipMetrics.window.image.includes("cstheme://visual-legacy/"),
    "A ZIP with its manifest at the archive root installs and paints",
  );
  report.zipRoot = rootZipMetrics;
  await appearance();
  // Re-import the same theme through the independent folder action too.
  await importPack(legacy, "visual-legacy");
  await backToChat();
  report.legacy = await surfaceMetrics();
  await decodeImages(report.legacy);
  assert(
    report.legacy.window.image.includes("cstheme://visual-legacy/"),
    "Legacy wallpaper uses window surface",
  );
  report.legacyPixel = await sampleChatPixel(await screenshot("legacy-light.png"));
  assert(
    report.defaultPixel.some((value, i) => Math.abs(value - report.legacyPixel[i]) > 25),
    "Legacy wallpaper actually paints through the chat's empty margin",
  );
  await appearance();
  await chooseMode("dark");
  await backToChat();
  report.legacyDark = await surfaceMetrics();
  assert(
    report.legacyDark.window.image.includes("wallpaper-dark.png"),
    "Legacy dark wallpaper is selected",
  );
  await decodeImages(report.legacyDark);
  report.legacyDarkPixel = await sampleChatPixel(await screenshot("legacy-dark.png"));
  assert(
    report.legacyPixel.some((value, i) => Math.abs(value - report.legacyDarkPixel[i]) > 25),
    "Switching modes visibly changes the legacy wallpaper",
  );

  await appearance();
  await importPack(wrappedZip, "visual-surfaces", "zip");
  for (const mode of ["light", "dark"]) {
    await chooseMode(mode);
    await backToChat();
    await win.locator('[data-panel-action="toggle"]').click();
    await win.locator('[data-theme-surface="panel"]').waitFor({ state: "visible" });
    const metrics = await surfaceMetrics();
    report[mode] = metrics;
    for (const name of surfaces) {
      assert(
        metrics[name]?.image.includes(`surface-${name}-${mode}.png`),
        `${name} paints its ${mode} image`,
      );
      assert(metrics[name].opacity === "0.2", `${name} keeps its independent image opacity`);
      assert(metrics[name].pointerEvents === "none", `${name} image does not capture input`);
      assert(metrics[name].isolation === "isolate", `${name} contains its image layer`);
    }
    await decodeImages(metrics);
    assert(metrics.window.frameWidth === "4px", "Decorative frame has requested width");
    assert(
      metrics.window.framePointerEvents === "none",
      "Frame does not capture mouse or drag input",
    );
    await win.locator('[data-theme-surface="composer"] textarea').focus();
    assert(
      await win
        .locator('[data-theme-surface="composer"] textarea')
        .evaluate((node) => document.activeElement === node),
      "Decorated composer remains focusable",
    );
    await screenshot(`surfaces-${mode}.png`);
    await win.locator('[data-panel-action="toggle"]').click();
    await appearance();
  }

  if (sourceDir) {
    await win.locator('[data-theme-pack="default"] button[aria-pressed]').click();
    await win.evaluate(async () => {
      await window.codeshell.uninstallTheme("visual-legacy");
      await window.codeshell.uninstallTheme("visual-surfaces");
    });
    await win.locator('[data-theme-pack="visual-legacy"]').waitFor({ state: "hidden" });
    await win.locator('[data-theme-pack="visual-surfaces"]').waitFor({ state: "hidden" });
    const manifest = JSON.parse(await readFile(join(sourceDir, ".cs-theme.json"), "utf8"));
    await importPack(resolve(sourceDir), manifest.id);
    if (manifest.sounds && manifest.music) {
      await assertThemeMusicPlayback(`Installed ${manifest.id}`);
    }
    for (const mode of ["light", "dark"]) {
      await chooseMode(mode);
      await screenshot(`example-appearance-${mode}.png`);
      await backToChat();
      const metrics = await surfaceMetrics();
      await decodeImages(metrics);
      report[`example-${mode}`] = metrics;
      await screenshot(`example-chat-${mode}.png`);
      await appearance();
    }
  }

  await backToChat();
  await win.setViewportSize({ width: 390, height: 760 });
  await expandSidebar(win);
  const drawer = win.locator('#codeshell-sidebar-navigation[role="dialog"]');
  const bounds = await drawer.boundingBox();
  assert(
    bounds && bounds.x >= 0 && bounds.x + bounds.width < 390,
    "Themed narrow sidebar fits its drawer",
  );
  await screenshot("theme-narrow-sidebar.png");
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  const narrow = await surfaceMetrics();
  assert(
    narrow.composer && narrow.composer.x >= 0 && narrow.composer.right <= 391,
    "Themed composer fits a phone-width window",
  );
  assert(
    await win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "Theme adds no horizontal overflow",
  );
  await screenshot("theme-narrow-chat.png");
  await win.setViewportSize({ width: 1440, height: 960 });

  await win.evaluate(() => window.codeshell.pet.setWidgetVisible(true));
  const pet =
    app.windows().find((page) => new URL(page.url()).searchParams.get("popout") === "pet") ??
    (await app.waitForEvent("window", {
      predicate: (page) => new URL(page.url()).searchParams.get("popout") === "pet",
    }));
  await pet.waitForFunction(() => document.documentElement.classList.contains("pet-widget-window"));
  report.pet = await pet.evaluate(() => ({
    backgrounds: [document.documentElement, document.body, document.getElementById("root")].map(
      (node) => getComputedStyle(node).backgroundColor,
    ),
    wallpaper: getComputedStyle(document.body, "::before").backgroundImage,
    surfaces: document.querySelectorAll("[data-theme-surface]").length,
  }));
  assert(
    report.pet.backgrounds.every((color) => color === "rgba(0, 0, 0, 0)"),
    "Pet window keeps transparent roots",
  );
  assert(
    report.pet.wallpaper === "none" && report.pet.surfaces === 0,
    "Pet window receives no surface wallpaper or frame",
  );
  await win.evaluate(() => window.codeshell.pet.setWidgetVisible(false));

  await appearance();
  await win.locator('[data-theme-pack="default"] button[aria-pressed]').click();
  await backToChat();
  report.reset = await surfaceMetrics();
  for (const [name, metric] of Object.entries(report.reset)) {
    if (metric)
      assert(
        metric.image === "none" && metric.opacity === "0",
        `${name} clears its previous image`,
      );
  }
  assert(report.reset.window.frameWidth === "0px", "Default pack clears the outer frame");
  await screenshot("default-reset.png");
  assert(
    errors.length === 0,
    `Renderer errors: ${errors.map((error) => error.message).join("; ")}`,
  );
  if (screenshotDir)
    await writeFile(join(screenshotDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    "Theme smoke passed: ZIP/folder review and imports, Maki/Miku/μ’s offline artwork, local theme music in settings and chat, installed audio playback, six surfaces, modes, reset, narrow layout and transparent pet.",
  );
  if (screenshotDir) console.log(`Theme evidence: ${screenshotDir}`);
} catch (error) {
  if (win && screenshotDir) await screenshot("failure.png").catch(() => {});
  if (screenshotDir)
    await writeFile(join(screenshotDir, "report.json"), JSON.stringify(report, null, 2));
  if (processLog) console.error(processLog);
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  await isolated.cleanup();
}
