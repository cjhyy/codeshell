/** Real production updater components and Tailwind CSS against an owned bridge.
 * No actual update, installer, external browser, or network request is allowed.
 * node .../UpdaterBanner.browser.fixture.mjs [--source-desktop /path/to/packages/desktop]
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--source-desktop"),
  "Usage: UpdaterBanner.browser.fixture.mjs [--source-desktop /path/to/packages/desktop]",
);
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = args[1] ? path.resolve(args[1]) : ownDesktop;
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output =
  process.env.CODESHELL_UPDATER_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-updater-")));
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {UpdaterSettingsRow,SidebarUpdaterButton} from './updater/UpdaterBanner';
  import {I18nProvider} from './i18n/I18nProvider';import {ToastProvider} from './ui/ToastProvider';import {saveUILanguage} from './uiLanguage';
  const root=createRoot(document.getElementById('root'));let generation=0;
  const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
    return {promise,resolve,reject};};
  window.mountFixture=(config={})=>{
    const current=++generation;saveUILanguage(config.language??'en');
    const state={config:{status:{kind:'idle'},snapshot:'resolve',version:'resolve',...config},
      calls:[],statusReads:[],versionReads:[],actions:[],listeners:new Set(),order:[]};
    window.fixture=state;
    const read=(kind)=>{
      const pending=deferred(),mode=state.config[kind==='status'?'snapshot':'version'];
      (kind==='status'?state.statusReads:state.versionReads).push(pending);state.order.push(kind);
      if(mode==='reject')pending.reject(new Error(kind+' read rejected'));
      else if(mode!=='hold')pending.resolve(kind==='status'?state.config.status:'0.9.44');
      return pending.promise;
    };
    const action=(kind,...args)=>{const pending=deferred();state.calls.push({kind,args});
      state.actions.push({kind,...pending});return pending.promise;};
    window.codeshell={
      getUpdaterStatus:()=>read('status'),getAppVersion:()=>read('version'),
      onUpdaterStatus:listener=>{state.order.push('subscribe');state.listeners.add(listener);
        return()=>state.listeners.delete(listener)},
      checkForUpdate:()=>action('check'),downloadUpdate:()=>action('download'),
      installUpdate:()=>action('install'),openExternal:url=>action('open',url),
    };
    window.pushStatus=status=>{state.config.status=status;for(const listener of state.listeners)listener(status)};
    window.unmountFixture=()=>root.render(null);
    root.render(<I18nProvider key={current}><ToastProvider><main data-generation={current} className="min-w-0 p-6">
      {config.surface==='sidebar'?<aside aria-label="Fixture sidebar"><SidebarUpdaterButton/></aside>:
        <UpdaterSettingsRow/>}
      <button id="outside-control" className="h-8" type="button">Other control</button>
    </main></ToastProvider></I18nProvider>);return current;
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 540 },
  serviceWorkers: "block",
});
const focusFailures = [];
const errors = [],
  blocked = [],
  reports = [],
  cases = [];
await context.route("**/*", (route) => {
  if (route.request().url() === "http://updater-owned.test/")
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div></body></html>',
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const mount = async (config) => {
  const generation = await page.evaluate((config) => window.mountFixture(config), config);
  await page.locator(`[data-generation="${generation}"]`).waitFor();
  await frames();
};
const check = () => page.getByRole("button", { name: "Check for updates", exact: true });
const install = () => page.getByRole("button", { name: "Restart and install", exact: true });
const alert = () => page.getByRole("alert");
const push = async (status) => {
  await page.evaluate((status) => window.pushStatus(status), status);
  await frames();
};
const settle = async (read, method, value, index = 0) => {
  await page.evaluate(
    ({ read, method, value, index }) => {
      window.fixture[read][index][method](method === "reject" ? new Error(value) : value);
    },
    { read, method, value, index },
  );
  await frames();
};
const layout = async (label, width, language, theme) => {
  const result = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll("section button")].map((node) => ({
      text: node.textContent,
      x: node.getBoundingClientRect().x,
      right: node.getBoundingClientRect().right,
      height: node.getBoundingClientRect().height,
    })),
  }));
  assert.ok(
    result.scrollWidth <= width + 1,
    JSON.stringify({ label, width, language, theme, ...result }),
  );
  for (const button of result.buttons)
    assert.ok(
      button.x >= 0 && button.right <= width + 1 && button.height >= 32,
      JSON.stringify({ label, width, language, theme, button }),
    );
  await page.screenshot({
    path: path.join(output, `${label}-${language}-${theme}-${width}.png`),
    fullPage: true,
  });
  reports.push({ label, language, theme, ...result });
};
const version = "0.9.45";
try {
  await page.goto("http://updater-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      // Desktop dark mode is controlled by the app's root class.
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
        theme,
      );
      for (const width of [320, 390, 760, 1280]) {
        await page.setViewportSize({ width, height: 540 });
        await mount({
          language,
          status: { kind: "error", message: "ConnectionFailure".repeat(64) },
        });
        await layout("long-error", width, language, theme);
        await mount({ language, status: { kind: "downloaded", version } });
        await layout("downloaded", width, language, theme);
      }
    }
  for (const result of ["resolve", "reject"]) {
    await mount({ snapshot: "hold" });
    assert.deepEqual(await page.evaluate(() => window.fixture.order.slice(0, 2)), [
      "subscribe",
      "status",
    ]);
    await push({ kind: "downloaded", version });
    await install().waitFor();
    await settle(
      "statusReads",
      result,
      result === "resolve" ? { kind: "idle" } : "late snapshot failed",
    );
    assert.equal(await install().count(), 1);
    assert.equal(await alert().count(), 0);
    cases.push(`late-${result}-snapshot-preserves-pushed-status`);
  }
  await mount({ snapshot: "reject" });
  assert.match(await alert().textContent(), /status read rejected/);
  assert.equal(await check().isDisabled(), true);
  await page.evaluate(() => (window.fixture.config.snapshot = "hold"));
  await page.getByRole("button", { name: "Retry status", exact: true }).click();
  await page.waitForFunction(() => window.fixture.statusReads.length === 2);
  await frames();
  await settle("statusReads", "reject", "retry status failed", 1);
  assert.match(await alert().textContent(), /retry status failed/);
  if (
    !(await page
      .getByRole("button", { name: "Retry status", exact: true })
      .evaluate((node) => document.activeElement === node))
  )
    focusFailures.push("Retry status loses keyboard focus when the retry fails again");
  await page.evaluate(() => (window.fixture.config.snapshot = "hold"));
  await page.getByRole("button", { name: "Retry status", exact: true }).click();
  await page.waitForFunction(() => window.fixture.statusReads.length === 3);
  await frames();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry status", exact: true })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await settle("statusReads", "resolve", { kind: "idle" }, 2);
  assert.equal(await check().evaluate((node) => document.activeElement === node), true);
  assert.equal(await alert().count(), 0);
  assert.equal(await check().isEnabled(), true);
  cases.push("failed-status-read-retry-and-success");

  await mount({ version: "reject" });
  assert.match(await alert().textContent(), /version read rejected/);
  assert.match(await page.locator("section").innerText(), /Unavailable/);
  await page.evaluate(() => (window.fixture.config.version = "hold"));
  await page.getByRole("button", { name: "Retry version", exact: true }).click();
  await page.waitForFunction(() => window.fixture.versionReads.length === 2);
  await frames();
  await settle("versionReads", "reject", "retry version failed", 1);
  assert.match(await alert().textContent(), /retry version failed/);
  if (
    !(await page
      .getByRole("button", { name: "Retry version", exact: true })
      .evaluate((node) => document.activeElement === node))
  )
    focusFailures.push("Retry version loses keyboard focus when the retry fails again");
  await page.evaluate(() => (window.fixture.config.version = "hold"));
  await page.getByRole("button", { name: "Retry version", exact: true }).click();
  await page.waitForFunction(() => window.fixture.versionReads.length === 3);
  await frames();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry version", exact: true })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  await settle("versionReads", "resolve", "0.9.44", 2);
  assert.equal(await check().evaluate((node) => document.activeElement === node), true);
  assert.equal(await alert().count(), 0);
  assert.match(await page.locator("section").innerText(), /0\.9\.44/);
  cases.push("failed-version-read-retry-and-success");

  for (const kind of ["status", "version"]) {
    await mount({ [kind === "status" ? "snapshot" : "version"]: "reject" });
    await page.evaluate((kind) => {
      window.fixture.config[kind === "status" ? "snapshot" : "version"] = "hold";
    }, kind);
    await page
      .getByRole("button", {
        name: kind === "status" ? "Retry status" : "Retry version",
        exact: true,
      })
      .click();
    const read = kind === "status" ? "statusReads" : "versionReads";
    await page.waitForFunction((read) => window.fixture[read].length === 2, read);
    await frames();
    const outside = page.locator("#outside-control");
    await outside.focus();
    await settle(read, "resolve", kind === "status" ? { kind: "idle" } : "0.9.44", 1);
    assert.equal(await outside.evaluate((node) => document.activeElement === node), true);
    cases.push(`${kind}-retry-success-does-not-steal-external-focus`);
  }

  for (const [kind, status, label] of [
    ["check", { kind: "idle" }, "Check for updates"],
    ["download", { kind: "available", version }, "Download"],
    ["install", { kind: "downloaded", version }, "Restart and install"],
    [
      "open",
      {
        kind: "manual-required",
        version,
        reason: "mac-readonly-volume",
        url: "https://releases.invalid/owned",
      },
      "Open download page",
    ],
  ]) {
    await mount({ status });
    const button = page.getByRole("button", { name: label, exact: true });
    await button.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.fixture.actions.length === 1);
    await page.keyboard.press("Enter");
    await button.evaluate((node) => {
      node.click();
      node.click();
    });
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.map((call) => call.kind)), [
      kind,
    ]);
    assert.equal(await button.getAttribute("aria-busy"), "true");
    await settle("actions", "reject", `${kind} owned rejection`);
    assert.match(await alert().textContent(), new RegExp(`${kind} owned rejection`));
    assert.equal(await button.isEnabled(), true);
    assert.equal(
      await button.evaluate((node) => document.activeElement === node),
      true,
      `${kind}: failed action must keep keyboard focus on its retryable button`,
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.fixture.actions.length === 2);
    await settle("actions", "resolve", undefined, 1);
    assert.equal(await alert().count(), 0);
    if (kind === "open")
      assert.equal(
        await page.evaluate(() => window.fixture.calls[0].args[0]),
        "https://releases.invalid/owned",
      );
    cases.push(`${kind}-single-pending-reject-visible-focus-and-retry`);
  }
  await mount({ snapshot: "hold", version: "hold" });
  await page.evaluate(() => window.unmountFixture());
  await frames();
  assert.equal(await page.evaluate(() => window.fixture.listeners.size), 0);
  await settle("statusReads", "reject", "unmounted status rejection");
  await settle("versionReads", "reject", "unmounted version rejection");
  await mount({ status: { kind: "available", version } });
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.evaluate(() => window.unmountFixture());
  await frames();
  await settle("actions", "reject", "unmounted action rejection");
  cases.push("unmounted-late-reads-and-action-are-consumed");

  for (const [status, role, label] of [
    [{ kind: "available", version }, "button", /available/],
    [{ kind: "downloaded", version }, "button", /finished downloading/],
    [{ kind: "downloading", percent: 42, transferred: 42, total: 100 }, "status", /42/],
    [{ kind: "installing", version }, "status", /Restarting/],
    [
      {
        kind: "manual-required",
        version,
        reason: "mac-readonly-volume",
        url: "https://releases.invalid/owned",
      },
      "button",
      /read-only/,
    ],
    [{ kind: "error", message: "owned ordinary error" }, "status", /owned ordinary error/],
  ]) {
    await mount({ surface: "sidebar", status });
    assert.equal(await page.getByRole(role, { name: label }).count(), 1);
  }
  await mount({
    surface: "sidebar",
    status: { kind: "error", reason: "github-unreachable", message: "owned GitHub unavailable" },
  });
  assert.equal(await page.locator("aside").innerText(), "");
  await push({ kind: "downloaded", version });
  assert.equal(await page.getByRole("button", { name: /finished downloading/ }).count(), 1);
  cases.push("sidebar-statuses-and-github-unreachable-hidden");
  for (const [kind, status, label] of [
    ["download", { kind: "available", version }, /available/],
    ["install", { kind: "downloaded", version }, /finished downloading/],
    [
      "open",
      {
        kind: "manual-required",
        version,
        reason: "mac-readonly-volume",
        url: "https://releases.invalid/owned",
      },
      /read-only/,
    ],
  ]) {
    await mount({ surface: "sidebar", status });
    await page.getByRole("button", { name: label }).click();
    await settle("actions", "reject", `${kind} sidebar owned rejection`);
    assert.equal(await page.getByRole("button", { name: label }).count(), 1);
    await page
      .getByRole("status")
      .filter({ hasText: `${kind} sidebar owned rejection` })
      .waitFor();
    cases.push(`sidebar-${kind}-rejection-consumed-and-button-retryable`);
  }
  assert.deepEqual({ errors, focusFailures }, { errors: [], focusFailures: [] });
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, desktop, layouts: reports.length, cases }, null, 2));
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ desktop, reports, cases, errors, focusFailures, blocked }, null, 2),
  );
  await browser.close();
}
