/** Production TrustGate used by App's ready local-project mainRoot entry.
 * Owned bridge and in-memory decisions only; no actual trust registry or services.
 * node TrustGate.browser.fixture.mjs [--source-desktop /path/to/packages/desktop] [--electron]
 */
/* global document, window, Event, innerWidth, innerHeight, devicePixelRatio, getComputedStyle, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const desktop = sourceIndex < 0 ? ownDesktop : path.resolve(process.argv[sourceIndex + 1]);
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild"),
  { chromium, _electron } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node"),
  { Scanner } = tw("@tailwindcss/oxide");
const electronMode = process.argv.includes("--electron");
const development = process.argv.includes("--development");
const output =
  process.env.CODESHELL_TRUST_GATE_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-trust-gate-")));
await mkdir(output, { recursive: true });
const rootA = "/owned/projects/CodeShell demo",
  rootB = "/owned/projects/Another project";
const source = `
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{TrustGate}from'./workspace-trust/TrustGate';import{Button}from'./components/ui/button';import{I18nProvider}from'./i18n/I18nProvider';import{saveUILanguage}from'./uiLanguage';import{saveTheme,applyTheme}from'./theme';
const root=createRoot(document.getElementById('root'));let generation=0;
const A=${JSON.stringify(rootA)},B=${JSON.stringify(rootB)};
window.mountFixture=({language,theme='light',promptWhenUntrusted=false,levels={}})=>{
localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);window.calls={reads:[],decisions:[],notified:[]};window.fixture={levels:{...levels},readErrors:{},writeErrors:{},holdRead:new Set(),holdRisk:new Set(),holdWrite:new Set(),pendingRead:{},pendingRisk:{},pendingWrite:{},riskFailure:false};
const normalRisks={permissionRules:4,envKeys:['NODE_ENV','HTTPS_PROXY','PACKAGE_MANAGER_CACHE_PATH'],hooks:2,mcpServers:['filesystem','docs-search','project-database'],setupScripts:true};
window.codeshell={getTrust:async(path)=>{window.calls.reads.push({method:'getTrust',path});if(window.fixture.holdRead.has(path))return new Promise((resolve,reject)=>window.fixture.pendingRead[path]={resolve,reject});if(window.fixture.readErrors[path])throw Error(window.fixture.readErrors[path]);return window.fixture.levels[path]??'unknown'},getTrustRisks:async(path)=>{window.calls.reads.push({method:'getTrustRisks',path});if(window.fixture.holdRisk.has(path))return new Promise((resolve,reject)=>window.fixture.pendingRisk[path]={resolve,reject});if(window.fixture.riskFailure)throw Error('Owned optional risk summary failed');return structuredClone(normalRisks)},setTrust:async(path,level)=>{window.calls.decisions.push({path,level});if(window.fixture.holdWrite.has(path))return new Promise((resolve,reject)=>window.fixture.pendingWrite[path]={resolve,reject});if(window.fixture.writeErrors[path])throw Error(window.fixture.writeErrors[path]);window.fixture.levels[path]=level}};
function Fixture(){const[projectPath,setProjectPath]=React.useState(null);window.selectRoot=path=>flushSync(()=>setProjectPath(path));return <main className='fixed inset-0 overflow-hidden bg-background p-4'><Button id='opener' onClick={()=>setProjectPath(A)}>Open owned local project</Button><Button id='second' onClick={()=>setProjectPath(B)}>Open other local project</Button><input id='external' aria-label='Independent draft'/><TrustGate projectPath={projectPath} promptWhenUntrusted={promptWhenUntrusted} onDecide={level=>window.calls.notified.push({projectPath,level})}/></main>};flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><Fixture/></I18nProvider></React.StrictMode>));};window.unmountFixture=()=>flushSync(()=>root.render(null));`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  loader: { ".png": "empty", ".webp": "empty", ".wav": "empty", ".css": "empty" },
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
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
let browser,
  nativeContext,
  nativeZoom = 1;
if (electronMode) {
  const main = path.join(output, "owned-electron.cjs");
  await writeFile(
    main,
    `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, "user-data"))});app.whenReady().then(()=>{const win=new BrowserWindow({width:800,height:600,useContentSize:true,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadURL('about:blank');});`,
  );
  browser = await _electron.launch({ executablePath: require("electron"), args: [main] });
  nativeContext = browser.context();
} else
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" &&
      existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
const reports = [],
  errors = [],
  blocked = [];
let lastPage,
  completed = false;
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
const labels = (language) =>
  language === "zh"
    ? {
        title: "信任此项目？",
        viewOnly: "仅查看(拒绝写工具)",
        trust: "信任并继续",
        retry: "重新读取",
        details: "项目信任详情",
      }
    : {
        title: "Trust this project?",
        viewOnly: "View only (deny write tools)",
        trust: "Trust and continue",
        retry: "Retry reading",
        details: "Project trust details",
      };
async function resizeNative(width, height) {
  await browser.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(size.width * size.zoom, size.height * size.zoom);
      win.webContents.setZoomFactor(size.zoom);
      win.show();
      win.focus();
    },
    { width, height, zoom: nativeZoom },
  );
  const native = await browser.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { contentBounds: win.getContentBounds(), zoom: win.webContents.getZoomFactor() };
  });
  assert.equal(native.zoom, nativeZoom);
  assert.equal(native.contentBounds.width, width * nativeZoom);
  assert.equal(native.contentBounds.height, height * nativeZoom);
  const page = await browser.firstWindow();
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width,
    height,
  });
}
async function animate(dialog) {
  await dialog.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    ),
  );
}
async function screenshot(page, file) {
  if (!electronMode) return page.screenshot({ path: file });
  // Playwright's page capture clips the bitmap at the logical viewport when
  // native Electron zoom is above 100%. Capture the actual full content area.
  const capture = await browser.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  const bitmap = Buffer.from(capture, "base64");
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  assert.equal(bitmap.readUInt32BE(16), viewport.width * viewport.dpr);
  assert.equal(bitmap.readUInt32BE(20), viewport.height * viewport.dpr);
  await writeFile(file, bitmap);
}
async function mount(page, config, extra = {}) {
  await page.evaluate((config) => window.mountFixture(config), { ...config, ...extra });
  await page.locator("#opener").waitFor();
}
async function openProject(page, other = false) {
  const opener = page.locator(other ? "#second" : "#opener");
  for (let i = 0; i < 20 && !(await focused(opener)); i++) await page.keyboard.press("Tab");
  assert.equal(await focused(opener), true);
  await page.keyboard.press("Enter");
  return opener;
}
async function visible(locator, message) {
  const result = await locator.evaluate((node) => {
    const b = node.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let p = node.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        r = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
        clip.left = Math.max(clip.left, r.left);
        clip.right = Math.min(clip.right, r.right);
      }
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) {
        clip.top = Math.max(clip.top, r.top);
        clip.bottom = Math.min(clip.bottom, r.bottom);
      }
    }
    return {
      box: b.toJSON(),
      clip,
      full:
        b.width > 0 &&
        b.height > 0 &&
        b.left >= clip.left - 1 &&
        b.right <= clip.right + 1 &&
        b.top >= clip.top - 1 &&
        b.bottom <= clip.bottom + 1,
      hit: node.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
    };
  });
  assert.equal(result.full && result.hit, true, `${message}: ${JSON.stringify(result)}`);
}
async function inspect(page, config, phase) {
  const data = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]'),
      body = dialog.querySelector('[role="region"]');
    const box = (node) => ({
      ...node.getBoundingClientRect().toJSON(),
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
    });
    const nodes = [dialog, ...dialog.querySelectorAll("*")];
    for (let p = dialog.parentElement; p; p = p.parentElement) nodes.push(p);
    return {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      visualViewport: {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        scale: window.visualViewport.scale,
      },
      dialog: box(dialog),
      body: box(body),
      activeInside: dialog.contains(document.activeElement),
      hiddenScroll: nodes
        .filter((node) => {
          const s = getComputedStyle(node);
          return (
            (/hidden|clip/.test(s.overflowY) && node.scrollTop !== 0) ||
            (/hidden|clip/.test(s.overflowX) && node.scrollLeft !== 0)
          );
        })
        .map((node) => ({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft })),
    };
  });
  if (electronMode)
    data.native = await browser.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { contentBounds: win.getContentBounds(), zoom: win.webContents.getZoomFactor() };
    });
  reports.push({ ...config, phase, ...data });
  assert.equal(data.width, config.width);
  assert.equal(data.height, config.height);
  assert.equal(data.dialog.scrollTop, 0);
  assert.equal(data.dialog.scrollLeft, 0);
  assert.ok(data.dialog.scrollWidth <= data.dialog.clientWidth + 1);
  assert.ok(
    data.dialog.x >= 0 &&
      data.dialog.y >= 0 &&
      data.dialog.right <= config.width + 1 &&
      data.dialog.bottom <= config.height + 1,
    JSON.stringify({ ...config, phase, ...data }),
  );
  assert.deepEqual(data.hiddenScroll, []);
  assert.equal(data.activeInside, true);
  return data;
}
async function waitScroll(body) {
  await body.evaluate(
    (node) =>
      new Promise((resolve) => {
        let previous = node.scrollTop,
          stable = 0;
        const frame = () => {
          const current = node.scrollTop;
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 8) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}
async function bodyScroll(page, dialog) {
  const body = dialog.getByRole("region");
  const overflow = await body.evaluate((node) => node.scrollHeight - node.clientHeight);
  if (overflow <= 1) return;
  await body.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="dialog"] [role="region"]');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await waitScroll(body);
  await page.keyboard.press("Home");
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] [role="region"]').scrollTop === 0,
  );
  await waitScroll(body);
  const box = await body.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] [role="region"]').scrollTop > 0,
  );
}
async function exercise(page, config) {
  await mount(page, config);
  await page.evaluate((root) => window.fixture.holdRisk.add(root), rootA);
  const opener = await openProject(page);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  const viewOnly = dialog.getByRole("button", {
      name: labels(config.language).viewOnly,
      exact: true,
    }),
    trust = dialog.getByRole("button", { name: labels(config.language).trust, exact: true });
  assert.equal(await focused(viewOnly), true);
  await inspect(page, config, "initial");
  await visible(viewOnly, "Initial safe choice");
  await visible(trust, "Initial trust choice");
  await page.evaluate(
    (root) =>
      window.fixture.pendingRisk[root].resolve({
        permissionRules: 4,
        envKeys: ["NODE_ENV", "HTTPS_PROXY", "PACKAGE_MANAGER_CACHE_PATH"],
        hooks: 2,
        mcpServers: ["filesystem", "docs-search", "project-database"],
        setupScripts: true,
      }),
    rootA,
  );
  await dialog.locator("li").last().waitFor();
  await settle(page);
  assert.equal(await focused(viewOnly), true);
  await visible(viewOnly, "Late risk summary keeps focused choice visible");
  await visible(trust, "Late risk summary keeps both choices visible");
  await visible(dialog.getByRole("heading"), "Trust title remains visible");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i < 6 ? "Tab" : "Shift+Tab");
    await settle(page);
    await inspect(page, config, "keyboard-" + i);
    await visible(page.locator(":focus"), "Focused control remains visible");
  }
  await bodyScroll(page, dialog);
  await viewOnly.focus();
  await inspect(page, config, "scrolled");
  await visible(viewOnly, "View only after real Wheel");
  await visible(trust, "Trust after real Wheel");
  await visible(dialog.getByRole("heading"), "Header after real Wheel");
  await screenshot(
    page,
    path.join(output, `${config.language}-${config.theme}-${config.width}x${config.height}.png`),
  );
  if (electronMode && config.width === 760)
    for (const [width, height] of [
      [320, 240],
      [390, 360],
      [390, 600],
      [760, 480],
    ]) {
      await resizeNative(width, height);
      await animate(dialog);
      await settle(page);
      assert.equal(await focused(viewOnly), true);
      await inspect(page, { ...config, width, height }, "native-resize");
      await visible(viewOnly, "Resize preserves the focused choice");
      await visible(trust, "Resize preserves the other choice");
    }
  await page.keyboard.press("Escape");
  await page.mouse.click(1, 1);
  assert.equal(await dialog.count(), 1, "Trust requires an explicit decision");
  await viewOnly.click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Explicit decision returns to its actual opener");
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(calls.decisions, [{ path: rootA, level: "untrusted" }]);
  assert.deepEqual(calls.notified, [{ projectPath: rootA, level: "untrusted" }]);
  reports.push({ ...config, phase: "explicit-view-only", calls });
}
async function behaviors(page, config) {
  const names = labels(config.language);
  await mount(page, config);
  await page.evaluate(
    (root) => (window.fixture.readErrors[root] = "Owned trust read failed"),
    rootA,
  );
  let opener = await openProject(page),
    dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  let retry = dialog.getByRole("button", { name: names.retry, exact: true });
  await dialog.getByRole("alert").filter({ hasText: "Owned trust read failed" }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: names.trust, exact: true }).count(),
    0,
    "A read error does not manufacture an unknown trust decision",
  );
  assert.equal(await focused(retry), true);
  await visible(dialog.getByRole("alert"), "Read error is visible with its recovery button");
  await visible(retry, "Read recovery is initially visible");
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, []);
  await page.evaluate((root) => {
    window.fixture.holdRead.add(root);
    delete window.fixture.readErrors[root];
  }, rootA);
  await retry.evaluate((node) => {
    node.click();
    node.click();
  });
  await page.waitForFunction(
    (root) =>
      window.calls.reads.filter((call) => call.method === "getTrust" && call.path === root)
        .length === 2,
    rootA,
  );
  assert.equal(await focused(retry), true);
  assert.equal(await retry.getAttribute("aria-disabled"), "true");
  await page.evaluate(
    (root) => window.fixture.pendingRead[root].reject(Error("Owned retry read failed")),
    rootA,
  );
  await dialog.getByRole("alert").filter({ hasText: "Owned retry read failed" }).waitFor();
  assert.equal(await focused(retry), true);
  await visible(retry, "A failed retry retains its exact button");
  await page.keyboard.press("Escape");
  await page.mouse.click(1, 1);
  assert.equal(await dialog.count(), 1, "Read recovery still requires an explicit result");
  await retry.click();
  await page.waitForFunction(
    (root) =>
      window.calls.reads.filter((call) => call.method === "getTrust" && call.path === root)
        .length === 3,
    rootA,
  );
  await page.evaluate((root) => {
    window.fixture.holdRead.delete(root);
    window.fixture.pendingRead[root].resolve("unknown");
  }, rootA);
  let viewOnly = dialog.getByRole("button", { name: names.viewOnly, exact: true });
  await viewOnly.waitFor();
  await settle(page);
  assert.equal(
    await focused(viewOnly),
    true,
    "Successful retry hands off only its removed focused button",
  );
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, []);
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
  await inspect(page, config, "read-recovered-unknown");
  await dialog.getByRole("button", { name: names.trust, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true);
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, [
    { path: rootA, level: "trusted" },
  ]);
  reports.push({
    ...config,
    behavior: "read-retry-held-rejection-to-explicit-choice",
    calls: await page.evaluate(() => window.calls),
  });

  for (const external of ["none", "focus", "blur"]) {
    await mount(page, config);
    await page.evaluate(
      (root) => (window.fixture.readErrors[root] = "Owned read boundary error"),
      rootA,
    );
    opener = await openProject(page);
    dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await animate(dialog);
    retry = dialog.getByRole("button", { name: names.retry, exact: true });
    await page.evaluate((root) => {
      delete window.fixture.readErrors[root];
      window.fixture.holdRead.add(root);
    }, rootA);
    await retry.click();
    await page.waitForFunction((root) => !!window.fixture.pendingRead[root], rootA);
    if (external === "focus")
      await page.evaluate(() => document.querySelector("#external").focus());
    if (external === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate((root) => window.fixture.pendingRead[root].resolve("trusted"), rootA);
    await dialog.waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(
      await focused(opener),
      external === "none",
      "A known trusted result preserves actual return ownership",
    );
    assert.deepEqual((await page.evaluate(() => window.calls)).decisions, []);
    assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
    reports.push({
      ...config,
      behavior: "read-retry-known-trusted-external-" + external,
      calls: await page.evaluate(() => window.calls),
    });
  }
  for (const [level, prompt] of [
    ["trusted", false],
    ["untrusted", false],
    ["untrusted", true],
  ]) {
    await mount(page, config, { levels: { [rootA]: level }, promptWhenUntrusted: prompt });
    await openProject(page);
    await page.waitForFunction(() => window.calls.reads.length > 0);
    await settle(page);
    dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.count(),
      Number(prompt),
      "Known trust and re-prompt semantics stay unchanged",
    );
    assert.deepEqual((await page.evaluate(() => window.calls)).decisions, []);
    if (prompt) {
      await animate(dialog);
      await dialog.getByRole("button", { name: names.viewOnly, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    reports.push({
      ...config,
      behavior: "known-" + level + "-prompt-" + prompt,
      calls: await page.evaluate(() => window.calls),
    });
  }
  await mount(page, config);
  await page.evaluate((root) => window.fixture.holdWrite.add(root), rootA);
  opener = await openProject(page);
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  viewOnly = dialog.getByRole("button", { name: names.viewOnly, exact: true });
  await viewOnly.evaluate((node) => {
    node.click();
    node.click();
  });
  await page.waitForFunction(() => window.calls.decisions.length === 1);
  const box = await viewOnly.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal(
    (await page.evaluate(() => window.calls)).decisions.length,
    1,
    "Same-turn DOM, real double-click and keyboard cannot duplicate a pending decision",
  );
  await inspect(page, config, "pending-decision");
  await visible(viewOnly, "Pending choice retains focus and geometry");
  assert.equal(await focused(viewOnly), true);
  await page.evaluate((root) => {
    window.fixture.holdWrite.delete(root);
    window.fixture.pendingWrite[root].reject(
      Error("Owned trust write failed " + "failure_context_".repeat(24)),
    );
  }, rootA);
  await dialog.getByRole("alert").filter({ hasText: "Owned trust write failed" }).waitFor();
  await settle(page);
  assert.equal(await focused(viewOnly), true);
  await visible(viewOnly, "Rejected choice is still retryable");
  await visible(dialog.getByRole("alert"), "Long decision error remains visibly bounded");
  await visible(dialog.getByRole("heading"), "Decision error keeps the title visible");
  await visible(
    dialog.getByRole("button", { name: names.trust, exact: true }),
    "Decision error keeps the other choice visible",
  );
  await inspect(page, config, "long-decision-error");
  await page.evaluate(
    (root) => (window.fixture.writeErrors[root] = "Owned repeated decision failed"),
    rootA,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.calls.decisions.length === 2);
  await dialog.getByRole("alert").filter({ hasText: "Owned repeated decision failed" }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, [
    { path: rootA, level: "untrusted" },
    { path: rootA, level: "untrusted" },
  ]);
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
  await page.evaluate((root) => delete window.fixture.writeErrors[root], rootA);
  await dialog.getByRole("button", { name: names.trust, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true);
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, [
    { projectPath: rootA, level: "trusted" },
  ]);
  reports.push({
    ...config,
    behavior: "pending-single-decision-error-retry",
    calls: await page.evaluate(() => window.calls),
  });

  await mount(page, config);
  await page.evaluate((root) => window.fixture.holdRead.add(root), rootA);
  await openProject(page);
  await page.waitForFunction((root) => !!window.fixture.pendingRead[root], rootA);
  await page.evaluate((root) => window.selectRoot(root), rootB);
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByText(rootB, { exact: true }).waitFor();
  await animate(dialog);
  await page.evaluate((root) => window.fixture.pendingRead[root].resolve("trusted"), rootA);
  await settle(page);
  assert.equal(await dialog.count(), 1);
  await dialog.getByText(rootB, { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, []);
  reports.push({
    ...config,
    behavior: "old-root-read-cannot-replace-new-root",
    calls: await page.evaluate(() => window.calls),
  });

  await mount(page, config);
  await page.evaluate(
    (roots) => roots.forEach((root) => window.fixture.holdWrite.add(root)),
    [rootA, rootB],
  );
  await openProject(page);
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  await dialog.getByRole("button", { name: names.viewOnly, exact: true }).click();
  await page.waitForFunction(() => window.calls.decisions.length === 1);
  await page.evaluate((root) => window.selectRoot(root), rootB);
  await dialog.getByText(rootB, { exact: true }).waitFor();
  await animate(dialog);
  const trust = dialog.getByRole("button", { name: names.trust, exact: true });
  assert.equal(
    await trust.getAttribute("aria-disabled"),
    "false",
    "The new root does not inherit the old pending state",
  );
  await trust.click();
  await page.waitForFunction(() => window.calls.decisions.length === 2);
  await page.evaluate((root) => window.fixture.pendingWrite[root].resolve(), rootA);
  await settle(page);
  await dialog.getByText(rootB, { exact: true }).waitFor();
  assert.equal(
    await trust.getAttribute("aria-disabled"),
    "true",
    "Old finally cannot unlock a new pending decision",
  );
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
  await page.evaluate(
    (root) => window.fixture.pendingWrite[root].reject(Error("Owned B decision failed")),
    rootB,
  );
  await dialog.getByRole("alert").filter({ hasText: "Owned B decision failed" }).waitFor();
  assert.equal(await focused(trust), true);
  await visible(trust, "New-root failure remains in its own footer");
  await page.evaluate((root) => window.fixture.holdWrite.delete(root), rootB);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, [
    { path: rootA, level: "untrusted" },
    { path: rootB, level: "trusted" },
    { path: rootB, level: "trusted" },
  ]);
  assert.deepEqual((await page.evaluate(() => window.calls)).notified, [
    { projectPath: rootB, level: "trusted" },
  ]);
  reports.push({
    ...config,
    behavior: "late-old-decision-cannot-close-or-unlock-new-root",
    calls: await page.evaluate(() => window.calls),
  });

  await mount(page, config);
  await page.evaluate((root) => window.fixture.holdRisk.add(root), rootA);
  await openProject(page);
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForFunction((root) => !!window.fixture.pendingRisk[root], rootA);
  await page.evaluate((root) => window.selectRoot(root), rootB);
  await dialog.getByText(rootB, { exact: true }).waitFor();
  await page.evaluate(
    (root) =>
      window.fixture.pendingRisk[root].resolve({
        permissionRules: 99,
        envKeys: ["OLD_ROOT_RISK"],
        hooks: 99,
        mcpServers: ["OLD_ROOT_SERVER"],
        setupScripts: true,
      }),
    rootA,
  );
  await settle(page);
  assert.equal((await dialog.textContent()).includes("OLD_ROOT_RISK"), false);
  assert.equal((await dialog.textContent()).includes("OLD_ROOT_SERVER"), false);
  reports.push({ ...config, behavior: "late-old-risk-summary-cannot-replace-new-root" });
  await mount(page, config);
  await page.evaluate(() => (window.fixture.riskFailure = true));
  await openProject(page);
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  assert.equal(await dialog.getByRole("alert").count(), 0, "The risk summary remains best-effort");
  await visible(
    dialog.getByRole("button", { name: names.viewOnly, exact: true }),
    "Risk summary failure keeps explicit view-only available",
  );
  await dialog.getByRole("button", { name: names.viewOnly, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, [
    { path: rootA, level: "untrusted" },
  ]);
  reports.push({ ...config, behavior: "risk-summary-best-effort" });
  for (const kind of ["read", "write"]) {
    await mount(page, config);
    await page.evaluate(
      ({ root, kind }) => window.fixture[kind === "read" ? "holdRead" : "holdWrite"].add(root),
      { root: rootA, kind },
    );
    await openProject(page);
    if (kind === "write") {
      dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await animate(dialog);
      await dialog.getByRole("button", { name: names.viewOnly, exact: true }).click();
      await page.waitForFunction((root) => !!window.fixture.pendingWrite[root], rootA);
    } else await page.waitForFunction((root) => !!window.fixture.pendingRead[root], rootA);
    await page.evaluate(
      ({ root, kind }) => {
        window.unmountFixture();
        document.querySelector("#outside").focus();
        if (kind === "read") window.fixture.pendingRead[root].resolve("unknown");
        else window.fixture.pendingWrite[root].reject(Error("Owned unmounted write rejection"));
      },
      { root: rootA, kind },
    );
    await settle(page);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await focused(page.locator("#outside")), true);
    assert.deepEqual((await page.evaluate(() => window.calls)).notified, []);
    reports.push({
      ...config,
      behavior: "unmounted-" + kind + "-completion",
      calls: await page.evaluate(() => window.calls),
    });
  }
}
async function shortError(page, config) {
  await mount(page, config);
  await page.evaluate((root) => {
    window.fixture.writeErrors[root] =
      "Owned long error " + "failure_context_".repeat(80) + " owned-error-end";
  }, rootA);
  const opener = await openProject(page);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  const names = labels(config.language),
    viewOnly = dialog.getByRole("button", { name: names.viewOnly, exact: true });
  await viewOnly.click();
  const alert = dialog.getByRole("alert");
  await alert.filter({ hasText: "owned-error-end" }).waitFor();
  await inspect(page, config, "short-long-error");
  await visible(dialog.getByRole("heading"), "Short error header");
  await visible(alert, "Short error remains readable in its own scroll area");
  await visible(viewOnly, "Short error view-only action");
  await visible(
    dialog.getByRole("button", { name: names.trust, exact: true }),
    "Short error trust action",
  );
  assert.ok(
    await dialog.getByRole("region").evaluate((node) => node.clientHeight >= 48),
    "Keep a readable detail region alongside the error",
  );
  await alert.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="alert"]');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await waitScroll(alert);
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector('[role="alert"]').scrollTop === 0);
  await waitScroll(alert);
  const box = await alert.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelector('[role="alert"]').scrollTop > 0);
  await viewOnly.focus();
  await inspect(page, config, "short-error-keyboard-wheel");
  await screenshot(
    page,
    path.join(output, `long-error-${config.language}-${config.theme}-320x240.png`),
  );
  await page.evaluate((root) => delete window.fixture.writeErrors[root], rootA);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true);
  assert.deepEqual((await page.evaluate(() => window.calls)).decisions, [
    { path: rootA, level: "untrusted" },
    { path: rootA, level: "untrusted" },
  ]);
  reports.push({
    ...config,
    phase: "short-error-explicit-retry",
    calls: await page.evaluate(() => window.calls),
  });
}
try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [390, 600],
        [760, 480],
        [1280, 720],
      ]) {
        const config = {
          language,
          theme,
          width,
          height,
          zoom: electronMode && theme === "dark" && height <= 360 ? 2 : 1,
        };
        nativeZoom = config.zoom;
        const context = electronMode
          ? nativeContext
          : await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
        if (!electronMode || reports.length === 0)
          await context.route("**/*", (route) => {
            if (route.request().url() === "http://trust-owned.test/")
              return route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><button id="outside" style="position:fixed;right:0;bottom:0;z-index:200;pointer-events:auto">Outside owner</button>',
              });
            blocked.push(route.request().url());
            return route.abort();
          });
        const page = (lastPage = electronMode
          ? await browser.firstWindow()
          : await context.newPage());
        if (!electronMode || reports.length === 0)
          page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(5000);
        await page.goto("http://trust-owned.test/");
        if (electronMode) await resizeNative(width, height);
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        if (width === 320) await shortError(page, config);
        else await exercise(page, config);
        if (width === 390 && height === 360 && theme === "light") await behaviors(page, config);
        if (!electronMode) await context.close();
      }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  completed = true;
  console.log(
    JSON.stringify({
      output,
      electronMode,
      development,
      layouts: 20,
      observations: reports.length,
      errors,
      blocked,
    }),
  );
} finally {
  if (!completed && lastPage && !lastPage.isClosed())
    await screenshot(lastPage, path.join(output, "failure.png")).catch(() => {});
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ desktop, electronMode, development, reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
