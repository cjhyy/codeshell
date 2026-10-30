/** Actual Workbench Models actions; owned HTTP only. Supports --source-repo and --development. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, Event */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ownRepo = fileURLToPath(new URL("../../..", import.meta.url));
const index = process.argv.indexOf("--source-repo");
const repo = index < 0 ? ownRepo : path.resolve(process.argv[index + 1]);
const require = createRequire(path.join(ownRepo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-model-actions-"));
const development = process.argv.includes("--development");
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const root=createRoot(document.getElementById('root')),noop=()=>{};window.authLost=0;window.changes=0;
function Fixture(){const[version,setVersion]=React.useState(0);window.bumpConfiguration=()=>setVersion(n=>n+1);const controller={panelSessionId:undefined,host:'desktop',workspaceApi:true,connection:'open',activeId:'owned',chat:{items:[],run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'New conversation',configuration:null,configurationVersion:version,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:()=>window.changes++,onAuthLost:()=>window.authLost++};return <Workbench controller={controller}/>}
window.unmountFixture=()=>root.render(null);root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
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
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const origin = "http://model-actions-owned.test",
  url = origin + "/?view=settings&section=models";
const errors = [],
  blocked = [],
  reports = [];
const longId = "long" + "x".repeat(124);
const longError = "Owned rejected operation " + "hash".repeat(250) + "\nComplete final error line";
const snapshot = () => ({
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: { text: "owned-0", auxText: "owned-1" },
  connections: Array.from({ length: 12 }, (_, i) => ({
    id: "owned-" + i,
    revision: String(i).padStart(64, "0"),
    catalogId: "openai",
    tag: "text",
    model: "owned-model-" + i,
    baseUrl: "https://owned.invalid/v1",
    hasApiKey: true,
    needsKey: true,
  })),
  catalog: [
    {
      id: "openai",
      displayName: "Owned provider",
      adapterKind: "openai",
      defaultBaseUrl: "https://owned.invalid/v1",
      needsKey: true,
    },
  ],
  skills: [],
  mcpServers: [],
  restartRequired: false,
});
let page, context, host;
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const defaults = () => page.locator(".config-defaults"),
  save = () => defaults().getByRole("button", { name: "保存默认模型", exact: true });
const text = () => defaults().getByRole("button", { name: "默认对话模型", exact: true });
async function chooseModel(trigger, value) {
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: await trigger.getAttribute("aria-label"),
    exact: true,
  });
  await dialog.locator(`[role="option"][value=${JSON.stringify(value)}]`).click();
  await dialog.waitFor({ state: "detached" });
}
const card = (id = "owned-11") =>
  page
    .locator(".config-connection-card")
    .filter({ has: page.locator("strong", { hasText: new RegExp("^" + id + "$") }) });
const confirmation = () =>
  page
    .locator(".config-remove-confirm")
    .filter({ has: page.getByRole("button", { name: "确认删除连接", exact: true }) });
const confirm = () => confirmation().getByRole("button", { name: "确认删除连接", exact: true });
const cancel = () => confirmation().getByRole("button", { name: "取消删除", exact: true });
const focusToken = () =>
  page.evaluate(() => {
    const n = document.activeElement;
    return n === document.body
      ? "BODY"
      : [n?.tagName, n?.id, n?.getAttribute("aria-label"), n?.textContent?.slice(0, 60)].join("|");
  });
async function visible(locator, focused = false) {
  const value = await locator.evaluate((node) => {
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
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
      }
      if (
        (/hidden|clip/.test(s.overflowY) && p.scrollTop !== 0) ||
        (/hidden|clip/.test(s.overflowX) && p.scrollLeft !== 0)
      )
        hidden.push({ tag: p.tagName, top: p.scrollTop, left: p.scrollLeft });
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
    value.box.width > 0 &&
      value.box.height > 0 &&
      value.box.top >= value.clip.top - 1 &&
      value.box.bottom <= value.clip.bottom + 1 &&
      value.box.left >= value.clip.left - 1 &&
      value.box.right <= value.clip.right + 1,
    JSON.stringify(value),
  );
  assert.equal(value.hit, true, JSON.stringify(value));
  if (focused) assert.equal(value.focused, true, JSON.stringify(value));
  assert.deepEqual(value.hidden, []);
  assert.ok(
    value.document[0] <= value.document[2] + 1 && value.document[1] <= value.document[3] + 1,
    JSON.stringify(value),
  );
  return value;
}
async function mount({ width = 390, height = 360, theme = "light", single = false } = {}) {
  await context?.close();
  context = await browser.newContext({
    viewport: { width, height },
    hasTouch: width <= 760,
    isMobile: width <= 760,
    colorScheme: theme,
    serviceWorkers: "block",
  });
  host = {
    configuration: snapshot(),
    writes: [],
    reads: [],
    pendingWrites: [],
    pendingReads: [],
    holdWrite: false,
    holdRead: false,
    writeStatus: 500,
    readStatus: 200,
    message: longError,
  };
  host.configuration.connections[5].id = longId;
  host.configuration.connections[5].model = "model" + "x".repeat(251);
  if (single) {
    host.configuration.connections = host.configuration.connections.slice(0, 1);
    host.configuration.defaults = { text: "owned-0" };
  }
  await context.route("**/*", async (route) => {
    const request = route.request(),
      u = new URL(request.url());
    if (request.url() === url)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Outside field" style="position:fixed;bottom:0;right:0;width:60px;z-index:999;visibility:hidden"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999;visibility:hidden"></div>',
      });
    if (u.origin !== origin) {
      blocked.push(u.href);
      return route.abort();
    }
    if (u.pathname === "/api/v1/environment" && request.method() === "GET")
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (u.pathname === "/api/v1/configuration" && request.method() === "GET") {
      host.reads.push(u.pathname);
      if (host.holdRead) {
        host.pendingReads.push(route);
        return;
      }
      return route.fulfill({
        status: host.readStatus,
        contentType: "application/json",
        body: JSON.stringify(
          host.readStatus === 200
            ? host.configuration
            : { error: "Owned configuration read rejected" },
        ),
      });
    }
    if (
      (u.pathname === "/api/v1/configuration/defaults" && request.method() === "PUT") ||
      (u.pathname === "/api/v1/configuration/connections" && request.method() === "DELETE")
    ) {
      const write = {
        route,
        path: u.pathname,
        method: request.method(),
        body: request.postDataJSON(),
      };
      host.writes.push({ path: write.path, method: write.method, body: write.body });
      if (host.holdWrite) {
        host.pendingWrites.push(write);
        return;
      }
      return finishWrite(write, host.writeStatus);
    }
    blocked.push(u.href);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
  });
  await text().waitFor();
  await frames();
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    theme,
  );
}
async function finishWrite(write = host.pendingWrites.shift(), status = host.writeStatus) {
  assert.ok(write);
  if (status === 200) {
    if (write.method === "PUT") {
      // Like the Hub, merge only the defaults the form changed (R25).
      const next = { ...host.configuration.defaults, ...write.body };
      if (next.auxText === null) delete next.auxText;
      host.configuration.defaults = next;
    } else {
      host.configuration.connections = host.configuration.connections.filter(
        (c) => c.id !== write.body.id,
      );
      if (host.configuration.defaults.text === write.body.id)
        host.configuration.defaults.text =
          write.body.replacementText ?? host.configuration.connections[0]?.id;
      if (host.configuration.defaults.auxText === write.body.id)
        delete host.configuration.defaults.auxText;
    }
  }
  await write.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200 ? host.configuration : { error: host.message }),
  });
}
async function finishReads(status = host.readStatus) {
  const held = host.pendingReads.splice(0);
  assert.ok(held.length);
  for (const route of held)
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200 ? host.configuration : { error: "Owned configuration read rejected" },
      ),
    });
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Owned request must be issued");
    await frames();
  }
}
async function ready() {
  await page.waitForFunction(() => !document.querySelector(".config-defaults fieldset").disabled);
  await frames();
}
async function submitDefault() {
  await chooseModel(text(), "owned-11");
  await save().focus();
  await page.keyboard.press("Enter");
}
async function openDelete(id = "owned-11") {
  await card(id).getByRole("button", { name: "删除", exact: true }).focus();
  await page.keyboard.press("Enter");
  await confirmation().waitFor();
  await frames();
  const replacement = confirmation().getByRole("combobox", { name: "替代默认模型", exact: true });
  if (await replacement.count()) {
    await visible(replacement, true);
  } else {
    await visible(cancel(), true);
    await visible(confirm());
  }
}
async function submitDelete() {
  await confirm().focus();
  await page.keyboard.press("Enter");
}
async function singleFeedback(container, message, role = "alert") {
  assert.equal(
    await page.getByRole(role).filter({ hasText: message }).count(),
    1,
    "Each operation has one live feedback surface",
  );
  const feedback = container.getByRole(role).filter({ hasText: message });
  assert.equal(await feedback.textContent(), message);
  await visible(feedback);
  return feedback;
}
async function settleScroll(locator) {
  await locator.evaluate(
    (node) =>
      new Promise((resolve, reject) => {
        let prior = node.scrollTop,
          stable = 0,
          attempts = 0;
        const check = () => {
          if (++attempts > 300) {
            reject(new Error("Native scroll must settle"));
            return;
          }
          stable = Math.abs(node.scrollTop - prior) < 0.1 ? stable + 1 : 0;
          prior = node.scrollTop;
          if (stable >= 5) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}
async function readLong(feedback) {
  await feedback.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(
    (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
    await feedback.elementHandle(),
  );
  await settleScroll(feedback);
  await page.keyboard.press("Home");
  await page.waitForFunction((node) => node.scrollTop === 0, await feedback.elementHandle());
  await settleScroll(feedback);
  const b = await feedback.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction((node) => node.scrollTop > 0, await feedback.elementHandle());
  await visible(feedback, true);
}
async function interrupt(kind) {
  if (kind === "field") {
    await page.locator("#outside-field").evaluate((node) => {
      node.style.visibility = "visible";
    });
    await page.locator("#outside-field").fill("New independent draft");
  }
  if (kind === "blank") {
    await page.locator("#outside-blank").evaluate((node) => {
      node.style.visibility = "visible";
    });
    await page.mouse.click(12, (await page.viewportSize()).height - 12);
    await page.locator("body").evaluate((node) => {
      node.tabIndex = -1;
      node.focus();
    });
  }
  if (kind === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  if (kind === "unmount") await page.evaluate(() => window.unmountFixture());
  await frames();
  return focusToken();
}
try {
  for (const theme of ["light", "dark"]) {
    await mount({ width: 390, height: 844, theme });
    await text().tap();
    const picker = page.getByRole("dialog", { name: "默认对话模型", exact: true });
    const list = picker.getByRole("listbox");
    assert.ok(
      await list.evaluate((node) => node.scrollHeight > node.clientHeight),
      "settings model list scrolls independently",
    );
    await picker.getByRole("searchbox", { name: "搜索模型" }).fill("owned-model-11");
    await picker.getByRole("searchbox", { name: "搜索模型" }).press("Enter");
    assert.deepEqual(host.writes, [], "search Enter does not submit the settings form");
    await picker.getByRole("option", { name: "owned-11 · owned-model-11", exact: true }).tap();
    assert.equal(await text().getAttribute("value"), "owned-11");
    assert.deepEqual(host.writes, [], "choosing a settings model edits only the form until Save");
    await text().tap();
    await page.setViewportSize({ width: 320, height: 360 });
    await frames();
    const box = await picker.boundingBox();
    assert.ok(
      box.x >= 10 && box.x + box.width <= 310 && box.y >= 10 && box.y + box.height <= 350,
      JSON.stringify(box),
    );
    await picker.getByRole("searchbox", { name: "搜索模型" }).fill("missing fixture model");
    await picker.getByText("没有匹配的模型", { exact: true }).waitFor();
    await picker.getByRole("button", { name: "关闭模型选择" }).tap();
    assert.equal(await text().getAttribute("value"), "owned-11");
    assert.equal(await text().evaluate((node) => document.activeElement === node), true);
    assert.deepEqual(host.writes, []);
    reports.push({ label: "mobile-default-model-picker", theme, box, writes: host.writes });
  }
  if (!process.argv.includes("--behaviors-only"))
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [760, 360],
        [1280, 820],
      ])
        for (const action of ["defaults", "delete"]) {
          const config = { theme, width, height, action };
          await mount(config);
          if (action === "defaults") {
            await submitDefault();
            await page.getByRole("alert").waitFor();
            await ready();
            await visible(save(), true);
            const feedback = await singleFeedback(defaults(), longError);
            assert.equal(await text().getAttribute("value"), "owned-11");
            assert.deepEqual(host.writes[0], {
              path: "/api/v1/configuration/defaults",
              method: "PUT",
              // Only the changed default is sent, so a stale form cannot roll back the other (R25).
              body: { text: "owned-11" },
            });
            await readLong(feedback);
          } else {
            await openDelete();
            await submitDelete();
            await confirmation().getByRole("alert").waitFor();
            await ready();
            await visible(confirm(), true);
            const feedback = await singleFeedback(confirmation(), longError);
            assert.equal(await page.locator(".config-connection-card").count(), 12);
            assert.deepEqual(host.writes[0], {
              path: "/api/v1/configuration/connections",
              method: "DELETE",
              body: { id: "owned-11", expectedRevision: String(11).padStart(64, "0") },
            });
            await readLong(feedback);
          }
          reports.push({ label: "failure-recovery", ...config, writes: host.writes });
          await page.screenshot({
            path: path.join(output, action + "-" + theme + "-" + width + "x" + height + ".png"),
          });
        }
  for (const action of ["defaults", "delete"])
    for (const ok of [false, true])
      for (const interruption of ["field", "blank", "blur", "unmount"]) {
        await mount();
        host.holdWrite = true;
        if (action === "defaults") await submitDefault();
        else {
          await openDelete();
          await submitDelete();
        }
        await until(() => host.pendingWrites.length === 1);
        await frames();
        const before = await interrupt(interruption);
        await finishWrite(undefined, ok ? 200 : 500);
        await frames();
        if (interruption !== "unmount") await ready();
        assert.equal(
          await focusToken(),
          before,
          "A later " + interruption + " owns focus after " + action,
        );
        if (interruption === "field")
          assert.equal(await page.locator("#outside-field").inputValue(), "New independent draft");
        if (interruption !== "unmount")
          assert.equal(
            await page.locator(".config-connection-card").count(),
            action === "delete" && ok ? 11 : 12,
          );
        assert.equal(host.writes.length, 1);
        reports.push({ label: "outside-owner", action, ok, interruption });
      }
  for (const action of ["defaults", "delete"]) {
    await mount({ width: 320, height: 240 });
    host.holdWrite = true;
    if (action === "defaults") {
      await submitDefault();
      await defaults().dispatchEvent("submit");
    } else {
      await openDelete();
      await submitDelete();
      await confirm().dispatchEvent("click");
    }
    await until(() => host.pendingWrites.length === 1);
    assert.equal(host.writes.length, 1);
    await finishWrite(undefined, 200);
    await ready();
    const message = "设置已保存，下次运行任务时生效。";
    if (action === "defaults") {
      const status = await singleFeedback(defaults(), message, "status");
      await visible(status, true);
      assert.equal(await status.getAttribute("aria-label"), "默认模型保存结果");
      assert.equal(await text().getAttribute("value"), "owned-11");
      assert.equal(await save().isDisabled(), true);
    } else {
      await confirmation().waitFor({ state: "hidden" });
      await visible(page.getByRole("heading", { name: /^文字模型连接 /, level: 2 }), true);
      await singleFeedback(page.locator(".hub-settings"), message, "status");
      assert.equal(await page.locator(".config-connection-card").count(), 11);
    }
    await page.screenshot({ path: path.join(output, "success-" + action + "-320x240.png") });
    await page.keyboard.press("Tab");
    await visible(page.getByRole("button", { name: "添加连接", exact: true }), true);
    reports.push({ label: "success-and-duplicate", action, writes: host.writes });
  }
  await mount();
  await openDelete("owned-0");
  const replacement = confirmation().getByRole("combobox", { name: "替代默认模型", exact: true });
  assert.equal(await confirm().isDisabled(), true);
  await replacement.selectOption("owned-1");
  host.writeStatus = 500;
  await submitDelete();
  await ready();
  assert.equal(await replacement.inputValue(), "owned-1");
  assert.deepEqual(host.writes[0].body, {
    id: "owned-0",
    replacementText: "owned-1",
    expectedRevision: "0".repeat(64),
  });
  await cancel().click();
  await confirmation().waitFor({ state: "hidden" });
  await visible(card("owned-0").getByRole("button", { name: "删除", exact: true }), true);
  assert.equal(await page.getByRole("alert").count(), 0);
  reports.push({ label: "replacement-failure-and-cancel", writes: host.writes });
  await mount({ single: true });
  host.writeStatus = 200;
  await openDelete("owned-0");
  assert.equal(await confirmation().getByRole("combobox").count(), 0);
  await submitDelete();
  await confirmation().waitFor({ state: "hidden" });
  await frames();
  await visible(page.getByRole("heading", { name: /^文字模型连接 /, level: 2 }), true);
  assert.equal(await page.locator(".config-connection-card").count(), 0);
  reports.push({ label: "last-connection-removal", writes: host.writes });
  for (const [width, height] of [
    [320, 240],
    [390, 360],
  ]) {
    await mount({ width, height });
    await openDelete(longId);
    const header = confirmation().getByRole("heading");
    assert.equal(await header.textContent(), "删除连接 " + longId + "？");
    assert.equal(await header.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    await submitDelete();
    await confirmation().getByRole("alert").waitFor();
    await ready();
    await visible(confirm(), true);
    await singleFeedback(confirmation(), longError);
    assert.deepEqual(host.writes[0].body, {
      id: longId,
      expectedRevision: String(5).padStart(64, "0"),
    });
    await page.screenshot({
      path: path.join(output, "long-name-delete-" + width + "x" + height + ".png"),
    });
    reports.push({ label: "legal-long-connection-name", width, height, writes: host.writes });
  }
  await mount();
  host.writeStatus = 200;
  await chooseModel(defaults().getByRole("button", { name: "默认辅助模型", exact: true }), "");
  await save().focus();
  await page.keyboard.press("Enter");
  await defaults().getByRole("status").waitFor();
  await ready();
  assert.deepEqual(host.writes[0].body, { auxText: null });
  await visible(defaults().getByRole("status", { name: "默认模型保存结果" }), true);
  reports.push({ label: "follow-default-auxiliary-contract", writes: host.writes });
  // A 409 still queues exactly one read; no enable/focus gap while that read is held.
  for (const action of ["defaults", "delete"])
    for (const readStatus of [200, 500]) {
      await mount();
      host.holdWrite = true;
      host.holdRead = true;
      if (action === "defaults") await submitDefault();
      else {
        await openDelete();
        await submitDelete();
      }
      await until(() => host.pendingWrites.length === 1);
      const readCount = host.reads.length;
      await finishWrite(undefined, 409);
      await until(() => host.pendingReads.length === 1);
      await frames();
      assert.equal(
        await defaults()
          .locator("fieldset")
          .evaluate((node) => node.disabled),
        true,
      );
      assert.equal(
        await focusToken(),
        "BODY",
        "Held queued read cannot briefly restore then disable focus",
      );
      if (action === "delete") host.configuration.connections[11].revision = "e".repeat(64);
      await finishReads(readStatus);
      await ready();
      assert.equal(host.reads.length, readCount + 1);
      assert.equal(host.writes.length, 1);
      if (action === "defaults") {
        assert.equal(await text().getAttribute("value"), "owned-11");
        await visible(save(), true);
      } else {
        assert.equal(await page.locator(".config-connection-card").count(), 12);
        await visible(readStatus === 200 ? cancel() : confirm(), true);
        if (readStatus === 200) assert.equal(await confirm().isDisabled(), true);
      }
      assert.equal(await page.getByRole("alert").filter({ hasText: longError }).count(), 1);
      if (readStatus === 500)
        assert.equal(
          await page
            .getByRole("alert")
            .filter({ hasText: "Owned configuration read rejected" })
            .count(),
          1,
        );
      if (action === "delete" && readStatus === 200) {
        await cancel().click();
        await confirmation().waitFor({ state: "hidden" });
        await openDelete();
        host.holdWrite = false;
        await submitDelete();
        await confirmation().getByRole("alert").waitFor();
        await ready();
        assert.equal(host.writes.length, 2);
        assert.deepEqual(host.writes[1].body, { id: "owned-11", expectedRevision: "e".repeat(64) });
        await visible(confirm(), true);
      }
      reports.push({ label: "queued-conflict-read", action, readStatus, writes: host.writes });
    }
  for (const interruption of ["normal", "blank"]) {
    await mount({ width: 320, height: 240 });
    host.holdWrite = true;
    host.holdRead = true;
    await openDelete();
    await submitDelete();
    await until(() => host.pendingWrites.length === 1);
    await finishWrite(undefined, 409);
    await until(() => host.pendingReads.length === 1);
    const before = interruption === "normal" ? null : await interrupt(interruption);
    host.configuration.connections = host.configuration.connections.filter(
      (connection) => connection.id !== "owned-11",
    );
    await finishReads(200);
    await ready();
    await confirmation().waitFor({ state: "hidden" });
    if (interruption === "normal") {
      await visible(page.getByRole("heading", { name: /^文字模型连接 /, level: 2 }), true);
      await singleFeedback(page.locator(".hub-settings"), longError);
      await page.screenshot({ path: path.join(output, "conflict-target-removed-320x240.png") });
    } else assert.equal(await focusToken(), before);
    assert.equal(await page.locator(".config-connection-card").count(), 11);
    assert.equal(host.writes.length, 1);
    reports.push({ label: "conflict-target-deleted-elsewhere", interruption });
  }
  await mount();
  host.holdWrite = true;
  host.holdRead = true;
  await submitDefault();
  await until(() => host.pendingWrites.length === 1);
  await finishWrite(undefined, 409);
  await until(() => host.pendingReads.length === 1);
  const conflictOutside = await interrupt("field");
  await finishReads(200);
  await ready();
  assert.equal(await focusToken(), conflictOutside);
  assert.equal(await page.locator("#outside-field").inputValue(), "New independent draft");
  assert.equal(host.writes.length, 1);
  reports.push({ label: "queued-conflict-read-outside-owner" });
  // A pushed configuration version during a write keeps its original queued-refresh contract.
  await mount();
  host.holdWrite = true;
  host.holdRead = true;
  await submitDefault();
  await until(() => host.pendingWrites.length === 1);
  await page.evaluate(() => window.bumpConfiguration());
  await frames();
  assert.equal(host.pendingReads.length, 0);
  await finishWrite(undefined, 200);
  await until(() => host.pendingReads.length === 1);
  await finishReads(200);
  await ready();
  assert.equal(await text().getAttribute("value"), "owned-11");
  await visible(defaults().getByRole("status"), true);
  assert.equal(await page.evaluate(() => window.changes), 1);
  reports.push({ label: "pushed-version-queues-read" });
  for (const action of ["defaults", "delete"]) {
    await mount();
    host.writeStatus = 401;
    if (action === "defaults") await submitDefault();
    else {
      await openDelete();
      await submitDelete();
    }
    await page.waitForFunction(() => window.authLost === 1);
    await frames();
    assert.equal(host.writes.length, 1);
    assert.equal(await page.getByRole("alert").count(), 0);
    reports.push({ label: "auth-lost-preserved", action });
  }
  await mount();
  await chooseModel(text(), "owned-11");
  host.readStatus = 500;
  await page.locator(".hub-settings-heading > button").click();
  await page.getByRole("alert").waitFor();
  await ready();
  assert.equal(await text().getAttribute("value"), "owned-11");
  assert.equal(host.writes.length, 0);
  reports.push({ label: "read-failure-keeps-draft" });
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ repo, development, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ output, observations: reports.length, errors, blocked }));
}
