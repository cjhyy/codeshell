/** Actual Workbench account/device entry, owned loopback auth API, no user credentials. */
/* global document, window, innerWidth, innerHeight, getComputedStyle, requestAnimationFrame, Event */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const web = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(web, "../..");
const development = process.argv.includes("--development");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice(15);
const onlyCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-devices-audit-"));
const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {Workbench} from './Workbench';
const noop=()=>{};window.authLost=0;
const controller={host:'hub',workspaceApi:true,connection:'open',activeId:'owned',chat:{items:[],run:'idle'},sessions:[],
 workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'Owned conversation',configuration:null,
 configurationVersion:0,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,
 running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,
 removeFile:noop,selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,
 refreshConfiguration:noop,onAuthLost:()=>window.authLost++,session:{id:'owned-0',username:'Owned reader',deviceName:'Current owned device'}};
const root=createRoot(document.getElementById('root'));window.unmountOwnedWorkbench=()=>root.unmount();
root.render(<React.StrictMode><Workbench controller={controller}/></React.StrictMode>);`;
const built = await build({
  stdin: { contents: source, resolveDir: path.join(web, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
  plugins: baseline
    ? [
        {
          name: "owned-before-source",
          setup(builder) {
            builder.onLoad({ filter: /\/(Devices\.tsx|Workbench\.tsx|app\.css)$/ }, (args) => ({
              contents: execFileSync(
                "git",
                ["show", baseline + ":packages/web/app/" + path.basename(args.path)],
                { cwd: repo, encoding: "utf8" },
              ),
              loader: args.path.endsWith(".css") ? "css" : "tsx",
              resolveDir: path.join(web, "app"),
            }));
          },
        },
      ]
    : [],
});
const js = built.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = built.outputFiles
  .filter((f) => f.path.endsWith(".css"))
  .map((f) => f.text)
  .join("\n");
const devices = Array.from({ length: 12 }, (_, i) => ({
  id: "owned-" + i,
  deviceName: "Owned device " + i,
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: 9999999999999,
  current: i === 0,
}));
let scenario = "",
  calls = [],
  readRecovered = false,
  holdPlan = null,
  held = null;
const unexpected = [];
const longError = "Owned operation failed: " + "DiagnosticHash_".repeat(100) + " Final line";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  calls.push({ method: req.method, path: req.url, body });
  res.setHeader("content-type", "application/json");
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    );
    return;
  }
  if (req.url === "/api/v1/environment" && req.method === "GET") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Owned discovery unavailable" }));
    return;
  }
  if (req.url === "/api/v1/auth/sessions" && req.method === "GET") {
    if (scenario === "read-failure" || (scenario === "read-retry" && !readRecovered)) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: longError }));
    } else res.end(JSON.stringify({ sessions: devices }));
    return;
  }
  if (holdPlan && req.url === holdPlan.path && req.method === holdPlan.method) {
    assert.equal(held, null, "Exactly one owned mutation may be held");
    held = res;
    return;
  }
  if (req.url === "/api/v1/auth/sessions/owned-11" && req.method === "DELETE") {
    if (scenario === "remove-failure") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: longError }));
    } else res.end("{}");
    return;
  }
  unexpected.push({ method: req.method, path: req.url });
  res.statusCode = 500;
  res.end(JSON.stringify({ error: "Unexpected owned route" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM,
});
const reports = [],
  errors = [],
  blocked = [];
async function info(locator) {
  return locator.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)),
      y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      tag: n.tagName,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      scrollTop: n.scrollTop,
      scrollHeight: n.scrollHeight,
      clientHeight: n.clientHeight,
      focused: n === document.activeElement,
      hit: !!hit && (hit === n || n.contains(hit)),
      text: n.textContent.trim().slice(0, 80),
    };
  });
}
async function visible(locator, label) {
  const result = await locator.evaluate((n) => {
    const r = n.getBoundingClientRect(),
      violations = [];
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1)
      violations.push("viewport");
    for (let p = n.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        b = p.getBoundingClientRect();
      if (
        /auto|scroll|hidden|clip/.test(s.overflowY) &&
        (r.top < b.top - 1 || r.bottom > b.bottom + 1)
      )
        violations.push(p.tagName + ":vertical");
      if (
        /auto|scroll|hidden|clip/.test(s.overflowX) &&
        (r.left < b.left - 1 || r.right > b.right + 1)
      )
        violations.push(p.tagName + ":horizontal");
    }
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: r.toJSON(), violations, hit: hit === n || n.contains(hit) };
  });
  assert.deepEqual(result.violations, [], label + JSON.stringify(result));
  assert.equal(result.hit, true, label + " center hit");
}
async function settled(page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
async function documentBounds(page) {
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  }));
  assert.ok(bounds.width <= bounds.viewportWidth + 1, JSON.stringify(bounds));
  assert.ok(bounds.height <= bounds.viewportHeight + 1, JSON.stringify(bounds));
}
async function fullErrorReadable(error) {
  // Complete the preceding native End animation before establishing the wheel
  // starting position, so its remaining movement cannot satisfy the wheel check.
  await error
    .page()
    .waitForFunction(
      (node) => node.scrollTop + node.clientHeight >= node.scrollHeight,
      await error.elementHandle(),
    );
  await error.evaluate((node) => {
    node.scrollTop = 0;
  });
  await error.hover();
  await error.page().mouse.wheel(0, 120);
  await error.page().waitForFunction((node) => node.scrollTop >= 32, await error.elementHandle());
  await error.page().evaluate(async () => {
    for (let frame = 0; frame < 8; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  assert.ok(
    await error.evaluate((node) => node.scrollTop >= 32),
    "Actual wheel scrolling remains settled beyond a small transient movement",
  );
  await error.press("End");
  await error
    .page()
    .waitForFunction(
      (node) => node.scrollTop + node.clientHeight >= node.scrollHeight,
      await error.elementHandle(),
    );
  const result = await error.evaluate((node) => {
    const text = node.firstChild;
    const bounds = node.getBoundingClientRect();
    const range = document.createRange();
    const clipped = [];
    let last;
    for (let index = 0; index < text.length; index++) {
      if (!text.textContent[index].trim()) continue;
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const glyph = range.getBoundingClientRect();
      if (glyph.left < bounds.left - 1 || glyph.right > bounds.right + 1) clipped.push(index);
      last = glyph.toJSON();
    }
    return { clipped, last, bounds: bounds.toJSON() };
  });
  assert.deepEqual(result.clipped, [], "Every full error glyph fits the bounded scroller width");
  assert.ok(
    result.last.top >= result.bounds.top - 1 && result.last.bottom <= result.bounds.bottom + 1,
    "The final error glyph is readable after native End scrolling: " + JSON.stringify(result),
  );
}
async function boot(kind, plan = null) {
  scenario = kind;
  calls = [];
  readRecovered = false;
  holdPlan = plan;
  held = null;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  await page.locator(".account-button").click();
  const dialog = page.getByRole("dialog", { name: "账号与设备" });
  await dialog.waitFor();
  await page.getByText("正在读取设备…").waitFor({ state: "hidden" });
  return { context, page, dialog };
}
async function waitForHeld() {
  const deadline = Date.now() + 7000;
  while (!held && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(held, "Owned mutation reached the HTTP server");
}
function releaseHeld(status) {
  assert.ok(held && holdPlan, "An exact owned mutation is held");
  held.statusCode = status;
  held.end(JSON.stringify(status < 400 ? {} : { error: longError }));
}
function mutationCalls() {
  return calls.filter((call) => call.method !== "GET");
}
async function completeCase(context, page, kind, details = {}) {
  await settled(page);
  await documentBounds(page);
  reports.push({
    kind,
    ...details,
    calls: [...calls],
    authLost: await page.evaluate(() => window.authLost),
  });
  await context.close();
  holdPlan = null;
  held = null;
}
try {
  for (const [width, height] of [
    [1280, 720],
    [390, 360],
    [320, 240],
  ])
    for (const kind of [
      "read-failure",
      "read-retry",
      "remove-failure",
      "remove-success",
      "close",
      "escape",
    ].filter((kind) => !onlyCase || kind === onlyCase)) {
      scenario = kind;
      calls = [];
      readRecovered = false;
      const context = await browser.newContext({
        viewport: { width, height },
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) =>
        route
          .request()
          .url()
          .startsWith(origin + "/")
          ? route.continue()
          : (blocked.push(route.request().url()), route.abort()),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin + "/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: js });
      if (width < 761) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await page.locator(".account-button").click();
      const dialog = page.getByRole("dialog", { name: "账号与设备" });
      await dialog.waitFor();
      await page.getByText("正在读取设备…").waitFor({ state: "hidden" });
      if (kind === "remove-failure" || kind === "remove-success")
        await dialog.locator(".device-list li").last().getByRole("button").click();
      if (kind === "remove-failure" || kind === "read-failure" || kind === "read-retry")
        await dialog.getByRole("alert").waitFor();
      if (kind === "read-retry") {
        readRecovered = true;
        await dialog.getByRole("button", { name: "重新读取", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelectorAll(".device-list li").length === 12,
        );
      }
      if (kind === "remove-success")
        await page.waitForFunction(
          () => document.querySelectorAll(".device-list li").length === 11,
        );
      if (kind === "close" || kind === "escape") {
        if (kind === "escape") await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      }
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const record = {
        kind,
        width,
        height,
        active: await page.evaluate(() => ({
          tag: document.activeElement.tagName,
          aria: document.activeElement.getAttribute("aria-label"),
          text: document.activeElement.textContent.trim().slice(0, 60),
        })),
        calls: calls.filter((c) => c.path !== "/"),
        authLost: await page.evaluate(() => window.authLost),
      };
      if (kind !== "close" && kind !== "escape") {
        record.dialog = await info(dialog);
        record.close = await info(dialog.getByRole("button", { name: "关闭", exact: true }));
        record.logout = await info(
          dialog.getByRole("button", { name: "退出当前设备", exact: true }),
        );
        record.retry = await dialog.getByRole("button", { name: /重试|重新读取|刷新/ }).count();
        if (await dialog.getByRole("alert").count()) {
          record.alert = await info(dialog.getByRole("alert"));
          record.fullError = (await dialog.getByRole("alert").textContent()) === longError;
        }
        record.devices = await dialog.locator(".device-list li").count();
      }
      if (kind === "close" || kind === "escape")
        assert.equal(
          await page
            .locator(width < 761 ? "[aria-controls=workbench-sidebar]" : ".account-button")
            .evaluate((n) => n === document.activeElement),
          true,
          "Actual close opener is focused",
        );
      else {
        await visible(dialog.getByRole("button", { name: "关闭", exact: true }), "close");
        await visible(dialog.getByRole("button", { name: "退出当前设备", exact: true }), "logout");
        assert.equal(
          await dialog.evaluate((n) => n.scrollTop),
          0,
          "Hidden dialog root never scrolls",
        );
        if (kind === "read-failure" || kind === "remove-failure") {
          await visible(dialog.getByRole("alert"), "full bounded error");
          assert.equal(
            await dialog.getByRole("alert").evaluate((n) => n === document.activeElement),
            true,
            "Owned failure has visible focus",
          );
          assert.equal(record.fullError, true);
          if (kind === "read-failure") assert.equal(record.retry, 1);
          const error = dialog.getByRole("alert");
          await error.press("End");
          await page.waitForFunction((n) => n.scrollTop > 0, await error.elementHandle());
          await fullErrorReadable(error);
          await visible(
            dialog.getByRole("button", { name: "关闭", exact: true }),
            "close after reading entire error",
          );
        }
        if (kind === "remove-success") await visible(page.locator(":focus"), "owned neighbor");
        if (kind === "read-retry")
          assert.equal(
            await dialog
              .getByRole("region", { name: "登录设备", exact: true })
              .evaluate((n) => n === document.activeElement),
            true,
            "Successful explicit retry returns to device list",
          );
      }
      assert.equal(record.authLost, 0);
      assert.equal(
        record.calls.filter((c) => c.method === "DELETE").length,
        kind.startsWith("remove-") ? 1 : 0,
      );
      assert.ok(record.calls.filter((c) => c.path === "/api/v1/auth/sessions").length >= 1);
      await documentBounds(page);
      await page.screenshot({ path: path.join(output, `${kind}-${width}.png`) });
      reports.push(record);
      await context.close();
    }
  // A native modal makes background fields inert. The owned field below is another
  // control inside the real dialog, outside the pending action's focus ownership.
  for (const handoff of ["field", "blank", "blur", "close-button"].filter(
    (kind) => !baseline && (!onlyCase || onlyCase === `held-${kind}`),
  )) {
    const kind = `held-${handoff}`;
    const plan = { method: "DELETE", path: "/api/v1/auth/sessions/owned-11" };
    const { context, page, dialog } = await boot(kind, plan);
    const action = dialog.locator(".device-list li").last().getByRole("button");
    await action.click();
    await waitForHeld();
    // aria-disabled keeps the focused source mounted; the synchronous guard must
    // also reject programmatic clicks while the original request is unresolved.
    await action.evaluate((node) => {
      node.click();
      node.click();
    });
    if (handoff === "field")
      await dialog.evaluate((node) => {
        const input = document.createElement("input");
        input.setAttribute("aria-label", "Owned other dialog field");
        node.querySelector(".devices-body").append(input);
        input.focus();
      });
    else if (handoff === "blank") await dialog.locator("h2").click();
    else if (handoff === "close-button")
      await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => {
      window.ownedHandoffTarget = document.activeElement;
    });
    const response = page.waitForResponse(
      (res) => res.url() === origin + plan.path && res.request().method() === plan.method,
    );
    releaseHeld(500);
    await (await response).finished();
    const error = dialog.getByRole("alert");
    await error.waitFor();
    await settled(page);
    assert.equal(await error.textContent(), longError);
    assert.equal(
      await page.evaluate(() => document.activeElement === window.ownedHandoffTarget),
      true,
      `${handoff} handoff is never reclaimed by a late rejection`,
    );
    assert.equal(await error.evaluate((node) => node === document.activeElement), false);
    assert.equal(await dialog.locator(".device-list li").count(), 12);
    assert.deepEqual(mutationCalls(), [{ ...plan, body: "" }]);
    assert.equal(await page.evaluate(() => window.authLost), 0);
    await completeCase(context, page, kind, { errorRetained: true });
  }
  const lateCases = [
    { name: "close-late-revoke-error", path: "/api/v1/auth/sessions/owned-11", status: 500 },
    { name: "unmount-late-revoke-error", path: "/api/v1/auth/sessions/owned-11", status: 500 },
    { name: "close-late-revoke-401", path: "/api/v1/auth/sessions/owned-11", status: 401 },
    { name: "close-late-current-device", path: "/api/v1/auth/sessions/owned-0", status: 200 },
    { name: "unmount-late-logout", path: "/api/v1/auth/logout", status: 200 },
    { name: "close-late-logout-401", path: "/api/v1/auth/logout", status: 401 },
  ];
  for (const test of lateCases.filter(
    (test) => !baseline && (!onlyCase || onlyCase === test.name),
  )) {
    const logout = test.path.endsWith("/logout");
    const plan = { method: logout ? "POST" : "DELETE", path: test.path };
    const { context, page, dialog } = await boot(test.name, plan);
    if (logout) await dialog.getByRole("button", { name: "退出当前设备", exact: true }).click();
    else
      await dialog
        .locator(".device-list li")
        .nth(test.path.endsWith("owned-0") ? 0 : 11)
        .getByRole("button")
        .click();
    await waitForHeld();
    if (test.name.startsWith("unmount")) await page.evaluate(() => window.unmountOwnedWorkbench());
    else {
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      // A real Workbench SVG is reachable again only after the modal closes.
      await page.locator(".brand-mark svg").click();
    }
    await page.evaluate(() => {
      window.ownedHandoffTarget = document.activeElement;
    });
    const response = page.waitForResponse(
      (res) => res.url() === origin + plan.path && res.request().method() === plan.method,
    );
    releaseHeld(test.status);
    await (await response).finished();
    const expectedAuthLost = test.status === 401 || test.status === 200 ? 1 : 0;
    if (expectedAuthLost) await page.waitForFunction(() => window.authLost === 1);
    await settled(page);
    assert.equal(
      await page.evaluate(() => window.authLost),
      expectedAuthLost,
      "Original current-device/logout/401 action remains globally effective after close",
    );
    assert.equal(await page.getByRole("dialog", { name: "账号与设备" }).count(), 0);
    assert.equal(
      await page.getByRole("alert").count(),
      0,
      "Closed UI receives no late local error",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement === window.ownedHandoffTarget),
      true,
    );
    assert.deepEqual(mutationCalls(), [{ ...plan, body: logout ? "{}" : "" }]);
    await completeCase(context, page, test.name, { expectedAuthLost });
  }
  for (const target of ["row", "error"].filter(
    (kind) => !baseline && (!onlyCase || onlyCase === `resize-${kind}`),
  )) {
    const { context, page, dialog } = await boot(
      target === "error" ? "remove-failure" : "resize-row",
    );
    const action = dialog.locator(".device-list li").last().getByRole("button");
    if (target === "error") {
      await action.click();
      await dialog.getByRole("alert").waitFor();
    } else await action.focus();
    const focused = target === "error" ? dialog.getByRole("alert") : action;
    assert.equal(await focused.evaluate((node) => node === document.activeElement), true);
    for (const [width, height] of [
      [800, 480],
      [800, 240],
      [390, 360],
      [320, 240],
      [1280, 720],
    ]) {
      await page.setViewportSize({ width, height });
      await settled(page);
      assert.equal(
        await focused.evaluate((node) => node === document.activeElement),
        true,
        "Live resize preserves the existing focused element without a new focus call",
      );
      await visible(focused, `focused ${target} after ${width}x${height}`);
      await visible(dialog.getByRole("button", { name: "关闭", exact: true }), "resize close");
      await visible(
        dialog.getByRole("button", { name: "退出当前设备", exact: true }),
        "resize logout",
      );
      assert.equal(await dialog.evaluate((node) => node.scrollTop), 0);
      await documentBounds(page);
    }
    if (target === "error") assert.equal(await focused.textContent(), longError);
    let keyboardBoundary;
    if (target === "row") {
      const logout = dialog.getByRole("button", { name: "退出当前设备", exact: true });
      const close = dialog.getByRole("button", { name: "关闭", exact: true });
      await logout.focus();
      await page.keyboard.press("Tab");
      keyboardBoundary = await page.evaluate(() => ({
        documentFocused: document.hasFocus(),
        body: document.activeElement === document.body,
        insideDialog: !!document.activeElement.closest(".devices-dialog"),
      }));
      if (!keyboardBoundary.insideDialog) {
        // Chrome permits its own browser chrome in the native dialog Tab cycle.
        // BODY here represents a blurred document, never a focused background UI.
        assert.deepEqual(keyboardBoundary, {
          documentFocused: false,
          body: true,
          insideDialog: false,
        });
        await page.keyboard.press("Tab");
      }
      assert.equal(
        await close.evaluate((node) => node === document.activeElement),
        true,
        "Forward Tab returns to the first native modal control without entering background UI",
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await logout.evaluate((node) => node === document.activeElement),
        true,
        "The real native modal traps reverse Tab at its first control",
      );
    }
    await completeCase(context, page, `resize-${target}`, { keyboardBoundary });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(unexpected, []);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ development, baseline, reports, errors, blocked, unexpected }, null, 2),
  );
  console.log(
    JSON.stringify({ output, observations: reports.length, errors, blocked, unexpected }),
  );
}
