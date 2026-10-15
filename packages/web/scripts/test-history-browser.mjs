/** Actual Workbench history; owned HTTP/controller only. Supports --source-repo and --development. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, Event, MutationObserver */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ownRepo = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-repo");
const repo = sourceIndex < 0 ? ownRepo : path.resolve(process.argv[sourceIndex + 1]);
const development = process.argv.includes("--development");
const require = createRequire(path.join(ownRepo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-history-"));
const prefix = "合法完整会话标题 ";
const longTitle = prefix + "TitleHash".repeat(114).slice(0, 1024 - prefix.length - 3) + "End";
assert.ok(longTitle.length <= 1024);
const sessions = () =>
  Array.from({ length: 12 }, (_, i) => ({
    cwd: "/owned-history",
    sessionId: "owned-session-" + i,
    title: "Owned session " + i,
    customTitle: "Owned session " + i,
    startedAt: 1792030000000,
    lastActiveAt: 1792031000000,
    model: "owned-model",
    status: "idle",
    turnCount: i,
    archivedAt: null,
    running: false,
    preview: "Owned preview " + i,
  }));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const root=createRoot(document.getElementById('root')),noop=()=>{};window.selectionCalls=[];window.authLost=0;window.changeCalls=0;window.newCalls=0;window.unmountFixture=()=>root.render(null);
function Fixture(){const[workspace,setWorkspace]=React.useState('owned-history'),[version,setVersion]=React.useState(0);window.changeWorkspace=()=>setWorkspace('other-owned-history');window.bumpSessions=()=>setVersion(n=>n+1);const[activeId,setActive]=React.useState('owned-session-0'),[loading,setLoading]=React.useState(false),[items,setItems]=React.useState([{kind:'assistant',id:'owned-message',text:'Owned old transcript',done:true}]);const controller={host:'desktop',workspaceApi:true,connection:'open',activeId,loading,chat:{items,run:'idle'},sessions:window.fixtureSessions,workspaceCwd:'/owned-history',workspaceName:'Owned workspace',workspaceKey:workspace,title:'Owned conversation',configuration:null,configurationVersion:0,sessionsVersion:version,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:(id)=>{window.selectionCalls.push(id);window.acceptSelection=()=>setActive(id);if(!window.holdSelection)setActive(id);setLoading(true);setItems([]);return new Promise(resolve=>window.finishSelection=()=>{setItems([{kind:'assistant',id:'new-owned-output',text:'Owned restored transcript for '+id,done:true}]);setLoading(false);resolve()})},newSession:()=>{window.newCalls++;setActive('owned-new-session');setItems([])},send:()=>false,stop:noop,addFiles:noop,refreshSessions:()=>{window.changeCalls++;if(!window.hubRefreshOnly)setVersion(n=>n+1)},refreshConfiguration:noop,onAuthLost:()=>window.authLost++};return <Workbench controller={controller}/>};root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const origin = "http://history-owned.test",
  url = origin + "/?view=history";
const errors = [],
  blocked = [],
  reports = [];
const longError =
  "Owned operation rejected: " + "DiagnosticHash".repeat(80) + " Complete final line";
const frames = (p) =>
  p.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
let context;
async function mount(
  width,
  height,
  {
    empty = false,
    readFailure = false,
    long = false,
    more = false,
    archived = false,
    theme = "light",
  } = {},
) {
  await context?.close();
  context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    serviceWorkers: "block",
  });
  const host = {
    sessions: empty ? [] : sessions(),
    calls: [],
    reads: [],
    pending: [],
    hold: false,
    status: 500,
    readStatus: readFailure ? 500 : 200,
    holdRead: false,
    pendingReads: [],
    holdDetail: false,
    pendingDetails: [],
    detailStatus: 200,
    details: [],
    more,
  };
  if (archived) host.sessions[11].archivedAt = 1792031000000;
  if (long) host.sessions[11].title = host.sessions[11].customTitle = longTitle;
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      method = req.method();
    if (req.url() === url)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Independent field" style="position:fixed;bottom:0;right:0;width:100px;z-index:999;visibility:hidden"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999;visibility:hidden"></div>',
      });
    if (u.origin !== origin) {
      blocked.push(req.url());
      return route.abort();
    }
    if (u.pathname === "/api/v1/environment" && method === "GET")
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (u.pathname === "/api/v1/sessions" && method === "GET") {
      host.reads.push(u.search);
      if (host.holdRead) {
        host.pendingReads.push({ route, url: u.href });
        return;
      }
      return finishRead(host, { route, url: u.href }, host.readStatus);
    }
    if (/^\/api\/v1\/sessions\/owned-session-\d+$/.test(u.pathname) && method === "GET") {
      host.details.push(u.pathname);
      const detail = { route, id: u.pathname.split("/").pop() };
      if (host.holdDetail) {
        host.pendingDetails.push(detail);
        return;
      }
      return finishDetail(host, detail, host.detailStatus);
    }
    if (/^\/api\/v1\/sessions\/owned-session-\d+$/.test(u.pathname) && method === "PATCH") {
      const call = { path: u.pathname, method, body: req.postDataJSON() };
      host.calls.push(call);
      if (host.hold) {
        host.pending.push({ route, call });
        return;
      }
      return route.fulfill({
        status: host.status,
        contentType: "application/json",
        body: JSON.stringify({ error: longError }),
      });
    }
    blocked.push(req.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.evaluate((data) => (window.fixtureSessions = data), host.sessions);
  for (const file of bundle.outputFiles.filter((f) => f.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text });
  await page.getByRole("heading", { name: "历史对话", exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".session-history-list")?.getAttribute("aria-busy") === "false",
  );
  await frames(page);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    theme,
  );
  return { page, host };
}
const row = (p) => p.locator(".session-history-row").last(),
  edit = (p) => p.locator(".session-history-editor");
