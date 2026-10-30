/* Actual Workbench Link management, production CSS, owned HTTP and exact request contracts.
 * All accounts/credentials/authorization steps are synthetic. No provider or OAuth browser launch.
 * --development uses StrictMode; --source-repo PATH checks an old implementation. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, HTMLElement, Event, KeyboardEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownRepo = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-repo");
const repo = sourceIndex < 0 ? ownRepo : path.resolve(process.argv[sourceIndex + 1]);
const require = createRequire(path.join(ownRepo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const out = await mkdtemp(path.join(tmpdir(), "codeshell-web-links-"));
const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {Workbench} from './Workbench';
const noop=()=>{};const root=createRoot(document.getElementById('root'));
function Fixture(){const [version,setVersion]=React.useState(0);window.refreshConfigurationFixture=()=>setVersion(n=>n+1);
const controller={panelSessionId:undefined,host:'desktop',workspaceApi:true,connection:'open',activeId:'owned',chat:{items:[],run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'New conversation',configuration:null,configurationVersion:version,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>window.authLost++};return <Workbench controller={controller}/>;}
window.authLost=0;window.unmountFixture=()=>root.render(null);root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: out,
  platform: "browser",
  format: "iife",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--development") ? "development" : "production",
    ),
  },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const errors = [],
  blocked = [],
  reports = [];
const origin = "http://web-links-owned.test";
const startUrl = origin + "/?view=links";

const onlyCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const longError = "Owned Link operation rejected: " + "合法diagnostic_".repeat(80) + "_FINAL";
const provider = {
  id: "owned-service",
  displayName: "Owned service",
  category: "developer",
  description: { zh: "Owned synthetic host service", en: "Owned synthetic host service" },
  brandText: "O",
  icon: "github",
  accent: "neutral",
  actionIds: ["owned.read"],
  tokenLabel: "Owned token",
  tokenPlaceholder: "Synthetic value only",
  actions: [
    { id: "owned.read", title: "Owned read", description: "Owned simulated read", risk: "read" },
  ],
  connectionMethods: [
    {
      id: "owned-local-token",
      displayName: { zh: "Owned token", en: "Owned token" },
      executionRuntime: "local",
      secretLocation: "device",
      authKind: "token",
      availability: "available",
    },
  ],
  authModes: [
    {
      id: "owned-credential",
      methodId: "owned-local-token",
      kind: "credential-input",
      label: "Owned token",
      preferred: true,
      available: true,
    },
  ],
};
const snapshot = () => ({
  providers: [provider],
  connections: Array.from({ length: 12 }, (_, i) => ({
    id: "owned-" + i,
    providerId: provider.id,
    methodId: "owned-local-token",
    label: i === 11 ? "界Name_".repeat(20).slice(0, 100) : "Owned connection " + i,
    runtime: "local",
    authSource: "manual-token",
    status: "connected",
    account: { id: "owned-account-" + i, label: "Owned account " + i, resources: [] },
    capabilityIds: ["owned.read"],
    revision: String(i).padStart(64, "0"),
    scope: "project",
    editable: true,
  })),
  capabilities: { token: true, cliBinding: false, deviceAuth: false, authorizationSteps: 1 },
  revision: "owned-snapshot",
});
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const active = (page) =>
  page.evaluate(() => ({
    tag: document.activeElement.tagName,
    label:
      document.activeElement.tagName === "BODY"
        ? null
        : document.activeElement.getAttribute("aria-label") ||
          document.activeElement.textContent.trim(),
    id: document.activeElement.id,
  }));
const editor = (page) => page.getByRole("dialog");
const lastCard = (page) => page.locator(".links-connection").last();
const manage = (page) => lastCard(page).getByRole("button", { name: "管理连接", exact: true });
const label = (page) => editor(page).getByRole("textbox", { name: "连接名称", exact: true });
const save = (page) => editor(page).getByRole("button", { name: "保存名称", exact: true });
async function geometry(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      box: box.toJSON(),
      focused: node === document.activeElement,
      hit: node === hit || node.contains(hit),
      dialog: node.closest("[role=dialog]")?.getBoundingClientRect().toJSON(),
      text: node.textContent,
      htmlWidth: document.documentElement.scrollWidth,
      htmlHeight: document.documentElement.scrollHeight,
      viewport: { width: innerWidth, height: innerHeight },
      scrollers: [
        ...(function* (el) {
          for (let p = el; p; p = p.parentElement) yield p;
        })(node),
      ]
        .filter((el) => el.scrollHeight > el.clientHeight)
        .map((el) => ({
          tag: el.tagName,
          cls: el.className,
          scroll: el.scrollTop,
          client: el.clientHeight,
          height: el.scrollHeight,
        })),
    };
  });
}
async function mount({
  width = 390,
  height = 360,
  readFail = false,
  theme = "light",
  touch = false,
  legacyConnection = false,
} = {}) {
  // Like the real Host, derive the attempt and its step from one instant. Two
  // Date.now() reads can straddle a millisecond, making the step outlive the
  // attempt; the client then correctly rejects the authorization as invalid.
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  const host = {
    snapshot: snapshot(),
    readFail,
    reads: 0,
    calls: [],
    pending: [],
    mode: "hold",
    authCalls: [],
    authPending: [],
    beginPending: [],
    holdBegin: false,
    responsePending: [],
    authReads: 0,
    auth: {
      id: "owned-authorization",
      providerId: provider.id,
      methodId: "owned-local-token",
      authModeId: "owned-credential",
      state: "pending",
      expiresAt,
      step: {
        id: "owned-step",
        kind: "credential-input",
        purpose: "credential",
        expiresAt,
        fields: [
          { id: "token", label: "Owned token", secret: true, required: true, maxLength: 16384 },
        ],
      },
    },
  };
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    serviceWorkers: "block",
    hasTouch: touch,
    isMobile: touch,
  });
  if (legacyConnection)
    host.snapshot.connections[0].id = `link-${provider.id}-${provider.connectionMethods[0].id}`;
  if (touch && !legacyConnection)
    host.snapshot.providers = [
      {
        ...provider,
        authModes: Array.from({ length: 18 }, (_, index) => ({
          ...provider.authModes[0],
          id: "owned-credential-" + index,
          label: "Owned authorization method " + index,
          preferred: index === 0,
        })),
      },
    ];
  const html =
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Outside field" style="position:fixed;bottom:0;right:0;width:60px;z-index:2001"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:2001"></div>';
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (request.url() === startUrl) return route.fulfill({ contentType: "text/html", body: html });
    if (url.origin !== origin) {
      blocked.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/api/v1/environment" && method === "GET")
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (url.pathname === "/api/v1/links" && method === "GET") {
      host.reads++;
      return route.fulfill({
        status: host.readFail ? 500 : 200,
        contentType: "application/json",
        body: JSON.stringify(host.readFail ? { error: longError } : host.snapshot),
      });
    }
    if (url.pathname === "/api/v1/links/connections/owned-11" && method === "PATCH") {
      const call = { method, path: url.pathname, query: url.search, body: request.postDataJSON() };
      host.calls.push(call);
      host.pending.push({ route, call });
      return;
    }
    if (url.pathname === "/api/v1/links/authorizations" && method === "POST") {
      host.authCalls.push({ method, path: url.pathname, body: request.postDataJSON() });
      if (host.holdBegin) {
        host.beginPending.push(route);
        return;
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(host.auth) });
    }
    if (url.pathname === "/api/v1/links/authorizations/owned-authorization" && method === "GET") {
      host.authReads++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(host.auth) });
    }
    if (
      url.pathname === "/api/v1/links/authorizations/owned-authorization/responses" &&
      method === "POST"
    ) {
      host.authCalls.push({ method, path: url.pathname, body: request.postDataJSON() });
      host.responsePending.push(route);
      return;
    }
    if (
      url.pathname === "/api/v1/links/authorizations/owned-authorization" &&
      method === "DELETE"
    ) {
      host.authCalls.push({ method, path: url.pathname });
      host.authPending.push(route);
      return;
    }
    blocked.push(request.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(startUrl);
  for (const file of bundle.outputFiles.filter((f) => f.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text });
  if (!readFail) await manage(page).waitFor();
  else await page.getByRole("alert").waitFor();
  await frames(page);
  return { page, context, host };
}
async function open(page) {
  await manage(page).focus();
  await page.keyboard.press("Enter");
  await editor(page).waitFor();
  await frames(page);
}
async function waitHeld(page, host) {
  const deadline = Date.now() + 5000;
  while (!host.pending.length) {
    assert.ok(Date.now() < deadline);
    await frames(page);
  }
  assert.equal(host.calls.length, 1);
}
async function finish(host, status = 500) {
  const pending = host.pending.shift();
  assert.ok(pending);
  if (status === 200)
    host.snapshot.connections = host.snapshot.connections.map((item) =>
      item.id === "owned-11"
        ? { ...item, label: pending.call.body.label, revision: "b".repeat(64) }
        : item,
    );
  await pending.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200 ? {} : { error: longError }),
  });
}
async function record(page, kind, extra = {}) {
  await frames(page);
  const bounds = await page.evaluate(() => {
    const node = document.activeElement,
      hidden = [];
    for (let p = node; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (
        p.hidden ||
        p.inert ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        hidden.push(p.tagName);
    }
    return {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      hidden,
    };
  });
  assert.ok(
    bounds.width <= bounds.viewportWidth + 1 && bounds.height <= bounds.viewportHeight + 1,
    JSON.stringify(bounds),
  );
  assert.deepEqual(bounds.hidden, []);
  reports.push({
    kind,
    viewport: page.viewportSize(),
    active: await active(page),
    bounds,
    ...extra,
  });
  console.log("LINKS", JSON.stringify({ kind, viewport: page.viewportSize() }));
  await page.screenshot({ path: path.join(out, kind + ".png") });
}

// Use trusted finger events rather than focus()/locator auto-scroll: those can
// programmatically move an overflow:hidden ancestor that a person cannot scroll.
async function swipe(page, gestures, surface, direction = 1, fingerX) {
  const box = await surface.boundingBox();
  const top = Math.max(box.y, 0) + 24;
  const bottom = Math.min(box.y + box.height, page.viewportSize().height) - 36;
  assert.ok(bottom - top > 60, "touch surface remains inside the viewport");
  const x = fingerX ?? box.x + box.width / 2;
  const start = direction > 0 ? bottom : top;
  const end = direction > 0 ? top : bottom;
  await gestures.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: start, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
  });
  try {
    for (let step = 1; step <= 12; step++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await gestures.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x, y: start + ((end - start) * step) / 12, radiusX: 4, radiusY: 4, force: 1, id: 1 },
        ],
      });
    }
    // Pause the finger before lifting so assertions don't race inertial scrolling.
    await new Promise((resolve) => setTimeout(resolve, 120));
  } finally {
    await gestures.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await frames(page);
}
async function touchReveal(page, gestures, surface, target) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const box = await target.boundingBox();
    const bounds = await surface.boundingBox();
    if (
      box.y >= Math.max(0, bounds.y) + 4 &&
      box.y + box.height <= Math.min(page.viewportSize().height - 28, bounds.y + bounds.height) - 4
    ) {
      assert.equal((await geometry(target)).hit, true, "visible target receives the finger");
      return box;
    }
    await swipe(page, gestures, surface, box.y < bounds.y ? -1 : 1);
  }
  assert.fail("target must be reachable with finger scrolling alone");
}
async function tapVisible(page, target) {
  const box = await geometry(target);
  assert.equal(box.hit, true, "tap does not rely on locator auto-scrolling");
  assert.ok(box.box.y >= 0 && box.box.bottom <= page.viewportSize().height);
  await page.touchscreen.tap(box.box.x + box.box.width / 2, box.box.y + box.box.height / 2);
  await frames(page);
}
async function scrollState(page) {
  return page.evaluate(() => ({
    list: document.querySelector(".hub-links").scrollTop,
    shell: document.querySelector(".shell").scrollTop,
    body: document.scrollingElement.scrollTop,
    topbar: document.querySelector(".workbench-topbar").getBoundingClientRect().toJSON(),
    editor: document.querySelector(".links-editor")?.scrollTop,
  }));
}
try {
  if (!onlyCase || onlyCase === "new-account") {
    const { page, context, host } = await mount({
      width: 390,
      height: 844,
      touch: true,
      legacyConnection: true,
    });
    const gestures = await context.newCDPSession(page);
    const add = page
      .locator(".links-provider")
      .getByRole("button", { name: "添加连接", exact: true });
    await touchReveal(page, gestures, page.locator(".hub-links"), add);
    await tapVisible(page, add);
    await editor(page).waitFor();
    await editor(page).getByRole("textbox", { name: "Owned token", exact: true }).waitFor();
    assert.equal(
      await editor(page).locator(".links-conflict").count(),
      0,
      "new authorization cannot inherit a legacy account's revision",
    );
    assert.equal(
      await editor(page).getByRole("textbox", { name: "Owned token", exact: true }).isEnabled(),
      true,
    );
    const begin = host.authCalls.find((call) => call.method === "POST");
    assert.equal(begin.body.expectedRevision, null);
    assert.equal(begin.body.connectionId, undefined);
    const close = editor(page).getByRole("button", { name: "关闭", exact: true });
    await touchReveal(page, gestures, editor(page), close);
    await tapVisible(page, close);
    const deadline = Date.now() + 5000;
    while (!host.authPending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    await host.authPending.shift().fulfill({ contentType: "application/json", body: "{}" });
    await editor(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "返回对话", exact: true }).tap();
    await page.locator(".chat:not([hidden])").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("view"), null);
    assert.equal(await page.locator(".navigation-prompt").count(), 0);
    assert.deepEqual(host.calls, []);
    assert.deepEqual(host.responsePending, []);
    assert.equal(host.authCalls.filter((call) => call.method === "POST").length, 1);
    assert.equal(host.authCalls.filter((call) => call.method === "DELETE").length, 1);
    await record(page, "new-account-beside-legacy-cancel-and-return", {
      authCalls: host.authCalls,
    });
    await context.close();
  }
  if (!onlyCase || onlyCase === "touch-scroll")
    for (const [width, height] of [
      [390, 844],
      [320, 568],
      [844, 390],
    ]) {
      const { page, context, host } = await mount({ width, height, touch: true });
      const gestures = await context.newCDPSession(page);
      const list = page.locator(".hub-links");
      await list.evaluate((node) => {
        window.linkTouchEvents = [];
        for (const type of ["touchstart", "touchmove", "touchend"])
          node.addEventListener(
            type,
            (event) => {
              window.linkTouchEvents.push({ type: event.type, trusted: event.isTrusted });
            },
            { passive: true },
          );
      });
      const before = await scrollState(page);
      await swipe(page, gestures, list);
      const after = await scrollState(page);
      await record(page, `touch-list-${width}x${height}`, { before, after });
      assert.ok(after.list > before.list + 20, "finger scrolls the Link list itself");
      assert.equal(after.shell, 0, "fixed shell must not be programmatically scrolled");
      assert.equal(after.body, 0);
      assert.deepEqual(after.topbar, before.topbar, "topbar stays visible and fixed");
      await touchReveal(page, gestures, list, manage(page));
      const listPosition = (await scrollState(page)).list;
      await tapVisible(page, manage(page));
      await editor(page).waitFor();
      await swipe(page, gestures, page.locator(".links-editor-backdrop"), -1, 8);
      assert.equal(
        (await scrollState(page)).list,
        listPosition,
        "backdrop gestures leave the list in place",
      );
      const methods = editor(page).locator(".links-other-methods > summary");
      await touchReveal(page, gestures, editor(page), methods);
      await tapVisible(page, methods);
      const modalBefore = await scrollState(page);
      await swipe(page, gestures, editor(page));
      const modalAfter = await scrollState(page);
      assert.ok(modalAfter.editor > modalBefore.editor + 20, "expanded connection details scroll");
      assert.equal(modalAfter.list, listPosition, "modal scrolling leaves the list in place");
      await touchReveal(page, gestures, editor(page), save(page));
      // Keep swiping at the end: a modal must not scroll its background.
      await swipe(page, gestures, editor(page));
      await swipe(page, gestures, editor(page));
      assert.equal((await scrollState(page)).list, listPosition);
      await touchReveal(page, gestures, editor(page), label(page));
      await tapVisible(page, label(page));
      await page.keyboard.press("End");
      await page.keyboard.press("Backspace");
      const draft = await label(page).inputValue();
      await page.setViewportSize({ width, height: Math.min(height, 300) });
      await frames(page);
      const focused = await geometry(label(page));
      assert.equal(focused.focused, true);
      assert.ok(
        focused.box.top >= focused.dialog.top && focused.box.bottom <= focused.dialog.bottom,
      );
      assert.equal(
        await label(page).inputValue(),
        draft,
        "keyboard-sized viewport preserves the draft",
      );
      await record(page, `touch-details-keyboard-${width}x${height}`, { focused });
      await page.setViewportSize({ width, height });
      await frames(page);
      if (width === 320) {
        const close = editor(page).getByRole("button", { name: "关闭", exact: true });
        await touchReveal(page, gestures, editor(page), close);
        await tapVisible(page, close);
      } else await page.keyboard.press("Escape");
      await editor(page).waitFor({ state: "detached" });
      assert.ok(
        Math.abs((await scrollState(page)).list - listPosition) <= 1,
        "closing details preserves list position",
      );
      assert.equal((await scrollState(page)).shell, 0);
      assert.equal((await scrollState(page)).body, 0);
      assert.deepEqual(host.calls, [], "scrolling and editing never save or run a tool");
      assert.deepEqual(host.authCalls, [], "opening details never starts authorization");
      const touchEvents = await page.evaluate(() => window.linkTouchEvents);
      for (const type of ["touchstart", "touchmove", "touchend"])
        assert.ok(touchEvents.some((event) => event.type === type && event.trusted));
      assert.ok(touchEvents.every((event) => event.trusted));
      await record(page, `touch-details-return-${width}x${height}`, {
        listPosition,
        trustedTouches: Object.fromEntries(
          ["touchstart", "touchmove", "touchend"].map((type) => [
            type,
            touchEvents.filter((event) => event.type === type).length,
          ]),
        ),
      });
      // The earlier backdrop gesture deliberately handed focus away; retain the
      // existing no-focus-steal contract, then test keys on an already visible button.
      assert.equal((await active(page)).tag, "BODY");
      await manage(page).focus();
      assert.equal((await scrollState(page)).list, listPosition);
      await page.keyboard.press("PageUp");
      await page.waitForFunction(
        (previous) => document.querySelector(".hub-links").scrollTop < previous - 20,
        listPosition,
      );
      assert.equal((await scrollState(page)).shell, 0);
      assert.equal((await scrollState(page)).body, 0);
      await context.close();
    }
  if (!onlyCase || onlyCase === "layout")
    for (const [width, height] of [
      [1280, 700],
      [800, 480],
      [390, 360],
      [320, 240],
    ])
      for (const theme of ["light", "dark"]) {
        const { page, context, host } = await mount({ width, height, theme });
        await open(page);
        assert.equal(await label(page).inputValue(), host.snapshot.connections.at(-1).label);
        assert.equal(
          await label(page)
            .inputValue()
            .then((value) => value.length),
          100,
        );
        await label(page).fill("Owned renamed");
        await save(page).click();
        await waitHeld(page, host);
        await finish(host, 500);
        await page.getByRole("alert").waitFor();
        await page.waitForFunction(() => !document.querySelector(".links-editor input")?.disabled);
        const error = await geometry(page.getByRole("alert")),
          dialog = await geometry(editor(page));
        assert.equal(await label(page).inputValue(), "Owned renamed");
        assert.ok(error.dialog);
        assert.equal(error.hit, true);
        assert.equal(error.focused, true);
        assert.equal(error.text, longError);
        await page.keyboard.press("Shift+Tab");
        const close = await geometry(
          editor(page).getByRole("button", { name: "关闭", exact: true }),
        );
        assert.equal(close.focused, true);
        assert.equal(close.hit, true);
        await page.keyboard.press("Tab");
        assert.equal((await geometry(editor(page).locator(".links-editor-error"))).focused, true);
        assert.deepEqual(host.calls[0], {
          method: "PATCH",
          path: "/api/v1/links/connections/owned-11",
          query: "",
          body: {
            label: "Owned renamed",
            expectedRevision: "0000000000000000000000000000000000000000000000000000000000000011",
          },
        });
        await page.getByRole("alert").hover();
        await page.mouse.wheel(0, 2000);
        await frames(page);
        assert.ok(await page.getByRole("alert").evaluate((node) => node.scrollTop > 0));
        const visibleFinal = await page.getByRole("alert").evaluate((node) => {
          const text = node.firstChild,
            r = document.createRange();
          r.setStart(text, text.textContent.length - 6);
          r.setEnd(text, text.textContent.length);
          const b = r.getBoundingClientRect(),
            p = node.getBoundingClientRect();
          return b.top >= p.top && b.bottom <= p.bottom && b.left >= p.left && b.right <= p.right;
        });
        assert.equal(visibleFinal, true);
        await page.keyboard.press("Home");
        await page.keyboard.press("PageDown");
        await frames(page);
        assert.ok(await page.getByRole("alert").evaluate((node) => node.scrollTop > 0));
        await record(page, "save-reject-" + width + "-" + theme, {
          error,
          dialog,
          calls: host.calls,
          reads: host.reads,
        });
        await context.close();
      }
  if (!onlyCase || onlyCase === "ownership")
    for (const owner of ["field", "blank", "blur-event"]) {
      const { page, context, host } = await mount({ width: 1280, height: 700 });
      await open(page);
      await label(page).fill("Owned renamed");
      await save(page).click();
      await waitHeld(page, host);
      if (owner === "field")
        await page.getByRole("textbox", { name: "Outside field", exact: true }).click();
      if (owner === "blank") await page.locator("#outside-blank").click();
      if (owner === "blur-event")
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      const before = await active(page);
      await finish(host, 200);
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      const after = await active(page);
      if (owner === "field") {
        assert.equal(before.label, "Outside field");
        assert.equal(after.label, "Outside field");
      } else assert.equal(after.tag, "BODY");
      await record(page, "async-close-" + owner, { before, after, calls: host.calls });
      await context.close();
    }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context } = await mount({ width: 1280, height: 700 });
    await open(page);
    await save(page).focus();
    await frames(page);
    const before = await geometry(save(page));
    assert.equal(before.hit, true);
    await page.setViewportSize({ width: 800, height: 240 });
    await frames(page);
    const short = await geometry(save(page));
    assert.equal(short.focused, true);
    assert.equal(short.hit, true);
    await record(page, "resize-focused-save-short-same-breakpoint", { before, after: short });
    // Workbench's cross-width sidebar focus issue is independently tested.
    await context.close();
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context, host } = await mount({ width: 320, height: 240, readFail: true });
    const before = await geometry(page.getByRole("alert"));
    host.readFail = false;
    await page.getByRole("button", { name: "刷新", exact: true }).focus();
    await page.keyboard.press("Enter");
    await manage(page).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await record(page, "initial-read-retry", { before, reads: host.reads });
    await context.close();
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context, host } = await mount({ width: 1280, height: 700 });
    await page.getByRole("button", { name: "Link", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(new URL(page.url()).searchParams.get("view"), "links");
    await open(page);
    const first = await active(page);
    assert.equal(first.label, "关闭");
    await page.keyboard.press("Shift+Tab");
    const last = await active(page);
    assert.ok(last.label.startsWith("服务支持的操作"));
    await page.keyboard.press("Tab");
    assert.equal((await active(page)).label, "关闭");
    await page.keyboard.press("Escape");
    await editor(page).waitFor({ state: "hidden" });
    assert.equal((await active(page)).label, "管理连接");
    await record(page, "actual-navigation-and-clean-keyboard-close", {
      first,
      last,
      calls: host.calls,
    });
    await context.close();
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context, host } = await mount({ width: 1280, height: 700 });
    await open(page);
    await label(page).fill("Owned renamed");
    await save(page).click();
    await waitHeld(page, host);
    await editor(page).getByRole("button", { name: "关闭", exact: true }).click();
    await editor(page).waitFor({ state: "hidden" });
    const svg = page.locator(".brand-mark svg");
    await svg.scrollIntoViewIfNeeded();
    await svg.click();
    const target = await svg.evaluate((node) => ({
      tag: node.tagName,
      html: node instanceof HTMLElement,
    }));
    const before = await active(page);
    await finish(host, 200);
    await frames(page);
    assert.equal((await active(page)).tag, "BODY");
    await record(page, "cancel-held-save-actual-brand-svg-no-late-steal", {
      target,
      before,
      after: await active(page),
      calls: host.calls,
    });
    await context.close();
  }
  if (!onlyCase || onlyCase === "authorization") {
    const { page, context, host } = await mount({ width: 320, height: 240 });
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await editor(page).waitFor();
    await editor(page).getByRole("button", { name: "取消授权", exact: true }).waitFor();
    assert.deepEqual(host.authCalls, [
      {
        method: "POST",
        path: "/api/v1/links/authorizations",
        body: {
          providerId: provider.id,
          methodId: "owned-local-token",
          label: "Owned service",
          expectedRevision: null,
          authModeId: "owned-credential",
        },
      },
    ]);
    await editor(page).getByRole("button", { name: "取消授权", exact: true }).click();
    const deadline = Date.now() + 5000;
    while (!host.authPending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    await host.authPending.shift().fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: longError }),
    });
    await page.getByRole("alert").waitFor();
    await frames(page);
    assert.equal(
      await editor(page).getByRole("button", { name: "取消授权", exact: true }).count(),
      1,
    );
    assert.equal(await editor(page).getByText("授权已取消。", { exact: true }).count(), 0);
    await record(page, "owned-cancel-reject-remains-pending", {
      error: await geometry(page.getByRole("alert")),
      authCalls: host.authCalls,
    });
    await editor(page).getByRole("button", { name: "取消授权", exact: true }).click();
    const retryDeadline = Date.now() + 5000;
    while (!host.authPending.length) {
      assert.ok(Date.now() < retryDeadline);
      await frames(page);
    }
    await host.authPending.shift().fulfill({ contentType: "application/json", body: "{}" });
    await editor(page).getByText("授权已取消。", { exact: true }).waitFor();
    assert.equal(
      await editor(page).getByRole("button", { name: "取消授权", exact: true }).count(),
      0,
    );
    assert.equal(host.authCalls.filter((call) => call.method === "DELETE").length, 2);
    await editor(page).getByRole("button", { name: "关闭", exact: true }).click();
    await editor(page).waitFor({ state: "hidden" });
    // Resolve any unmount cleanup locally; no provider/browser launch exists.
    await page.evaluate(() => window.unmountFixture());
    await frames(page);
    for (const route of host.authPending.splice(0))
      await route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => {});
    await context.close();
  }
  if (!onlyCase || onlyCase === "identity") {
    const { page, context, host } = await mount();
    await open(page);
    await label(page).fill("Owned renamed");
    await save(page).click();
    await waitHeld(page, host);
    host.snapshot.connections = host.snapshot.connections.map((item) =>
      item.id === "owned-11" ? { ...item, revision: "c".repeat(64) } : item,
    );
    await finish(host, 409);
    await editor(page)
      .getByRole("button", { name: "载入最新版本，保留输入", exact: true })
      .waitFor();
    await frames(page);
    assert.equal(await label(page).inputValue(), "Owned renamed");
    assert.equal(await save(page).isDisabled(), true);
    await editor(page).getByRole("button", { name: "载入最新版本，保留输入", exact: true }).click();
    await save(page).click();
    const deadline = Date.now() + 5000;
    while (!host.pending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    assert.equal(host.calls.length, 2);
    assert.deepEqual(host.calls[1].body, {
      label: "Owned renamed",
      expectedRevision: "c".repeat(64),
    });
    await finish(host, 200);
    await editor(page).waitFor({ state: "hidden" });
    await frames(page);
    const account = page.locator(".links-connection").filter({ hasText: "Owned account 11" });
    assert.equal(await account.count(), 1);
    assert.equal(
      await account
        .getByRole("button", { name: "管理连接", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await record(page, "409-revision-review-keeps-input-and-account", { calls: host.calls });
    await context.close();
  }
  if (!onlyCase || onlyCase === "identity") {
    const { page, context, host } = await mount();
    await open(page);
    host.snapshot.connections = host.snapshot.connections.filter((item) => item.id !== "owned-11");
    await page.evaluate(() => window.refreshConfigurationFixture());
    await page.waitForFunction(() => document.querySelectorAll(".links-connection").length === 11);
    await editor(page).getByRole("button", { name: "关闭", exact: true }).click();
    await editor(page).waitFor({ state: "hidden" });
    await frames(page);
    assert.equal(
      await page
        .getByRole("searchbox", { name: "搜索 Link 服务", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await record(page, "removed-account-opener-falls-back-to-search", { calls: host.calls });
    await context.close();
  }
  if (!onlyCase || onlyCase === "identity") {
    const { page, context, host } = await mount();
    await open(page);
    await label(page).fill("Owned renamed");
    await save(page).click();
    await waitHeld(page, host);
    await finish(host, 401);
    await frames(page);
    assert.equal(await page.evaluate(() => window.authLost), 1);
    assert.equal(await editor(page).locator(".links-editor-error").count(), 0);
    assert.equal(await label(page).inputValue(), "Owned renamed");
    await record(page, "401-keeps-original-auth-loss-contract", { calls: host.calls });
    await context.close();
  }
  if (!onlyCase || onlyCase === "authorization") {
    const { page, context, host } = await mount();
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await editor(page).getByLabel("Owned token", { exact: true }).waitFor();
    await editor(page).getByLabel("Owned token", { exact: true }).fill("owned-fixture-token");
    await editor(page).getByRole("button", { name: "验证并保存", exact: true }).click();
    let deadline = Date.now() + 5000;
    while (!host.responsePending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    assert.deepEqual(host.authCalls.at(-1), {
      method: "POST",
      path: "/api/v1/links/authorizations/owned-authorization/responses",
      body: { stepId: "owned-step", operation: "submit", input: { token: "owned-fixture-token" } },
    });
    await host.responsePending.shift().fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: longError }),
    });
    await editor(page).locator(".links-editor-error").waitFor();
    assert.equal(await editor(page).getByLabel("Owned token", { exact: true }).inputValue(), "");
    assert.equal(await editor(page).locator(".links-editor-error").textContent(), longError);
    deadline = Date.now() + 6500;
    while (!host.authReads) {
      assert.ok(
        Date.now() < deadline,
        "Uncertain authorization response must reconcile by GET, never replay credentials",
      );
      await frames(page);
    }
    assert.equal(host.authCalls.filter((call) => call.path.endsWith("/responses")).length, 1);
    await record(page, "credential-response-failure-clears-secret-and-only-reconciles-get", {
      authCalls: host.authCalls,
      authReads: host.authReads,
    });
    await page.evaluate(() => window.unmountFixture());
    await frames(page);
    for (const route of host.authPending.splice(0))
      await route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => {});
    await context.close();
  }
  if (!onlyCase || onlyCase === "authorization")
    for (const owner of ["owned", "field", "blank", "blur-event"]) {
      const { page, context, host } = await mount();
      host.holdBegin = true;
      await page.getByRole("button", { name: "添加连接", exact: true }).click();
      await editor(page).waitFor();
      const deadline = Date.now() + 5000;
      while (!host.beginPending.length) {
        assert.ok(Date.now() < deadline);
        await frames(page);
      }
      if (owner === "field")
        await page.getByRole("textbox", { name: "Outside field", exact: true }).click();
      if (owner === "blank") await page.locator("#outside-blank").click();
      if (owner === "blur-event")
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      const before = await active(page);
      await host.beginPending.shift().fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: longError }),
      });
      await editor(page).locator(".links-editor-error").waitFor();
      await frames(page);
      if (owner === "owned")
        assert.equal((await geometry(editor(page).locator(".links-editor-error"))).focused, true);
      else assert.deepEqual(await active(page), before);
      assert.equal(host.authCalls.length, 1);
      await record(page, "held-begin-rejection-" + owner, {
        before,
        after: await active(page),
        authCalls: host.authCalls,
      });
      await context.close();
    }
  if (!onlyCase || onlyCase === "authorization") {
    const { page, context, host } = await mount({ width: 1280, height: 700 });
    host.holdBegin = true;
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await editor(page).waitFor();
    const deadline = Date.now() + 5000;
    while (!host.beginPending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    await editor(page).getByRole("button", { name: "关闭", exact: true }).click();
    await editor(page).waitFor({ state: "hidden" });
    const svg = page.locator(".brand-mark svg");
    await svg.scrollIntoViewIfNeeded();
    await svg.click();
    assert.equal((await active(page)).tag, "BODY");
    await host.beginPending
      .shift()
      .fulfill({ contentType: "application/json", body: JSON.stringify(host.auth) });
    while (!host.authPending.length) {
      assert.ok(Date.now() < deadline);
      await frames(page);
    }
    await host.authPending.shift().fulfill({ contentType: "application/json", body: "{}" });
    await frames(page);
    assert.equal(await editor(page).count(), 0);
    assert.equal((await active(page)).tag, "BODY");
    assert.equal(host.authCalls.filter((call) => call.method === "POST").length, 1);
    assert.equal(host.authCalls.filter((call) => call.method === "DELETE").length, 1);
    await record(page, "closed-held-begin-cleans-owned-attempt-without-reopen-or-svg-focus-steal", {
      authCalls: host.authCalls,
    });
    await context.close();
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context, host } = await mount();
    await open(page);
    await label(page).fill("Owned named draft");
    const prevented = await label(page).evaluate((node) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, false);
    assert.equal(await editor(page).count(), 1);
    assert.equal(await label(page).inputValue(), "Owned named draft");
    assert.deepEqual(host.calls, []);
    await record(page, "composing-dom-escape-does-not-close-or-discard-name");
    await context.close();
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    const { page, context, host } = await mount();
    await open(page);
    await label(page).fill("Owned renamed");
    await save(page).click();
    await waitHeld(page, host);
    await page.evaluate(() => window.unmountFixture());
    await frames(page);
    await page.getByRole("textbox", { name: "Outside field", exact: true }).focus();
    await finish(host, 500);
    await page.setViewportSize({ width: 320, height: 240 });
    await frames(page);
    assert.equal((await active(page)).label, "Outside field");
    assert.equal(await editor(page).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    await record(page, "unmount-aborts-request-without-late-feedback-or-focus", {
      calls: host.calls,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} finally {
  await browser.close();
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ repo, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ out, observations: reports.length, errors, blocked }));
}
