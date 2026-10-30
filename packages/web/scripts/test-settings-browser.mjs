/* Production Workbench inline editor, owned API, native keyboard/focus and exact writes. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, Event */
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
const out = await mkdtemp(path.join(tmpdir(), "codeshell-web-models-"));
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
const origin = "http://web-models-owned.test";
const startUrl = origin + "/?view=settings&section=models";
const snapshot = () => ({
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: { text: "owned-0" },
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
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const editor = (page) => page.locator(".config-connection-editor");
const model = (page) => editor(page).getByRole("textbox", { name: "模型名称", exact: true });
const add = (page) => page.getByRole("button", { name: "添加连接", exact: true });
const opener = (page) =>
  page
    .locator(".config-connection-card")
    .filter({ has: page.locator("strong", { hasText: /^owned-11$/ }) })
    .getByRole("button", { name: "编辑", exact: true });
const focused = (locator) => locator.evaluate((el) => el === document.activeElement);
async function visibleFocus(locator) {
  const value = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect(),
      hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const hidden = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/hidden|clip/.test(s.overflowY) && p.scrollTop !== 0)
        hidden.push({ tag: p.tagName, scroll: p.scrollTop });
    }
    return {
      focused: el === document.activeElement,
      hit: !!hit && el.contains(hit),
      box: box.toJSON(),
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      hidden,
    };
  });
  assert.equal(value.focused, true, JSON.stringify(value));
  assert.equal(value.hit, true, JSON.stringify(value));
  assert.ok(
    value.box.top >= 0 &&
      value.box.bottom <= value.height + 1 &&
      value.box.left >= 0 &&
      value.box.right <= value.width + 1,
    JSON.stringify(value),
  );
  assert.deepEqual(value.hidden, []);
  assert.ok(
    value.documentWidth <= value.width + 1 && value.documentHeight <= value.height + 1,
    JSON.stringify(value),
  );
}
async function mount(config = { width: 390, height: 360, theme: "light" }, configure = () => {}) {
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    colorScheme: config.theme,
    serviceWorkers: "block",
  });
  const host = { configuration: snapshot(), mode: "reject", calls: [], pending: [] };
  configure(host.configuration);
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.url() === startUrl)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Outside field" style="position:fixed;bottom:0;right:0;width:60px;z-index:999"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999"></div>',
      });
    if (url.origin !== origin) {
      blocked.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/api/v1/environment" && request.method() === "GET")
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (url.pathname === "/api/v1/configuration" && request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(host.configuration),
      });
    if (url.pathname === "/api/v1/configuration/connections" && request.method() === "PUT") {
      const body = request.postDataJSON();
      host.calls.push(body);
      if (host.mode === "hold") {
        host.pending.push({ route, body });
        return;
      }
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Owned save rejected; draft is preserved." }),
      });
    }
    blocked.push(request.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(startUrl);
  for (const file of bundle.outputFiles.filter((f) => f.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text });
  await opener(page).waitFor();
  await frames(page);
  return { page, context, host };
}
async function openExisting(page) {
  await opener(page).focus();
  await page.keyboard.press("Enter");
  await editor(page).waitFor();
  await frames(page);
  await visibleFocus(model(page));
}
async function fillAndHold(page, host) {
  await model(page).fill("owned-edited-draft");
  host.mode = "hold";
  await model(page).press("Enter");
  const deadline = Date.now() + 5000;
  while (host.pending.length === 0) {
    assert.ok(Date.now() < deadline, "Owned write must be issued");
    await frames(page);
  }
  assert.equal(host.calls.length, 1);
  await page.waitForFunction(
    () => document.querySelector(".config-connection-editor fieldset").disabled === true,
  );
  assert.equal(await model(page).isDisabled(), true);
}
async function finish(host, ok, remove = false) {
  const pending = host.pending.shift();
  assert.ok(pending);
  if (ok) {
    host.configuration.connections = remove
      ? host.configuration.connections.filter((c) => c.id !== pending.body.id)
      : host.configuration.connections.map((c) =>
          c.id === pending.body.id
            ? { ...c, model: pending.body.model, revision: "f".repeat(64) }
            : c,
        );
  }
  await pending.route.fulfill({
    status: ok ? 200 : 500,
    contentType: "application/json",
    body: JSON.stringify(ok ? host.configuration : { error: "Owned held save rejected" }),
  });
}
// Cases follow below; every host request is fulfilled locally or denied.
let currentPage;
try {
  for (const [width, height] of [
    [320, 240],
    [320, 360],
    [390, 700],
    [1280, 820],
  ])
    for (const theme of ["light", "dark"]) {
      const { page, context, host } = await mount({ width, height, theme });
      currentPage = page;
      await openExisting(page);
      assert.equal(await model(page).inputValue(), "owned-model-11");
      assert.equal(
        await editor(page).getByRole("textbox", { name: "API Key", exact: true }).inputValue(),
        "",
      );
      await editor(page).getByRole("button", { name: "取消", exact: true }).click();
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(opener(page));
      await add(page).click();
      await editor(page).waitFor();
      await frames(page);
      const name = editor(page).getByRole("textbox", { name: "连接名称", exact: true });
      await visibleFocus(name);
      await name.fill("owned-new-draft");
      await editor(page).getByRole("button", { name: "取消", exact: true }).click();
      const keep = editor(page).getByRole("button", { name: "继续编辑", exact: true });
      await keep.waitFor();
      await frames(page);
      await visibleFocus(keep);
      await keep.click();
      await keep.waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(name);
      assert.equal(await name.inputValue(), "owned-new-draft");
      await editor(page).getByRole("button", { name: "取消", exact: true }).click();
      await editor(page).getByRole("button", { name: "放弃修改", exact: true }).click();
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(add(page));
      await openExisting(page);
      await model(page).fill("owned-edited-draft");
      await model(page).press("Enter");
      await page.getByRole("alert").waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".config-connection-editor fieldset").disabled,
      );
      await frames(page);
      await visibleFocus(model(page));
      assert.equal(await model(page).inputValue(), "owned-edited-draft");
      assert.deepEqual(host.calls, [
        {
          id: "owned-11",
          catalogId: "openai",
          model: "owned-edited-draft",
          expectedRevision: "11".padStart(64, "0"),
        },
      ]);
      assert.equal(await page.evaluate(() => window.authLost), 0);
      await page.screenshot({ path: path.join(out, `editor-${width}x${height}-${theme}.png`) });
      reports.push({ kind: "layout", width, height, theme, wire: host.calls[0] });
      await context.close();
      currentPage = null;
    }
  for (const outcome of [false, true])
    for (const external of ["field", "blank", "blur"]) {
      const { page, context, host } = await mount();
      currentPage = page;
      await openExisting(page);
      await fillAndHold(page, host);
      // A disabled fieldset must never be used to issue a second physical write.
      await editor(page).dispatchEvent("submit");
      await frames(page);
      assert.equal(host.calls.length, 1);
      if (external === "field") await page.locator("#outside-field").focus();
      if (external === "blank") {
        await page.locator("#outside-blank").click();
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      }
      if (external === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await finish(host, outcome);
      if (outcome) await editor(page).waitFor({ state: "hidden" });
      else {
        await page.getByRole("alert").waitFor();
        await page.waitForFunction(
          () => !document.querySelector(".config-connection-editor fieldset").disabled,
        );
      }
      await frames(page);
      if (external === "field") assert.equal(await focused(page.locator("#outside-field")), true);
      else assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      if (!outcome) assert.equal(await model(page).inputValue(), "owned-edited-draft");
      reports.push({ kind: "outside-owner", outcome, external });
      await context.close();
      currentPage = null;
    }
  for (const remove of [false, true]) {
    const { page, context, host } = await mount();
    currentPage = page;
    await openExisting(page);
    await fillAndHold(page, host);
    await finish(host, true, remove);
    await editor(page).waitFor({ state: "hidden" });
    await frames(page);
    await visibleFocus(remove ? add(page) : opener(page));
    reports.push({ kind: "success-return", remove });
    await context.close();
    currentPage = null;
  }
  {
    const { page, context, host } = await mount();
    currentPage = page;
    await openExisting(page);
    await model(page).fill("owned-unsaved-before-refresh");
    host.configuration.connections = host.configuration.connections.map((c) =>
      c.id === "owned-11" ? { ...c, revision: "e".repeat(64), model: "owned-new-server-model" } : c,
    );
    await page.evaluate(() => window.refreshConfigurationFixture());
    await editor(page)
      .getByText("其他设备已更新这个连接。你的草稿已保留，请检查最新设置后再保存。", {
        exact: true,
      })
      .waitFor();
    assert.equal(await model(page).inputValue(), "owned-unsaved-before-refresh");
    assert.equal(
      await editor(page).getByRole("button", { name: "保存连接", exact: true }).isDisabled(),
      true,
    );
    assert.equal(host.calls.length, 0);
    await page.locator("#outside-field").focus();
    await frames(page);
    assert.equal(await focused(page.locator("#outside-field")), true);
    reports.push({ kind: "stale-revision-draft" });
    await context.close();
    currentPage = null;
  }
  {
    const { page, context, host } = await mount();
    currentPage = page;
    await openExisting(page);
    await fillAndHold(page, host);
    await page.evaluate(() => window.unmountFixture());
    await editor(page).waitFor({ state: "hidden" });
    await page.locator("#outside-field").focus();
    await finish(host, false);
    await frames(page);
    assert.equal(await focused(page.locator("#outside-field")), true);
    reports.push({ kind: "unmount" });
    await context.close();
    currentPage = null;
  }
  {
    const { page, context, host } = await mount(
      { width: 390, height: 844, theme: "light" },
      (configuration) => {
        configuration.catalog[0].modelPresets = [
          {
            value: "owned-model-11",
            label: "Owned preset",
            parameters: [
              {
                name: "reasoning",
                label: "思考强度",
                control: "enum",
                options: ["low", "high"],
                default: "low",
              },
              { name: "temperature", label: "Temperature", control: "number", min: 0, max: 1 },
              { name: "thinking_type", label: "思考开关", control: "toggle" },
            ],
          },
        ];
        configuration.connections[11].paramValues = {
          reasoning: "high",
          temperature: 0.5,
          thinking_type: true,
        };
      },
    );
    currentPage = page;
    await openExisting(page);
    assert.equal(
      await editor(page).getByRole("combobox", { name: "思考强度", exact: true }).inputValue(),
      "high",
    );
    assert.equal(
      await editor(page).getByRole("spinbutton", { name: "Temperature", exact: true }).inputValue(),
      "0.5",
    );
    assert.equal(
      await editor(page).getByRole("combobox", { name: "思考开关", exact: true }).inputValue(),
      "true",
    );
    assert.equal(host.calls.length, 0);
    host.configuration.connections[11].revision = "f".repeat(64);
    host.configuration.connections[11].paramValues.reasoning = "low";
    await page.evaluate(() => window.refreshConfigurationFixture());
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".config-connection-editor select")].some(
        (select) => select.value === "low",
      ),
    );
    assert.equal(
      await editor(page).getByRole("combobox", { name: "思考强度", exact: true }).inputValue(),
      "low",
      "a pristine editor follows the new CAS revision's parameter values",
    );
    assert.equal(host.calls.length, 0);
    await editor(page).getByRole("button", { name: "选择服务商模型" }).click();
    await page
      .getByRole("dialog", { name: "选择服务商模型" })
      .getByRole("searchbox")
      .fill("Owned preset");
    await page.keyboard.press("Enter");
    assert.equal(host.calls.length, 0, "search Enter never submits the model connection form");
    await page.keyboard.press("Escape");
    await editor(page)
      .getByRole("combobox", { name: "思考强度", exact: true })
      .selectOption("high");
    await editor(page).getByRole("button", { name: "保存连接", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(host.calls.length, 1);
    assert.deepEqual(host.calls[0].paramValues, { reasoning: "high" });
    assert.equal(host.calls[0].apiKey, undefined);
    assert.equal(
      host.calls[0].baseUrl,
      undefined,
      "parameter edits do not echo a sanitized endpoint",
    );
    assert.equal(host.calls[0].expectedRevision, host.configuration.connections[11].revision);
    assert.equal(
      await editor(page).getByRole("combobox", { name: "思考强度", exact: true }).inputValue(),
      "high",
    );
    reports.push({ kind: "declared-parameters-explicit-save" });
    await context.close();
    currentPage = null;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  console.error(JSON.stringify({ out, error: String(error) }));
  if (currentPage)
    await currentPage.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
console.log(
  JSON.stringify({
    result: "pass",
    layouts: reports.filter((r) => r.kind === "layout").length,
    behaviors: reports.filter((r) => r.kind !== "layout").length,
    out,
  }),
);