async function openRename(page) {
  await row(page).getByRole("button", { name: "重命名", exact: true }).focus();
  await page.keyboard.press("Enter");
  await edit(page).waitFor();
  await frames(page);
  assert.equal(
    await edit(page)
      .getByRole("textbox", { name: "对话标题", exact: true })
      .evaluate((n) => n === document.activeElement),
    true,
  );
}
async function until(page, predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline);
    await frames(page);
  }
}
async function finish(host, status) {
  const request = host.pending.shift();
  assert.ok(request);
  if (status === 200) {
    const s = host.sessions.find((s) => request.call.path.endsWith(s.sessionId));
    if ("title" in request.call.body) {
      s.customTitle = request.call.body.title;
      s.title = request.call.body.title || "Owned generated title";
    } else s.archivedAt = request.call.body.archived ? Date.now() : null;
  }
  await request.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200 ? {} : { error: longError }),
  });
}
async function external(page, kind, height) {
  if (kind === "field") {
    await page.locator("#outside-field").evaluate((n) => (n.style.visibility = "visible"));
    await page.locator("#outside-field").fill("Independent newer draft");
  } else {
    await page.locator("#outside-blank").evaluate((n) => (n.style.visibility = "visible"));
    await page.mouse.click(12, height - 12);
    await page.locator("body").evaluate((n) => {
      n.tabIndex = -1;
      n.focus();
    });
  }
  await frames(page);
}
async function finishRead(host, held = host.pendingReads.shift(), status = host.readStatus) {
  assert.ok(held);
  const u = new URL(held.url),
    archive = u.searchParams.get("archived"),
    query = u.searchParams.get("query") ?? "";
  let data = host.sessions.filter(
    (s) =>
      (archive === "all" || Boolean(s.archivedAt) === (archive === "true")) &&
      s.title.includes(query),
  );
  let nextCursor = null;
  if (host.more) {
    if (u.searchParams.has("cursor")) data = data.slice(4);
    else {
      data = data.slice(0, 6);
      nextCursor = "owned-more";
    }
  }
  await held.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(
      status === 200
        ? { sessions: data, nextCursor }
        : { error: "Owned session list read rejected" },
    ),
  });
}
async function finishDetail(host, held = host.pendingDetails.shift(), status = host.detailStatus) {
  assert.ok(held);
  const data = host.sessions.find((s) => s.sessionId === held.id);
  if (status === 200) {
    data.customTitle = "Latest external title";
    data.title = "Latest external title";
  }
  await held.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200 ? data : { error: "Owned latest title read rejected" }),
  });
}
const focusToken = (page) =>
  page.evaluate(() =>
    [
      document.activeElement.id || document.activeElement.tagName,
      document.activeElement.getAttribute("aria-label"),
    ].join("|"),
  );
