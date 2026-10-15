/** Actual chooser/manager/sign-in components, synthetic authority and strictly owned IPC only. */
/* global window, document, innerWidth, innerHeight, requestAnimationFrame, getComputedStyle, HTMLElement, Event, PointerEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const sourceDesktop = sourceIndex < 0 ? desktop : path.resolve(process.argv[sourceIndex + 1]);
const renderer = path.join(sourceDesktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild"),
  { chromium, _electron } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node"),
  { Scanner } = tw("@tailwindcss/oxide");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-cloud-dialogs-"));
const development = process.argv.includes("--development");
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useNewProjectDialog} from './projects/NewProjectDialog';
import {CloudProjectSignIn} from './projects/CloudProjectSignIn';
import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';import {saveTheme,applyTheme} from './theme';
const projectId='20000000-0000-4000-8000-000000000001';
const account={state:'signed-in',origin:'https://account-owned.test',account:{id:'10000000-0000-4000-8000-000000000001',username:'Owned account'}};
const binding={id:'30000000-0000-4000-8000-000000000001',localProjectId:'40000000-0000-4000-8000-000000000001',origin:'https://cloud-owned.test',environmentId:'50000000-0000-4000-8000-000000000001',environmentName:('Environment'+('N'.repeat(128))).slice(0,128),remoteProjectId:projectId,remoteProjectName:('Project'+('P'.repeat(80))).slice(0,80)};
const project={id:projectId,name:binding.remoteProjectName,status:'stopped',generation:1,createdAt:1,updatedAt:1};
const f=window.fixture={calls:{login:[],management:[],linked:[],local:0,reconnect:0},pending:[],listeners:new Set(),menu:new Set(),project,binding,account,
 fail(message='Owned rejection '+('hash'.repeat(250))+'\\nFull final line'){this.pending.splice(0).forEach(p=>p.reject(new Error(message)));},
 resolve(value){this.pending.splice(0).forEach(p=>p.resolve(value));},
 discovery(overrides={}){return {origin:binding.origin,authenticated:true,environment:{id:binding.environmentId,name:binding.environmentName},projects:[{id:project.id,name:project.name}],...overrides};},
 status(value){this.listeners.forEach(fn=>fn(value));},
 result(action){return action==='list'?{action,available:true,projects:Array.from({length:18},(_,i)=>({...project,id:i===0?projectId:'20000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),name:(String(i+1)+'-'+project.name).slice(0,80)}))}:action==='logout'?{action,revoked:true}:{action,project:{...project,status:action==='start'?'running':'stopped'},address:binding.origin};}};
const held=()=>new Promise((resolve,reject)=>f.pending.push({resolve,reject}));
window.codeshell=new Proxy({
 onMenuEvent:fn=>{f.menu.add(fn);return()=>f.menu.delete(fn)},
 cloudAccount:{status:async()=>account,capabilities:async()=>({}),onStatus:fn=>{f.listeners.add(fn);return()=>f.listeners.delete(fn)}},
 credentials:{list:async()=>[]},
 cloudEnvironment:{login:params=>{f.calls.login.push(structuredClone(params));return held()}},
 openCloudWorkbench:params=>{f.calls.management.push(structuredClone(params));return held()},log(){}
},{get:(o,k)=>{if(k in o)return o[k];throw new Error('Denied bridge '+String(k))}});
const root=createRoot(document.getElementById('root'));let generation=0;
function Fixture({kind}){const[current,setCurrent]=React.useState(binding);f.changeBinding=()=>setCurrent({...binding,id:'30000000-0000-4000-8000-000000000002',remoteProjectId:'20000000-0000-4000-8000-000000000002'});
 const[open,dialog]=useNewProjectDialog(()=>{f.calls.local++;return held()},{cloudBindings:kind==='linked'?[binding]:[],onOpenCloudProject:b=>{f.calls.linked.push(structuredClone(b));return held()}});
 return <main className='fixed inset-0 bg-background text-foreground'><button id='opener' onClick={open}>Open project chooser</button><input id='outside' aria-label='Outside'/>{kind==='signin'?<CloudProjectSignIn binding={current} required reconnect={async()=>{f.calls.reconnect++}}/>:dialog}</main>}
window.mountFixture=({language='en',theme='light',kind='signin',short=false}={})=>{localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);if(short){binding.environmentName='Owned environment';binding.remoteProjectName='Owned project'}f.calls={login:[],management:[],linked:[],local:0,reconnect:0};root.render(<React.StrictMode><I18nProvider key={++generation}><Fixture kind={kind}/></I18nProvider></React.StrictMode>)};
window.unmountFixture=()=>root.render(null);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
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
const native = process.argv.includes("--electron-zoom");
let browser,
  electron,
  server,
  nativeDirectory,
  origin = "http://cloud-dialogs-owned.test/";
if (native) {
  const { createServer } = await import("node:http");
  nativeDirectory = await mkdtemp(path.join(tmpdir(), "codeshell-cloud-native-"));
  server = createServer((request, response) => {
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? '<!doctype html><html><div id="root"></div>' : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port + "/";
  const entry = path.join(nativeDirectory, "main.cjs");
  await writeFile(
    entry,
    `const{app,session}=require('electron');global.blocked=[];app.on('window-all-closed',()=>{});app.setPath('userData',process.env.FIXTURE_USER_DATA);app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>{const denied=details.url!==process.env.FIXTURE_ORIGIN;if(denied)global.blocked.push(details.url);callback({cancel:denied})});});`,
  );
  try {
    electron = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      env: {
        ...process.env,
        FIXTURE_ORIGIN: origin,
        FIXTURE_USER_DATA: path.join(nativeDirectory, "data"),
      },
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await rm(nativeDirectory, { recursive: true, force: true });
    throw error;
  }
} else
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CODESHELL_TEST_CHROMIUM || chromium.executablePath(),
  });
const reports = [],
  errors = [],
  blocked = [];
let page, context;
const focusToken = () =>
  page.evaluate(() => {
    const n = document.activeElement;
    return n === document.body
      ? "BODY"
      : [n?.tagName, n?.id, n?.getAttribute("type"), n?.getAttribute("aria-label")].join("|");
  });
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const labels = (lang) =>
  lang === "zh"
    ? {
        cloud: "云端",
        local: "此计算机",
        signIn: "重新登录",
        reload: "重新加载项目",
        start: "启动",
        create: "创建",
        name: "新项目名称",
      }
    : {
        cloud: "Cloud",
        local: "This computer",
        signIn: "Sign in again",
        reload: "Reload projects",
        start: "Start",
        create: "Create",
        name: "New project name",
      };
async function mount(config = {}) {
  await context?.close();
  if (native) {
    const next = electron.waitForEvent("window");
    await electron.evaluate(
      ({ BrowserWindow }, config) => {
        const zoom = config.theme === "dark" ? 2 : 1;
        const win = new BrowserWindow({
          width: (config.width ?? 390) * zoom,
          height: (config.height ?? 360) * zoom,
          frame: false,
          show: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        win.webContents.setZoomFactor(zoom);
        win.loadURL(config.origin);
      },
      { ...config, origin },
    );
    page = await next;
    context = {
      close: async () => {
        await page.close();
      },
    };
    await page.waitForLoadState("domcontentloaded");
    await electron.evaluate(
      ({ BrowserWindow }, zoom) => {
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
      },
      config.theme === "dark" ? 2 : 1,
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      {
        width: config.width ?? 390,
        height: config.height ?? 360,
      },
    );
  } else {
    context = await browser.newContext({
      viewport: { width: config.width ?? 390, height: config.height ?? 360 },
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      route.request().url() === origin
        ? route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
          })
        : (blocked.push(route.request().url()), route.abort()),
    );
    page = await context.newPage();
    await page.goto(origin);
  }
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [
    config.width ?? 390,
    config.height ?? 360,
  ]);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({
    content: `const NativeResizeObserver=window.ResizeObserver;window.heldResize=[];window.holdResize=false;window.ResizeObserver=class extends NativeResizeObserver{constructor(callback){super((entries,observer)=>{if(window.holdResize)window.heldResize.push(()=>callback(entries,observer));else callback(entries,observer)})}};`,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (native) {
    await electron.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      window.focus();
      window.webContents.focus();
    });
    await page.waitForFunction(() => document.hasFocus());
  }
  await page.evaluate((config) => window.mountFixture(config), config);
  await frames();
  const trigger =
    config.kind === "signin"
      ? page.getByRole("button", { name: labels(config.language).signIn, exact: true })
      : page.locator("#opener");
  await trigger.click();
  await dialog().waitFor();
  await page.waitForTimeout(230);
  await frames();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    config.theme === "dark",
  );
}
const dialog = () => page.getByRole("dialog");
const inputs = () => dialog().locator("input");
const password = () => dialog().locator("input[type=password]");
const close = () => dialog().getByRole("button", { name: "Close", exact: true });
const submit = () => dialog().locator("button[type=submit]");
async function visible(locator, oversize = false) {
  const result = await locator.evaluate((node, oversize) => {
    const r = node.getBoundingClientRect();
    let top = 0,
      bottom = innerHeight,
      left = 0,
      right = innerWidth;
    for (let p = node.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        b = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) {
        top = Math.max(top, b.top);
        bottom = Math.min(bottom, b.bottom);
      }
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
        left = Math.max(left, b.left);
        right = Math.min(right, b.right);
      }
    }
    const ok =
      r.width > 0 &&
      r.height > 0 &&
      r.left >= left - 1 &&
      r.right <= right + 1 &&
      (oversize
        ? Math.min(r.bottom, bottom) - Math.max(r.top, top) >= Math.min(32, r.height)
        : r.top >= top - 1 && r.bottom <= bottom + 1);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok,
      hit: !!hit && node.contains(hit),
      box: r.toJSON(),
      active: node === document.activeElement,
    };
  }, oversize);
  assert.ok(result.ok && result.hit, JSON.stringify(result));
  return result;
}
async function inspect(label, config = {}) {
  const layout = await dialog().evaluate((root) => {
    const violations = [];
    for (const node of [root, ...root.querySelectorAll("*")]) {
      if (!(node instanceof HTMLElement) || node.classList.contains("sr-only")) continue;
      if (
        !/INPUT|SVG|PATH/.test(node.tagName) &&
        node.clientWidth > 0 &&
        node.scrollWidth > node.clientWidth + 1
      )
        violations.push({
          tag: node.tagName,
          role: node.getAttribute("role"),
          client: node.clientWidth,
          scroll: node.scrollWidth,
        });
    }
    const hidden = [];
    const all = [root, ...root.querySelectorAll("*")];
    for (let p = root.parentElement; p; p = p.parentElement) all.push(p);
    for (const node of all) {
      if (!(node instanceof HTMLElement)) continue;
      const s = getComputedStyle(node);
      if (
        (/hidden|clip/.test(s.overflowY) && node.scrollTop !== 0) ||
        (/hidden|clip/.test(s.overflowX) && node.scrollLeft !== 0)
      )
        hidden.push({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft });
    }
    return {
      violations,
      hidden,
      box: root.getBoundingClientRect().toJSON(),
      document: [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        innerWidth,
        innerHeight,
      ],
    };
  });
  assert.deepEqual(layout.violations, [], label + " inner widths");
  assert.deepEqual(layout.hidden, [], label + " hidden ancestors");
  assert.ok(
    layout.document[0] <= layout.document[2] + 1 && layout.document[1] <= layout.document[3] + 1,
    JSON.stringify(layout),
  );
  if (await close().count()) await visible(close());
  const zoom = native
    ? await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      )
    : 1;
  if (native && config.theme) assert.equal(zoom, config.theme === "dark" ? 2 : 1);
  reports.push({ label, ...config, zoom, layout });
}
async function wheel(locator) {
  if (await locator.evaluate((n) => n.scrollTop > 0)) {
    await locator.focus();
    await locator.press("Home");
    await page.waitForTimeout(300);
  }
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction((node) => node.scrollTop > 0, await locator.elementHandle());
}
async function login() {
  await inputs().nth(1).fill("  owned-user  ");
  await password().fill("synthetic-owned-password");
  await submit().click();
  await frames();
  assert.equal(await password().inputValue(), "");
  await page.waitForFunction(() => window.fixture.pending.length === 1);
}
async function fail(message) {
  await page.evaluate((message) => window.fixture.fail(message), message);
  await dialog().getByRole("alert").waitFor();
  await frames();
}
async function cloud(lang) {
  await dialog()
    .getByRole("button", { name: labels(lang).cloud, exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector("[role=dialog] fieldset input"));
  await frames();
}
async function connect() {
  await inputs().first().fill("https://cloud-owned.test/");
  await submit().first().click();
  await frames();
  await page.evaluate(() => window.fixture.resolve(window.fixture.result("list")));
  await dialog().locator("li").first().waitFor();
}
async function ownedWire(action, index = 0) {
  const call = await page.evaluate((index) => window.fixture.calls.management[index], index);
  assert.equal(call.action, action);
  assert.equal(call.accountOrigin, "https://account-owned.test");
  assert.equal(call.accountId, "10000000-0000-4000-8000-000000000001");
  assert.equal(call.cloudOrigin, "https://cloud-owned.test");
  return call;
}
async function resize(width, height, zoom = 1) {
  if (native) {
    await electron.evaluate(
      ({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(width * zoom, height * zoom);
        window.webContents.setZoomFactor(zoom);
      },
      { width, height, zoom },
    );
  } else await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    { width, height },
  );
  await page.waitForTimeout(250);
  await frames();
}
try {
  if (!process.argv.includes("--behaviors-only"))
    for (const language of ["zh", "en"])
      for (const theme of ["light", "dark"])
        for (const [width, height] of native
          ? [[320, 240]]
          : [
              [320, 240],
              [390, 360],
              [800, 480],
            ])
          for (const kind of ["signin", "linked", "manager"]) {
            const config = { language, theme, width, height, kind };
            await mount(config);
            await inspect("initial", config);
            if (kind === "signin") {
              const description = page.locator(
                '[id="' + (await dialog().getAttribute("aria-describedby")) + '"]',
              );
              assert.equal((await description.textContent()).length, 211);
              if (await description.evaluate((n) => n.scrollHeight > n.clientHeight))
                await wheel(description);
              await login();
              await fail();
              await page.waitForFunction(
                () => document.activeElement?.getAttribute("type") === "password",
              );
              await visible(password());
              assert.equal(await inputs().nth(1).inputValue(), "  owned-user  ");
              assert.equal(
                await dialog().getByRole("alert").textContent(),
                "Owned rejection " + "hash".repeat(250) + "\nFull final line",
              );
              await inspect("login-rejected", config);
              const form = dialog().locator("form");
              await form.focus();
              await form.press("End");
              await page.waitForTimeout(300);
              assert.ok(await form.evaluate((n) => n.scrollTop > 0));
              await password().fill("synthetic-retry-draft");
              await page.keyboard.press("Tab");
              await page.keyboard.press("Tab");
              await visible(submit().last());
              const call = await page.evaluate(() => window.fixture.calls.login[0]);
              assert.deepEqual(call, {
                origin: "https://cloud-owned.test",
                username: "owned-user",
                password: "synthetic-owned-password",
              });
            } else {
              await cloud(language);
              if (kind === "linked") {
                const linked = dialog().getByRole("button", { name: /ProjectP/ });
                await linked.click();
                await frames();
                await fail();
                await page.waitForFunction(() =>
                  document.activeElement?.textContent?.includes("ProjectP"),
                );
                await visible(linked, true);
                assert.deepEqual(
                  await page.evaluate(() => window.fixture.calls.linked[0]),
                  await page.evaluate(() => window.fixture.binding),
                );
              } else {
                await connect();
                await ownedWire("list");
                const item = dialog().locator("li").first();
                assert.equal((await item.locator("p").first().textContent()).length, 80);
                await item
                  .getByRole("button", { name: labels(language).start, exact: true })
                  .click();
                await frames();
                await fail();
                assert.equal(
                  await dialog()
                    .getByRole("button", { name: labels(language).reload, exact: true })
                    .evaluate((n) => n === document.activeElement),
                  true,
                );
                await visible(
                  dialog().getByRole("button", { name: labels(language).reload, exact: true }),
                );
                assert.equal(
                  await item.getByRole("button").first().isDisabled(),
                  true,
                  "Uncertain response requires reload",
                );
                const call = await ownedWire("start", 1);
                assert.equal(call.projectId, "20000000-0000-4000-8000-000000000001");
              }
              await inspect(kind + "-rejected", config);
              const body = dialog().locator("[role=region][tabindex]");
              await wheel(body);
              await body.focus();
              await body.press("End");
              await page.waitForTimeout(300);
              assert.equal(
                await dialog().getByRole("alert").textContent(),
                "Owned rejection " + "hash".repeat(250) + "\nFull final line",
              );
            }
            await inspect("full-content", config);
            await page.screenshot({
              path: path.join(
                output,
                kind + "-" + language + "-" + theme + "-" + width + "x" + height + ".png",
              ),
            });
            await close().click();
            await dialog().waitFor({ state: "hidden" });
            await page.waitForFunction(
              () =>
                document.activeElement?.id === "opener" ||
                document.activeElement?.textContent === "重新登录" ||
                document.activeElement?.textContent === "Sign in again",
            );
          }
  // Held native disabling, actual IME, duplicate submit, and captured auth identity.
  for (const language of ["zh", "en"]) {
    await mount({ kind: "signin", language, short: true, width: 320, height: 240 });
    await inputs().nth(1).fill("owned");
    await password().fill("synthetic");
    await inputs().nth(1).dispatchEvent("compositionstart");
    await inputs().nth(1).dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      keyCode: 229,
      bubbles: true,
    });
    await dialog().locator("form").dispatchEvent("submit");
    assert.equal(await page.evaluate(() => window.fixture.calls.login.length), 0);
    await inputs().nth(1).dispatchEvent("compositionend");
    await login();
    await dialog().locator("form").dispatchEvent("submit");
    await page.keyboard.press("Escape");
    assert.equal(await dialog().isVisible(), true);
    assert.equal(await close().count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.calls.login.length), 1);
    await fail();
    await visible(password());
    assert.equal(await password().evaluate((n) => n === document.activeElement), true);
    await inspect("ime-duplicate-pending", { language });
    await password().fill("synthetic");
    await submit().click();
    await frames();
    await page.evaluate(() =>
      window.fixture.resolve(window.fixture.discovery({ origin: "https://different-owned.test" })),
    );
    await dialog().getByRole("alert").waitFor();
    await frames();
    assert.equal(await page.evaluate(() => window.fixture.calls.reconnect), 0);
    assert.equal(await password().inputValue(), "");
    await password().fill("synthetic");
    await submit().click();
    await frames();
    await page.evaluate(() => window.fixture.resolve(window.fixture.discovery()));
    await dialog().waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.fixture.calls.reconnect), 1);
    reports.push({ label: "verified-auth-wire", language });
  }
  for (const interruption of ["focus", "pointer", "blur", "binding", "unmount"]) {
    await mount({ kind: "signin", language: "en", short: true });
    await login();
    await page.evaluate((kind) => {
      if (kind === "focus") {
        document.querySelector("[role=dialog] input[readonly]").focus();
      }
      if (kind === "blur") window.dispatchEvent(new Event("blur"));
      if (kind === "binding") window.fixture.changeBinding();
      if (kind === "unmount") window.unmountFixture();
    }, interruption);
    if (interruption === "pointer") await page.mouse.click(2, 2);
    await frames();
    if (["binding", "unmount"].includes(interruption)) {
      await page.evaluate(() => window.fixture.resolve(window.fixture.discovery()));
      await frames();
      assert.equal(await page.evaluate(() => window.fixture.calls.reconnect), 0);
      await dialog().waitFor({ state: "hidden" });
      assert.equal(await dialog().count(), 0);
    } else {
      const before = await focusToken();
      await fail();
      assert.equal(await focusToken(), before, "Failure must not recover after " + interruption);
    }
    reports.push({ label: "login-owner-cancelled", interruption });
  }
  // Management identity, preserved drafts, uncertain guard, IME and whole chooser close guard.
  await mount({ kind: "manager", language: "en" });
  await cloud("en");
  await connect();
  const name = inputs().nth(1);
  await name.fill("  owned draft  ");
  await name.dispatchEvent("compositionstart");
  await name.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
    bubbles: true,
  });
  await dialog().locator("form").nth(1).dispatchEvent("submit");
  assert.equal(await page.evaluate(() => window.fixture.calls.management.length), 1);
  await name.dispatchEvent("compositionend");
  await submit().nth(1).click();
  await frames();
  await dialog().locator("form").nth(1).dispatchEvent("submit");
  await page.keyboard.press("Escape");
  assert.equal(await dialog().isVisible(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.management.length), 2);
  assert.equal((await ownedWire("create", 1)).name, "owned draft");
  await fail();
  assert.equal(await name.inputValue(), "  owned draft  ");
  await visible(dialog().getByRole("button", { name: "Reload projects", exact: true }));
  await submit().first().click();
  await frames();
  await page.evaluate(() => window.fixture.resolve(window.fixture.result("list")));
  await frames();
  await submit().nth(1).click();
  await frames();
  await page.evaluate(() => window.fixture.resolve(window.fixture.result("create")));
  await frames();
  assert.equal(await name.inputValue(), "");
  await inspect("manager-recovered");
  await dialog().locator("li").first().getByRole("button", { name: "Start", exact: true }).click();
  await frames();
  await page.evaluate(() => window.fixture.resolve(window.fixture.result("start")));
  await frames();
  await dialog()
    .locator("li")
    .first()
    .getByRole("button", { name: "Open cloud projects", exact: true })
    .click();
  await frames();
  const opened = await ownedWire("open", 5);
  assert.equal(opened.projectId, "20000000-0000-4000-8000-000000000001");
  await page.evaluate(() => window.fixture.resolve(window.fixture.result("open")));
  await dialog().waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "opener");
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("codeshell.cloud-workbench.v1")),
    "https://cloud-owned.test/",
  );
  reports.push({ label: "opened-exact-project" });
  for (const interruption of ["pointer", "blur", "account", "unmount"]) {
    await mount({ kind: "manager", language: "en" });
    await cloud("en");
    await connect();
    await dialog()
      .locator("li")
      .first()
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await frames();
    await page.evaluate((kind) => {
      if (kind === "blur") window.dispatchEvent(new Event("blur"));
      if (kind === "account")
        window.fixture.status({
          ...window.fixture.account,
          account: { id: "10000000-0000-4000-8000-000000000002", username: "Other owned account" },
        });
      if (kind === "unmount") window.unmountFixture();
    }, interruption);
    if (interruption === "pointer") await page.mouse.click(2, 2);
    await frames();
    const before = await focusToken();
    await page.evaluate(() => window.fixture.fail());
    await frames();
    assert.equal(await focusToken(), before);
    if (interruption === "account") assert.equal(await dialog().locator("li").count(), 0);
    reports.push({ label: "management-owner-cancelled", interruption });
  }
  await mount({ kind: "local", language: "en", width: 320, height: 240 });
  const local = dialog().getByRole("button", { name: "This computer", exact: true });
  await local.click();
  await frames();
  await fail("Owned local failure");
  await visible(local, true);
  assert.equal(await local.evaluate((n) => n === document.activeElement), true);
  await inspect("local-failure");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "opener");
  // Actual native File menu callback uses the same chooser lifecycle.
  await page.evaluate(() => window.fixture.menu.forEach((fn) => fn("add-project")));
  await dialog().waitFor();
  await frames();
  await close().click();
  await dialog().waitFor({ state: "hidden" });
  reports.push({ label: "native-menu-entry" });
  // Closing cannot reclaim focus after an explicit external interaction.
  for (const kind of ["signin", "local"]) {
    for (const interruption of ["focus", "pointer", "blur"]) {
      await mount({ kind, language: "en", short: true });
      await page.evaluate((interruption) => {
        if (interruption === "focus") document.getElementById("outside").focus();
        if (interruption === "pointer")
          document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        if (interruption === "blur") window.dispatchEvent(new Event("blur"));
      }, interruption);
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement?.id === "opener" ||
            document.activeElement?.textContent === "Sign in again",
        ),
        false,
      );
      reports.push({ label: "return-owner-cancelled", kind, interruption });
    }
    await mount({ kind, language: "en", short: true });
    await page.mouse.click(2, 2);
    await dialog().waitFor({ state: "hidden" });
    await page.waitForFunction(
      () =>
        document.activeElement?.id === "opener" ||
        document.activeElement?.textContent === "Sign in again",
    );
    reports.push({ label: "overlay-dismissal-return", kind });
  }
  for (const kind of ["signin", "manager"]) {
    await mount({ kind, language: "en", width: 800, height: 480 });
    let target;
    if (kind === "signin") {
      target = password();
      await target.fill("synthetic-resize-draft");
    } else {
      await cloud("en");
      await connect();
      target = dialog().locator("li").last().getByRole("button", { name: "Start", exact: true });
      await target.focus();
    }
    const token = await focusToken();
    for (const [width, height] of [
      [320, 240],
      [390, 360],
      [800, 480],
    ]) {
      await resize(width, height, native && width === 320 ? 2 : 1);
      assert.equal(await focusToken(), token, "Resize retains actual focus without refocusing");
      await visible(target);
      await inspect("live-resize-owned-focus", { kind, width, height });
    }
    if (kind === "signin") assert.equal(await target.inputValue(), "synthetic-resize-draft");
    await page.evaluate(() => {
      window.holdResize = true;
    });
    await resize(320, 240);
    assert.ok(await page.evaluate(() => window.heldResize.length > 0));
    await page.evaluate(() => window.unmountFixture());
    await frames();
    await page.locator("body").evaluate((node) => {
      node.tabIndex = -1;
      node.focus();
    });
    await page.evaluate(() => window.heldResize.splice(0).forEach((callback) => callback()));
    await frames();
    assert.equal(await focusToken(), "BODY");
    assert.equal(await dialog().count(), 0);
    reports.push({ label: "stale-resize-after-unmount", kind });
  }
  if (native) blocked.push(...(await electron.evaluate(() => globalThis.blocked)));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (native) {
    if (electron) {
      for (const url of await electron.evaluate(() => globalThis.blocked).catch(() => [])) {
        if (!blocked.includes(url)) blocked.push(url);
      }
      await electron.close();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (nativeDirectory) await rm(nativeDirectory, { recursive: true, force: true });
  } else await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ sourceDesktop, development, native, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ output, observations: reports.length, errors, blocked }));
}
