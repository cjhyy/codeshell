/* Actual preference controls and CSS, two same-origin pages and real media-query
 * events. This is renderer evidence, not an Electron/OS/Keychain acceptance run. */
/* global document, localStorage, window */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { watchElectronTestProcess } from "../../../scripts/electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated Node smoke runner");
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], "--output");
await mkdir(path.resolve(process.argv[3]), { mode: 0o700 });
const output = await realpath(process.argv[3]);
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const profile = path.join(output, "owned-browser-profile");
const executable = await realpath(process.env.CODESHELL_TEST_CHROMIUM ?? chromium.executablePath());
const origin = "http://codeshell-preferences-fixture.test";
const require = createRequire(path.join(desktop, "package.json"));
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {GeneralSection} from './settings/GeneralSection';
import {AppearanceSection} from './settings/AppearanceSection';
import {I18nProvider} from './i18n/I18nProvider';
import {DialogProvider} from './ui/DialogProvider';
import {ToastProvider} from './ui/ToastProvider';
import {initTheme} from './theme';
window.codeshell={listInstalledThemes:async()=>[],onThemesChanged:()=>()=>{}};
window.preferenceStorageEvents=[];
window.addEventListener('storage',event=>window.preferenceStorageEvents.push({key:event.key,newValue:event.newValue}));
initTheme();
createRoot(document.getElementById('root')).render(<I18nProvider><DialogProvider><ToastProvider>
<main className='mx-auto max-w-5xl p-4'><GeneralSection scope='user' activeProjectPath={null}/><AppearanceSection/></main>
</ToastProvider></DialogProvider></I18nProvider>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "dataurl", ".wav": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "only-preferences",
      setup(builder) {
        builder.onLoad({ filter: /[/\\]settings[/\\]PermissionSection\.tsx$/ }, () => ({
          contents: "export const PermissionSection=()=>null",
          loader: "js",
        }));
        builder.onLoad({ filter: /[/\\]updater[/\\]UpdaterBanner\.tsx$/ }, () => ({
          contents: "export const UpdaterSettingsRow=()=>null",
          loader: "js",
        }));
      },
    },
  ],
});
const cssPath = path.join(renderer, "styles/tailwind.css");
const compiled = await compile(await readFile(cssPath, "utf8"), {
  base: path.dirname(cssPath),
  from: cssPath,
  onDependency() {},
});
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx,html}", negated: false }],
});
const css = compiled.build([
  ...scanner.scan(),
  ...scanner.scanFiles([{ content: source, extension: "tsx" }]),
]);
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`;
const reports = [],
  errors = [],
  blocked = [],
  observerFailures = [],
  settlements = [];
let context, activeMonitor, activeChild, activeExit;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const proof = {
  fixture: "settings-preferences-renderer",
  status: "failed",
  sourceHead: children
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: desktop,
      encoding: "utf8",
      timeout: 5_000,
    })
    .trim(),
  fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  bundleSHA256: hash(bundle.outputFiles[0].text),
  reports,
  errors,
  blocked,
  settlements,
  exclusions: ["PermissionSection", "UpdaterSettingsRow"],
  boundary:
    "Real React controls and browser storage/media events; no Electron/Main/OS appearance change or Keychain access",
};
async function open() {
  const spawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = spawn.call(this, command, args, options);
    if (
      command === executable &&
      options?.env?.HOME === process.env.HOME &&
      args?.includes(`--user-data-dir=${profile}`)
    ) {
      assert.equal(activeChild, undefined, "One owned browser may be captured per launch");
      activeChild = child;
      activeExit = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned browser spawn failed"));
      activeMonitor = watchElectronTestProcess(child, {
        timeoutMs: 60_000,
        reportFailure: (message) => observerFailures.push(message),
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1000, height: 900 },
      colorScheme: "light",
      serviceWorkers: "block",
      executablePath: executable,
    });
  } finally {
    children.spawn = spawn;
    syncBuiltinESMExports();
  }
  assert.ok(activeMonitor, "Early owned browser identity binding is required");
  await context.route("**/*", (route) => {
    if (route.request().url() === origin + "/")
      return route.fulfill({ contentType: "text/html", body: html });
    blocked.push(route.request().url());
    return route.abort();
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
}
async function close() {
  const pendingContext = context;
  context = undefined;
  const failures = [];
  try {
    if (pendingContext)
      await bounded(pendingContext.close(), 8_000, "Owned browser close timed out");
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (activeMonitor) {
        const settlement = await activeMonitor.terminate();
        settlements.push(settlement);
        assert.equal(settlement.status, "cleaned");
        const exit = await bounded(activeExit, 3_000, "Owned browser close event is unproven");
        settlement.exit = exit;
        assert.equal(exit.code, 0);
        assert.equal(exit.signal, null);
      } else if (activeChild) {
        activeChild.unref();
        activeChild.stdout?.unref?.();
        activeChild.stderr?.unref?.();
        failures.push(new Error("Owned browser identity was never established"));
      }
    } catch (error) {
      activeChild?.unref();
      activeChild?.stdout?.unref?.();
      activeChild?.stderr?.unref?.();
      failures.push(error);
    } finally {
      activeMonitor = activeChild = activeExit = undefined;
    }
  }
  if (failures.length)
    throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
}
async function bounded(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function page() {
  const next = await context.newPage();
  next.setDefaultTimeout(3_000);
  await next.goto(origin + "/");
  await next.getByRole("button", { name: /^English/ }).waitFor();
  return next;
}
async function frames(target) {
  await target.evaluate(
    () =>
      new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done))),
  );
}
async function current(target) {
  return target.evaluate(() => ({
    language: localStorage.getItem("codeshell.uiLanguage"),
    mode: localStorage.getItem("codeshell.theme"),
    dark: document.documentElement.classList.contains("dark"),
    events: window.preferenceStorageEvents,
  }));
}
async function selectedEnglish(target) {
  return (await target.getByRole("button", { name: /^English/ }).getAttribute("class"))
    .split(/\s+/)
    .includes("ring-1");
}
async function step(label, target, run) {
  try {
    reports.push({ label, status: "passed", result: await run() });
  } catch (error) {
    reports.push({
      label,
      status: "failed",
      message: error.message,
      state: await current(target).catch(() => null),
    });
    await target
      .screenshot({ path: path.join(output, `${reports.length}-failed.png`) })
      .catch(() => {});
  }
}
try {
  await open();
  const a = await page(),
    b = await page();
  await step(
    "Language card updates the existing same-origin window and its selected card",
    b,
    async () => {
      await a.getByRole("button", { name: /^English/ }).click();
      await b.waitForFunction(() =>
        window.preferenceStorageEvents.some(
          (event) => event.key === "codeshell.uiLanguage" && event.newValue === "en",
        ),
      );
      await b.getByRole("heading", { name: "Language", exact: true }).waitFor();
      assert.equal(await selectedEnglish(b), true);
      const events = (await current(b)).events.filter(
        (event) => event.key === "codeshell.uiLanguage",
      );
      assert.equal(
        events.length,
        1,
        "One language selection must produce one native storage event",
      );
      await b.screenshot({ path: path.join(output, "language-second-window.png") });
      return { actualStorageEvent: true, storageEvents: events.length, selectedEnglish: true };
    },
  );
  await step(
    "Manual Dark remains Dark when the browser system color preference changes",
    a,
    async () => {
      await a.locator('[data-theme-mode="dark"]').click();
      await a.emulateMedia({ colorScheme: "dark" });
      await frames(a);
      await a.emulateMedia({ colorScheme: "light" });
      await frames(a);
      assert.equal((await current(a)).mode, "dark");
      assert.equal(
        await a.locator('[data-theme-mode="dark"]').getAttribute("aria-pressed"),
        "true",
      );
      assert.equal((await current(a)).dark, true);
      return { saved: "dark", resolved: "dark", media: "light" };
    },
  );
  await step(
    "Reload from manual Dark then choose System and follow subsequent media changes",
    a,
    async () => {
      await a.reload();
      await a.locator('[data-theme-mode="dark"][aria-pressed="true"]').waitFor();
      await a.locator('[data-theme-mode="system"]').click();
      await a.emulateMedia({ colorScheme: "dark" });
      await frames(a);
      assert.equal((await current(a)).dark, true);
      await a.emulateMedia({ colorScheme: "light" });
      await frames(a);
      assert.equal((await current(a)).dark, false);
      return { manualStartup: true, systemFollowsBothChanges: true };
    },
  );
  await step(
    "Language and theme controls remain reachable at 390px with production CSS",
    a,
    async () => {
      await a.setViewportSize({ width: 390, height: 844 });
      const controls = [
        a.getByRole("button", { name: /^English/ }),
        a.getByRole("button", { name: /^中文/ }),
        ...(await a.locator("[data-theme-mode]").all()),
      ];
      const bounds = [];
      for (const control of controls) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
        assert.equal(
          await control.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit === node || node.contains(hit);
          }),
          true,
        );
        bounds.push(box);
      }
      assert.equal(
        await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
      );
      await a.screenshot({ path: path.join(output, "preferences-390.png") });
      return { width: 390, controls: bounds.length, noHorizontalOverflow: true };
    },
  );
  await step("Reload retains the language chosen through its actual card", b, async () => {
    await b.reload();
    await b.getByRole("heading", { name: "Language", exact: true }).waitFor();
    assert.equal(await selectedEnglish(b), true);
    return { language: "en", reloaded: true };
  });
  assert.deepEqual(
    await context.cookies(),
    [],
    "The owned profile must contain no authentication cookies",
  );
  await close();
  await open();
  const cold = await page();
  await step(
    "A new browser process restores owned persisted language and System choice",
    cold,
    async () => {
      await cold.getByRole("heading", { name: "Language", exact: true }).waitFor();
      assert.equal(await selectedEnglish(cold), true);
      assert.equal((await current(cold)).mode, "system");
      assert.equal((await current(cold)).dark, false);
      return { language: "en", mode: "system", coldBrowserProcess: true };
    },
  );
} catch (error) {
  reports.push({ label: "fixture lifecycle", status: "failed", message: error.message });
} finally {
  try {
    await close();
  } catch (error) {
    reports.push({ label: "cleanup", status: "failed", message: error.message });
  }
  proof.observerFailures = observerFailures;
  proof.status =
    reports.every((report) => report.status === "passed") &&
    errors.length === 0 &&
    blocked.length === 0 &&
    observerFailures.length === 0
      ? "passed"
      : "failed";
  await writeFile(path.join(output, "report.json"), JSON.stringify(proof, null, 2), {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ status: proof.status, cases: reports.length, output }));
assert.equal(proof.status, "passed", "Preference renderer regression failed; evidence retained");