async function visible(locator, focused = false) {
  const v = await locator.evaluate((node) => {
    const b = node.getBoundingClientRect(),
      hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    let top = 0,
      bottom = innerHeight,
      left = 0,
      right = innerWidth;
    const hidden = [];
    for (let p = node.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        r = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) {
        top = Math.max(top, r.top + p.clientTop);
        bottom = Math.min(bottom, r.top + p.clientTop + p.clientHeight);
      }
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
        left = Math.max(left, r.left + p.clientLeft);
        right = Math.min(right, r.left + p.clientLeft + p.clientWidth);
      }
      if (
        (/hidden|clip/.test(s.overflowY) && p.scrollTop !== 0) ||
        (/hidden|clip/.test(s.overflowX) && p.scrollLeft !== 0)
      )
        hidden.push(p.tagName);
    }
    return {
      box: b.toJSON(),
      clip: { top, bottom, left, right },
      hit: !!hit && node.contains(hit),
      focused: node === document.activeElement,
      hidden,
      document: [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        innerWidth,
        innerHeight,
      ],
    };
  });
  assert.ok(
    v.box.width > 0 &&
      v.box.height > 0 &&
      v.box.top >= v.clip.top - 1 &&
      v.box.bottom <= v.clip.bottom + 1 &&
      v.box.left >= v.clip.left - 1 &&
      v.box.right <= v.clip.right + 1,
    JSON.stringify(v),
  );
  assert.equal(v.hit, true, JSON.stringify(v));
  if (focused) assert.equal(v.focused, true, JSON.stringify(v));
  assert.deepEqual(v.hidden, []);
  assert.ok(
    v.document[0] <= v.document[2] + 1 && v.document[1] <= v.document[3] + 1,
    JSON.stringify(v),
  );
  return v;
}
async function ready(page) {
  await page.waitForFunction(
    () => document.querySelector(".session-history-list")?.getAttribute("aria-busy") === "false",
  );
  await frames(page);
}
const titleInput = (p) => edit(p).getByRole("textbox", { name: "对话标题", exact: true });
const saveTitle = (p) => edit(p).getByRole("button", { name: /^(保存标题|确认保存我的标题)$/ });
async function rename(page) {
  await openRename(page);
  await titleInput(page).fill("Owned newer title");
  await saveTitle(page).focus();
  await page.keyboard.press("Enter");
}
async function archive(page) {
  await row(page).getByRole("button", { name: "归档", exact: true }).focus();
  await page.keyboard.press("Enter");
}
async function interrupt(page, kind, height) {
  if (kind === "field" || kind === "blank") await external(page, kind, height);
  if (kind === "svg") {
    await page.locator("#outside-blank").evaluate((n) => {
      n.style.visibility = "visible";
      n.innerHTML = '<svg width="24" height="24"><rect width="24" height="24"/></svg>';
      n.addEventListener("pointerdown", (e) => (window.svgPointer = e.target.namespaceURI));
    });
    await page.mouse.click(12, height - 12);
    assert.equal(await page.evaluate(() => window.svgPointer), "http://www.w3.org/2000/svg");
    await page.locator("body").evaluate((n) => {
      n.tabIndex = -1;
      n.focus();
    });
  }
  if (kind === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  if (kind === "unmount") await page.evaluate(() => window.unmountFixture());
  if (kind === "workspace") await page.evaluate(() => window.changeWorkspace());
  await frames(page);
  return focusToken(page);
}
async function settleScroll(locator) {
  await locator.evaluate(
    (node) =>
      new Promise((resolve, reject) => {
        let prior = node.scrollTop,
          stable = 0,
          attempts = 0;
        const check = () => {
          if (++attempts > 300) return reject(Error("Native scroll must settle"));
          stable = Math.abs(node.scrollTop - prior) < 0.1 ? stable + 1 : 0;
          prior = node.scrollTop;
          if (stable >= 5) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}
async function readLong(page, locator) {
  await locator.focus();
  assert.ok(await locator.evaluate((n) => n.scrollHeight > n.clientHeight));
  await page.keyboard.press("End");
  await page.waitForFunction(
    (n) => n.scrollTop + n.clientHeight >= n.scrollHeight - 1,
    await locator.elementHandle(),
  );
  await settleScroll(locator);
  await page.keyboard.press("Home");
  await page.waitForFunction((n) => n.scrollTop === 0, await locator.elementHandle());
  await settleScroll(locator);
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction((n) => n.scrollTop > 0, await locator.elementHandle());
  await visible(locator, true);
}
try {
  if (!process.argv.includes("--behaviors-only"))
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [800, 360],
        [1280, 720],
      ])
        for (const action of ["rename", "archive"])
          for (const ok of [false, true]) {
            const { page, host } = await mount(width, height, { theme });
            host.hold = true;
            if (action === "rename") await rename(page);
            else await archive(page);
            await until(page, () => host.pending.length === 1);
            await frames(page);
            assert.equal(host.calls.length, 1);
            await finish(host, ok ? 200 : 500);
            await ready(page);
            if (action === "rename") {
              assert.deepEqual(host.calls[0], {
                path: "/api/v1/sessions/owned-session-11",
                method: "PATCH",
                body: { title: "Owned newer title", expectedTitle: "Owned session 11" },
              });
              if (ok) {
                await edit(page).waitFor({ state: "hidden" });
                await visible(row(page).getByRole("button", { name: "重命名", exact: true }), true);
                assert.equal(
                  await row(page)
                    .getByRole("button", { name: "Owned newer title", exact: true })
                    .count(),
                  1,
                );
              } else {
                const alert = edit(page).getByRole("alert");
                assert.equal(await alert.textContent(), longError);
                assert.equal(await page.getByRole("alert").count(), 1);
                await visible(alert, true);
                assert.equal(await titleInput(page).inputValue(), "Owned newer title");
                await readLong(page, alert);
                await page.keyboard.press("Tab");
                await visible(titleInput(page), true);
                await page.keyboard.press("Tab");
                await visible(saveTitle(page), true);
              }
            } else {
              assert.deepEqual(host.calls[0], {
                path: "/api/v1/sessions/owned-session-11",
                method: "PATCH",
                body: { archived: true },
              });
              const receipt = page.getByRole(ok ? "status" : "alert", {
                name: "会话操作结果",
                exact: true,
              });
              await visible(receipt, true);
              assert.equal(await page.locator(".session-history-row").count(), ok ? 11 : 12);
              if (!ok) {
                assert.equal(await receipt.textContent(), longError);
                assert.equal(await page.getByRole("alert").count(), 1);
                await readLong(page, receipt);
              }
            }
            await page.screenshot({
              path: path.join(
                output,
                `${action}-${ok ? "success" : "failure"}-${theme}-${width}x${height}.png`,
              ),
            });
            reports.push({
              label: "operation-layout",
              theme,
              width,
              height,
              action,
              ok,
              calls: host.calls,
            });
          }
  for (const action of ["rename", "archive"])
    for (const ok of [false, true])
      for (const kind of ["field", "blank", "svg", "blur", "unmount", "workspace"]) {
        const { page, host } = await mount(390, 360);
        host.hold = true;
        if (action === "rename") await rename(page);
        else await archive(page);
        await until(page, () => host.pending.length === 1);
        await frames(page);
        const before = await interrupt(page, kind, 360);
        await finish(host, ok ? 200 : 500);
        await frames(page);
        if (kind !== "unmount") await ready(page);
        assert.equal(
          await focusToken(page),
          before,
          `${action}/${kind}/${ok} preserves later focus`,
        );
        if (kind === "field")
          assert.equal(
            await page.locator("#outside-field").inputValue(),
            "Independent newer draft",
          );
        assert.equal(host.calls.length, 1);
        reports.push({ label: "later-owner", action, ok, kind });
      }
  // Save/title comparison rules and explicit refresh keep the draft intact.
  for (const status of [409, 404]) {
    const { page, host } = await mount(390, 360);
    host.hold = true;
    await rename(page);
    await until(page, () => host.pending.length === 1);
    await finish(host, status);
    await edit(page).getByRole("alert").waitFor();
    await frames(page);
    assert.equal(await titleInput(page).inputValue(), "Owned newer title");
    assert.equal(
      await edit(page).getByRole("button", { name: "保存标题", exact: true }).isDisabled(),
      true,
    );
    host.holdDetail = true;
    const latest = edit(page).getByRole("button", { name: "读取最新标题", exact: true });
    await latest.focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pendingDetails.length === 1);
    await finishDetail(host, undefined, status === 409 ? 200 : 404);
    await frames(page);
    if (status === 409) {
      await visible(titleInput(page), true);
      assert.equal(await titleInput(page).inputValue(), "Owned newer title");
      await saveTitle(page).focus();
      await page.keyboard.press("Enter");
      await until(page, () => host.pending.length === 1);
      assert.deepEqual(host.calls[1].body, {
        title: "Owned newer title",
        expectedTitle: "Latest external title",
      });
      await finish(host, 200);
      await ready(page);
      await edit(page).waitFor({ state: "hidden" });
    } else {
      await visible(edit(page).getByRole("alert"), true);
      assert.equal(await titleInput(page).inputValue(), "Owned newer title");
      assert.equal(await saveTitle(page).isDisabled(), true);
    }
    reports.push({
      label: "explicit-title-comparison",
      status,
      calls: host.calls,
      details: host.details,
    });
  }
  for (const kind of ["field", "blank", "blur"]) {
    const { page, host } = await mount(390, 360);
    host.hold = true;
    await rename(page);
    await until(page, () => host.pending.length === 1);
    await finish(host, 409);
    await edit(page).getByRole("alert").waitFor();
    host.holdDetail = true;
    await edit(page).getByRole("button", { name: "读取最新标题", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pendingDetails.length === 1);
    const before = await interrupt(page, kind, 360);
    await finishDetail(host, undefined, 200);
    await frames(page);
    assert.equal(await focusToken(page), before);
    assert.equal(await titleInput(page).inputValue(), "Owned newer title");
    reports.push({ label: "latest-title-outside-owner", kind });
  }
  {
    const { page, host } = await mount(390, 360);
    host.hold = true;
    await openRename(page);
    await edit(page).getByRole("button", { name: "使用自动标题", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pending.length === 1);
    assert.deepEqual(host.calls[0].body, { title: "", expectedTitle: "Owned session 11" });
    await finish(host, 200);
    await ready(page);
    await visible(row(page).getByRole("button", { name: "重命名", exact: true }), true);
    assert.equal(
      await row(page).getByRole("button", { name: "Owned generated title", exact: true }).count(),
      1,
    );
    reports.push({ label: "automatic-title-contract", calls: host.calls });
  }
  {
    const { page, host } = await mount(390, 360);
    await openRename(page);
    await titleInput(page).fill("Unsaved reusable draft");
    await edit(page).getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Enter");
    await edit(page).waitFor({ state: "hidden" });
    await visible(row(page).getByRole("button", { name: "重命名", exact: true }), true);
    assert.equal(host.calls.length, 0);
    reports.push({ label: "cancel-rename-no-write" });
  }
  // A post-write reread can remove the row; feedback must wait for its stable surface.
  for (const action of ["rename", "archive"])
    for (const kind of ["normal", "blank"]) {
      const { page, host } = await mount(320, 240);
      host.hold = true;
      host.holdRead = true;
      if (action === "rename") await rename(page);
      else await archive(page);
      await until(page, () => host.pending.length === 1);
      await finish(host, 200);
      await until(page, () => host.pendingReads.length === 1);
      await frames(page);
      const before = kind === "normal" ? null : await interrupt(page, kind, 240);
      host.sessions = host.sessions.filter((s) => s.sessionId !== "owned-session-11");
      await finishRead(host, undefined, 200);
      await ready(page);
      if (kind === "normal") {
        if (action === "rename")
          await visible(page.getByRole("searchbox", { name: "搜索对话标题", exact: true }), true);
        else await visible(page.getByRole("status", { name: "会话操作结果", exact: true }), true);
      } else assert.equal(await focusToken(page), before);
      assert.equal(host.calls.length, 1);
      reports.push({ label: "post-write-row-gone", action, kind });
    }
  for (const kind of ["normal", "blank"]) {
    const { page, host } = await mount(390, 360);
    host.hold = true;
    await archive(page);
    await until(page, () => host.pending.length === 1);
    host.holdRead = true;
    await page.evaluate(() => window.bumpSessions());
    await until(page, () => host.pendingReads.length === 1);
    await finish(host, 500);
    const before = kind === "normal" ? null : await interrupt(page, kind, 360);
    host.sessions = host.sessions.filter((s) => s.sessionId !== "owned-session-11");
    await finishRead(host, undefined, 200);
    await ready(page);
    if (kind === "normal")
      await visible(page.getByRole("alert", { name: "会话操作结果", exact: true }), true);
    else assert.equal(await focusToken(page), before);
    assert.equal(await page.locator(".session-history-row").count(), 11);
    reports.push({ label: "pushed-read-target-gone", kind });
  }
  // Read errors describe failure, not an authoritative empty history.
  for (const failure of [false, true]) {
    const { page, host } = await mount(390, 360, { empty: true, readFailure: failure });
    const empty = page.locator(".library-empty");
    assert.equal(
      await empty.textContent(),
      failure
        ? "未能读取对话，请使用刷新重试。"
        : "还没有保存的对话，开始一条新对话后会显示在这里。",
    );
    if (failure) {
      await visible(page.getByRole("alert", { name: "对话读取失败", exact: true }));
      host.readStatus = 200;
      host.sessions = sessions();
      await page.getByRole("button", { name: "刷新", exact: true }).focus();
      await page.keyboard.press("Enter");
      await ready(page);
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.locator(".session-history-row").count(), 12);
    }
    reports.push({ label: "truthful-read-and-retry", failure });
  }
  for (const kind of ["normal", "field", "blank", "blur"]) {
    const { page, host } = await mount(390, 360, { more: true });
    host.holdRead = true;
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    await more.focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pendingReads.length === 1);
    const before = kind === "normal" ? null : await interrupt(page, kind, 360);
    await finishRead(host, undefined, 500);
    await frames(page);
    if (kind === "normal")
      await visible(page.getByRole("alert", { name: "对话读取失败", exact: true }), true);
    else assert.equal(await focusToken(page), before);
    assert.equal(await page.locator(".session-history-row").count(), 6);
    host.holdRead = false;
    host.readStatus = 200;
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll(".session-history-row").length === 12,
    );
    await frames(page);
    await visible(page.getByRole("button", { name: "Owned session 6", exact: true }), true);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await more.count(), 0);
    assert.equal(host.calls.length, 0);
    assert.ok(host.reads.some((q) => q.includes("cursor=owned-more")));
    reports.push({ label: "more-failure-retry-deduplicate", kind, reads: host.reads });
  }
  {
    const { page, host } = await mount(390, 360, { more: true });
    host.holdRead = true;
    await page.getByRole("button", { name: "加载更多", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pendingReads.length === 1);
    const search = page.getByRole("searchbox", { name: "搜索对话标题", exact: true });
    await search.fill("not-found");
    await until(page, () => host.reads.some((q) => q.includes("query=not-found")));
    for (const held of host.pendingReads.splice(0)) await finishRead(host, held, 200);
    await ready(page);
    await visible(search, true);
    assert.equal(await search.inputValue(), "not-found");
    assert.equal(await page.locator(".session-history-row").count(), 0);
    reports.push({ label: "more-search-replacement" });
  }
  // Ordinary history keyboard-open adopts only the actual intent until ID commit.
  for (const kind of ["normal", "field", "blank", "svg", "blur", "workspace", "unmount"]) {
    const { page } = await mount(1280, 720);
    await page.evaluate(() => (window.holdSelection = true));
    await row(page).getByRole("button", { name: "Owned session 11", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.selectionCalls.length === 1);
    await frames(page);
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    const before = kind === "normal" ? null : await interrupt(page, kind, 720);
    await page.evaluate(() => window.acceptSelection());
    await frames(page);
    if (kind === "normal")
      await visible(page.getByRole("region", { name: "消息列表", exact: true }), true);
    else assert.equal(await focusToken(page), before);
    const accepted = await focusToken(page);
    await page.evaluate(() => window.finishSelection());
    await frames(page);
    assert.equal(await focusToken(page), accepted);
    reports.push({ label: "history-destination-owned", kind });
  }
  // Restore-and-open waits for dirty/busy/reread, then transfers the same lease.
  for (const phase of ["write", "reread"])
    for (const kind of [
      "normal",
      "field",
      "blank",
      "svg",
      "blur",
      "search",
      "workspace",
      "unmount",
      "navigation",
    ]) {
      const { page, host } = await mount(1280, 720, { archived: true });
      await page.locator(".session-toolbar select").selectOption("true");
      await page.waitForFunction(
        () => document.querySelectorAll(".session-history-row").length === 1,
      );
      host.hold = true;
      await row(page).getByRole("button", { name: "Owned session 11", exact: true }).focus();
      await page.keyboard.press("Enter");
      await until(page, () => host.pending.length === 1);
      host.holdRead = true;
      if (phase === "reread") {
        await finish(host, 200);
        await until(page, () => host.pendingReads.length === 1);
      }
      if (["field", "blank", "svg", "blur", "workspace", "unmount"].includes(kind))
        await interrupt(page, kind, 720);
      if (kind === "search") {
        await page.getByRole("searchbox", { name: "搜索对话标题", exact: true }).fill("not-found");
      }
      if (kind === "navigation") {
        await page.getByRole("button", { name: "新对话", exact: true }).click();
        if (await page.getByRole("dialog").count())
          await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
        await frames(page);
      }
      const ownedElement = await page.evaluateHandle(() => document.activeElement);
      if (phase === "write") await finish(host, 200);
      if (kind !== "unmount" && kind !== "navigation") {
        await until(page, () => host.pendingReads.length > 0);
        for (const held of host.pendingReads.splice(0)) await finishRead(host, held, 200);
        await frames(page);
        await frames(page);
        if (kind === "search") {
          await until(page, () => host.reads.some((q) => q.includes("query=not-found")));
          for (const held of host.pendingReads.splice(0)) await finishRead(host, held, 200);
          await ready(page);
        }
      } else await frames(page);
      if (kind === "normal") {
        await page.waitForFunction(() => window.selectionCalls.length === 1);
        assert.equal(await page.getByRole("dialog").count(), 0);
        await visible(page.getByRole("region", { name: "消息列表", exact: true }), true);
        const active = await focusToken(page);
        await page.evaluate(() => window.finishSelection());
        await frames(page);
        assert.equal(await focusToken(page), active);
      } else {
        assert.equal(await page.evaluate(() => window.selectionCalls.length), 0);
        if (await ownedElement.evaluate((node) => node.isConnected))
          assert.equal(
            await ownedElement.evaluate((node) => node === document.activeElement),
            true,
          );
        else
          assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      }
      await ownedElement.dispose();
      assert.deepEqual(host.calls, [
        { path: "/api/v1/sessions/owned-session-11", method: "PATCH", body: { archived: false } },
      ]);
      reports.push({ label: "restore-open-owned", phase, kind });
    }
  {
    const { page, host } = await mount(1280, 720, { archived: true });
    host.sessions[10].archivedAt = 1792031000000;
    await page.locator(".session-toolbar select").selectOption("true");
    await page.waitForFunction(
      () => document.querySelectorAll(".session-history-row").length === 2,
    );
    await page
      .locator(".session-history-row")
      .first()
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await titleInput(page).fill("True unsaved title draft");
    host.hold = true;
    await row(page).getByRole("button", { name: "Owned session 11", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pending.length === 1);
    await finish(host, 200);
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "还有未保存的修改", exact: true }).count(),
      1,
    );
    assert.equal(await page.evaluate(() => window.selectionCalls.length), 0);
    assert.equal(await titleInput(page).inputValue(), "True unsaved title draft");
    await page.getByRole("button", { name: "留在此页", exact: true }).click();
    assert.equal(await titleInput(page).inputValue(), "True unsaved title draft");
    assert.equal(host.calls.length, 1);
    reports.push({ label: "restore-open-keeps-true-dirty-confirm" });
  }
  for (const kind of ["normal", "field"]) {
    const { page, host } = await mount(1280, 720, { archived: true });
    await page.evaluate(() => {
      window.hubRefreshOnly = true;
    });
    await page.locator(".session-toolbar select").selectOption("true");
    await page.waitForFunction(
      () => document.querySelectorAll(".session-history-row").length === 1,
    );
    host.hold = true;
    await row(page).getByRole("button", { name: "Owned session 11", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pending.length === 1);
    if (kind === "field") await interrupt(page, kind, 720);
    await finish(host, 200);
    if (kind === "normal") {
      await page.waitForFunction(() => window.selectionCalls.length === 1);
      await visible(page.getByRole("region", { name: "消息列表", exact: true }), true);
    } else {
      await ready(page);
      await frames(page);
      await frames(page);
      assert.equal(await page.evaluate(() => window.selectionCalls.length), 0);
      assert.equal(
        await page.locator("#outside-field").evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(await page.locator("#outside-field").inputValue(), "Independent newer draft");
    }
    assert.equal(await page.evaluate(() => window.changeCalls), 1);
    assert.equal(host.calls.length, 1);
    reports.push({ label: "hub-refresh-without-version-restore-open", kind });
  }
  {
    const { page, host } = await mount(1280, 720, { archived: true });
    await page.locator(".session-toolbar select").selectOption("true");
    await page.waitForFunction(
      () => document.querySelectorAll(".session-history-row").length === 1,
    );
    host.hold = true;
    host.holdRead = true;
    await row(page).getByRole("button", { name: "Owned session 11", exact: true }).focus();
    await page.keyboard.press("Enter");
    await until(page, () => host.pending.length === 1);
    await finish(host, 200);
    await until(page, () => host.pendingReads.length > 0);
    // Observe the actual settled DOM commit, before its delayed open callback.
    await page.evaluate(() => {
      window.commitHandoffFired = false;
      const field = document.getElementById("outside-field");
      field.style.visibility = "visible";
      const observer = new MutationObserver(() => {
        const list = document.querySelector(".session-history-list");
        if (
          list?.getAttribute("aria-busy") !== "false" ||
          document.querySelectorAll(".session-history-row").length !== 0
        )
          return;
        observer.disconnect();
        field.value = "New draft after commit";
        field.focus();
        window.commitHandoffFired = true;
      });
      observer.observe(document.getElementById("root"), {
        subtree: true,
        attributes: true,
        childList: true,
      });
    });
    for (const held of host.pendingReads.splice(0)) await finishRead(host, held, 200);
    await page.waitForFunction(() => window.commitHandoffFired);
    await frames(page);
    await frames(page);
    assert.equal(
      await page.locator("#outside-field").evaluate((n) => n === document.activeElement),
      true,
    );
    assert.equal(await page.locator("#outside-field").inputValue(), "New draft after commit");
    assert.equal(await page.evaluate(() => window.selectionCalls.length), 0);
    assert.equal(host.calls.length, 1);
    reports.push({ label: "restore-open-after-commit-handoff" });
  }
  for (const status of [401]) {
    const { page, host } = await mount(390, 360);
    host.hold = true;
    await rename(page);
    await until(page, () => host.pending.length === 1);
    await finish(host, status);
    await page.waitForFunction(() => window.authLost === 1);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(host.calls.length, 1);
    reports.push({ label: "auth-lost-preserved" });
  }
  for (const [width, height] of [
    [390, 360],
    [1280, 720],
  ]) {
    const { page, host } = await mount(width, height, { long: true });
    const title = row(page).getByRole("button", { name: longTitle, exact: true });
    assert.equal(await title.textContent(), longTitle);
    assert.equal(await title.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), true);
    await title.focus();
    await page.screenshot({ path: path.join(output, `full-title-${width}x${height}.png`) });
    const exports = row(page).locator(".session-export");
    await exports.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await exports.getByRole("link", { name: "Markdown 文档", exact: true }).getAttribute("href"),
      "/api/v1/sessions/owned-session-11/export?format=markdown",
    );
    assert.equal(host.calls.length, 0);
    reports.push({
      label: "full-legal-title-and-export-links",
      width,
      height,
      length: longTitle.length,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  const pages = context?.pages() ?? [];
  if (pages[0])
    await pages[0].screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ repo, development, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ output, observations: reports.length, errors, blocked }));
}
