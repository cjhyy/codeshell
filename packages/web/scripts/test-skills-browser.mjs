/** Real Workbench/HubSkills against an owned loopback HTTP controller.
 * Production by default; --development enables StrictMode effect replay.
 * --source-repo PATH bundles the old HubSkills for a deterministic before check.
 * Run with scripts/run-isolated-node-smoke.mjs; no provider or user state is used.
 */
/* global document, window, requestAnimationFrame, innerHeight, innerWidth, getComputedStyle, structuredClone, Event */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const development = process.argv.includes("--development");
const sourceIndex = process.argv.indexOf("--source-repo");
const sourceRepo = sourceIndex < 0 ? null : process.argv[sourceIndex + 1];
const caseIndex = process.argv.indexOf("--case");
const onlyCase = caseIndex < 0 ? null : process.argv[caseIndex + 1];
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-skills-"));
await mkdir(output, { recursive: true });
const source = `
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {Workbench} from './Workbench';
 const noop=()=>{};
 const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'owned',
 chat:{items:[],run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',
 workspaceKey:'owned',title:'Owned conversation',configuration:null,configurationVersion:0,
 sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,
 uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,
 approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,
 newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,
 refreshConfiguration:()=>window.changed++,onAuthLost:()=>window.authLost++};
 function Fixture(){const [mounted,setMounted]=React.useState(true);
 window.mountFixture=()=>setMounted(true);window.unmountFixture=()=>setMounted(false);
 return mounted?<Workbench controller={controller}/>:<input aria-label="Unmounted fixture"/>;}
 window.authLost=0;window.changed=0;
 createRoot(document.getElementById('root')).render(
 ${development ? "<React.StrictMode><Fixture/></React.StrictMode>" : "<Fixture/>"});
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(web, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
  plugins: sourceRepo
    ? [
        {
          name: "owned-before-source",
          setup(builder) {
            builder.onLoad({ filter: /\/HubSkills\.tsx$/ }, async () => ({
              contents: await readFile(
                path.join(sourceRepo, "packages/web/app/HubSkills.tsx"),
                "utf8",
              ),
              loader: "tsx",
              resolveDir: path.join(web, "app"),
            }));
          },
        },
      ]
    : [],
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const content =
  "---\nname: skill-11\ndescription: Owned workflow\n---\n\n" +
  "完整内容 remains unchanged.\n".repeat(30);
const skill = (index) => ({
  name: `skill-${index}`,
  description: `Owned workflow 中文说明 ${index}`,
  source: "project",
  enabled: true,
  editable: true,
  removable: true,
  revision: `revision-${index}`,
  ...(index === 0
    ? {
        origin: {
          kind: "github",
          url: "https://github.com/owned/skills",
          ref: "main",
          commit: "a".repeat(40),
        },
      }
    : {}),
});
const preview = {
  reviewToken: "owned-review",
  expiresAt: Date.now() + 60_000,
  repoUrl: "https://github.com/owned/skills",
  commit: "b".repeat(40),
  skills: [
    {
      name: "imported",
      description: "Owned import",
      pathInRepo: "skills/imported/SKILL.md",
      dirInRepo: "skills/imported",
    },
  ],
};
const updatePreview = {
  changed: true,
  name: "skill-0",
  currentCommit: "a".repeat(40),
  latestCommit: "b".repeat(40),
  reviewToken: "owned-update",
  expiresAt: Date.now() + 60_000,
  content,
  files: [{ path: "SKILL.md", size: content.length }],
};
const requests = [],
  unexpected = [],
  external = [],
  errors = [],
  reports = [];
let skills, hold, held, resolveHeld, rejectNext, refreshFails;
function reset() {
  skills = Array.from({ length: 12 }, (_, index) => skill(index));
  hold = null;
  held = null;
  resolveHeld = null;
  rejectNext = null;
  refreshFails = false;
  requests.length = 0;
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://owned.invalid");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  const body = text ? JSON.parse(text) : undefined;
  const wire = { method: request.method, path: url.pathname, search: url.search, body };
  requests.push(wire);
  const reply = (value, status = 200, type = "application/json") => {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  if (url.pathname === "/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (url.pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (url.pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (url.pathname === "/api/v1/environment") return reply({}, 404);
  if (url.pathname === "/api/v1/skills" && request.method === "GET")
    return refreshFails
      ? reply({ error: "Owned list refresh rejected" }, 503)
      : reply({ skills, directories: ["/owned/.code-shell/skills"] });
  const finish = (status) => {
    if (status)
      return reply({ error: "Owned operation rejected; draft remains unchanged." }, status);
    if (url.pathname === "/api/v1/skills/detail" && request.method === "GET") {
      const name = url.searchParams.get("name");
      const found = skills.find((item) => item.name === name);
      assert.ok(found, `Unknown owned skill ${name}`);
      return reply({ name, content, revision: found.revision, editable: true });
    }
    if (url.pathname === "/api/v1/skills/github/preview" && request.method === "POST")
      return reply(preview);
    if (url.pathname === "/api/v1/skills/github/update-preview" && request.method === "POST")
      return reply(updatePreview);
    if (
      url.pathname === "/api/v1/skills/local" &&
      ["POST", "PUT", "DELETE"].includes(request.method)
    ) {
      if (request.method === "DELETE") skills = skills.filter((item) => item.name !== body.name);
      if (request.method === "POST") skills.push({ ...skill(12), name: body.name });
      return reply({ ok: true, name: body.name, message: "Owned change committed." });
    }
    if (
      ["/api/v1/skills/github/install", "/api/v1/skills/github/update"].includes(url.pathname) &&
      request.method === "POST"
    )
      return reply({ ok: true, name: "imported", message: "Owned reviewed change committed." });
    unexpected.push(wire);
    return reply({}, 404);
  };
  if (hold && hold.path === url.pathname && hold.method === request.method) {
    hold = null;
    held = { response, finish, wire };
    resolveHeld?.();
    return;
  }
  const status = rejectNext;
  rejectNext = null;
  finish(status);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM || (existsSync(macChrome) ? macChrome : undefined),
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(String(error)));
  const search = () => page.getByRole("searchbox", { name: "搜索 Skills", exact: true });
  const create = () => page.getByRole("button", { name: "＋ 创建 Skill", exact: true });
  const panel = () => page.locator(".skills-workspace-panel");
  const heading = () => page.locator("#skills-panel-title");
  const view = (name = "skill-11") =>
    page
      .locator(".skills-card")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .getByRole("button", { name: "查看与编辑", exact: true });
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const active = () =>
    page.evaluate(() => ({
      tag: document.activeElement.tagName,
      label:
        document.activeElement.getAttribute("aria-label") ||
        document.activeElement.textContent.trim(),
      body: document.activeElement === document.body,
    }));
  const geometry = (locator) =>
    locator.evaluate((node) => {
      const box = node.getBoundingClientRect();
      let top = 0,
        bottom = innerHeight,
        left = 0,
        right = innerWidth,
        hidden = 0;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent),
          rect = parent.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || parent.hidden) hidden++;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
      }
      return {
        focused: node === document.activeElement,
        disabled: node.matches(":disabled"),
        hidden,
        visible:
          box.width > 0 &&
          box.height > 0 &&
          box.top >= top - 1 &&
          box.bottom <= bottom + 1 &&
          box.left >= left - 1 &&
          box.right <= right + 1,
        hit: node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        ),
        rect: box.toJSON(),
      };
    });
  async function expectFocus(locator) {
    await frames();
    const box = await geometry(locator);
    assert.equal(box.focused, true, JSON.stringify({ active: await active(), box }));
    assert.equal(box.visible, true, JSON.stringify(box));
    assert.equal(box.hit, true, JSON.stringify(box));
    assert.equal(box.hidden, 0);
    assert.equal(box.disabled, false);
  }
  async function boot(width = 320, height = 360, theme = "dark") {
    reset();
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/?view=settings&section=skills`);
    await view().waitFor();
    await frames();
  }
  function beginHold(path, method = "GET") {
    hold = { path, method };
    return new Promise((resolve) => {
      resolveHeld = resolve;
    });
  }
  async function release(status) {
    assert.ok(held);
    held.finish(status);
    held = null;
    await frames();
  }
  async function openDetail() {
    await view().focus();
    await page.keyboard.press("Enter");
    await panel().waitFor();
    await expectFocus(heading());
    assert.equal(
      await page.getByRole("textbox", { name: "SKILL.md 内容", exact: true }).inputValue(),
      content,
    );
  }
  const record = async (kind, extra = {}) => {
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }));
    assert.ok(bounds.width <= bounds.viewportWidth + 1, JSON.stringify(bounds));
    assert.ok(bounds.height <= bounds.viewportHeight + 1, JSON.stringify(bounds));
    reports.push({
      kind,
      viewport: page.viewportSize(),
      active: await active(),
      bounds,
      ...extra,
      requests: structuredClone(requests),
    });
  };
  if (!onlyCase || onlyCase === "close") {
    for (const [width, height] of [
      [320, 240],
      [390, 360],
      [800, 480],
      [1280, 820],
    ])
      for (const theme of ["light", "dark"]) {
        await boot(width, height, theme);
        await create().focus();
        await page.keyboard.press("Enter");
        await panel().waitFor();
        await expectFocus(heading());
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await panel().waitFor({ state: "hidden" });
        await expectFocus(create());
        await openDetail();
        await page.keyboard.press("Escape");
        await panel().waitFor({ state: "hidden" });
        await expectFocus(view());
        await create().click();
        const name = page.getByRole("textbox", { name: "Skill 名称", exact: true });
        await name.fill("owned-draft");
        await frames();
        await name.focus();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "继续编辑", exact: true }).click();
        await expectFocus(name);
        assert.equal(await name.inputValue(), "owned-draft");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "放弃修改并关闭", exact: true }).click();
        await panel().waitFor({ state: "hidden" });
        await expectFocus(create());
        const bounds = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        }));
        assert.ok(bounds.width <= bounds.viewportWidth + 1, JSON.stringify(bounds));
        assert.ok(bounds.height <= bounds.viewportHeight + 1, JSON.stringify(bounds));
        await record("layout-and-keyboard-close", { theme, bounds });
      }
  }
  if (!onlyCase || onlyCase === "async") {
    for (const [width, height] of [
      [320, 360],
      [1280, 820],
    ])
      for (const owner of ["search", "source", "scope", "blank", "window-blur-event"]) {
        await boot(width, height);
        const pending = beginHold("/api/v1/skills/detail");
        await view().click();
        await pending;
        await page.waitForFunction(
          () =>
            document.querySelector(".skills-progress") && document.activeElement === document.body,
        );
        if (owner === "search") {
          await search().fill("skill-10");
          await search().evaluate((node) => node.scrollIntoView({ block: "center" }));
        }
        if (owner === "scope") {
          await page
            .getByRole("combobox", { name: "Skill 来源", exact: true })
            .selectOption("user");
          await page.getByRole("combobox", { name: "Skill 来源", exact: true }).focus();
        }
        if (owner === "blank") await page.locator(".skills-heading h1").click();
        if (owner === "window-blur-event")
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        const before = await active();
        const beforeSelection =
          owner === "search"
            ? await search().evaluate((node) => [node.selectionStart, node.selectionEnd])
            : null;
        await release();
        await panel().waitFor();
        await frames();
        if (owner === "source") {
          await expectFocus(heading());
          await page.keyboard.press("Escape");
          await panel().waitFor({ state: "hidden" });
          await expectFocus(view());
        } else {
          assert.equal((await geometry(heading())).focused, false);
          if (owner === "search") {
            await expectFocus(search());
            assert.deepEqual(
              await search().evaluate((node) => [node.selectionStart, node.selectionEnd]),
              beforeSelection,
            );
            await page.keyboard.type("-continued");
            assert.equal(await search().inputValue(), "skill-10-continued");
            await page.keyboard.press("Escape");
            await panel().waitFor({ state: "hidden" });
            assert.equal((await geometry(search())).focused, true);
          } else if (owner === "scope")
            await expectFocus(page.getByRole("combobox", { name: "Skill 来源", exact: true }));
          else assert.equal((await active()).body, true);
        }
        await record("async-detail-owner", { owner, before });
      }
  }
  if (!onlyCase || onlyCase === "writes") {
    for (const owner of ["source", "search", "blank", "window-blur-event"])
      for (const outcome of ["success", "reject"]) {
        await boot();
        await openDetail();
        const editor = page.getByRole("textbox", { name: "SKILL.md 内容", exact: true });
        const draft = content + "$literal `draft`\n";
        await editor.fill(draft);
        const pending = beginHold("/api/v1/skills/local", "PUT");
        await page.getByRole("button", { name: "保存修改", exact: true }).click();
        await pending;
        assert.equal(await editor.isDisabled(), true);
        if (owner === "search") await search().fill("skill-10");
        if (owner === "blank") await page.locator(".skills-heading h1").click();
        if (owner === "window-blur-event")
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await release(outcome === "reject" ? 409 : undefined);
        if (outcome === "reject") {
          await page.getByRole("alert").filter({ hasText: "Owned operation rejected" }).waitFor();
          await page.waitForFunction(
            () => !document.querySelector(".skills-editor fieldset").disabled,
          );
          assert.equal(await editor.inputValue(), draft);
          assert.equal(await panel().count(), 1);
        } else {
          await panel().waitFor({ state: "hidden" });
          if (owner === "source") await expectFocus(view());
        }
        if (owner === "search") {
          assert.equal((await geometry(search())).focused, true);
          assert.equal(await search().inputValue(), "skill-10");
        }
        if (["blank", "window-blur-event"].includes(owner))
          assert.equal((await active()).body, true);
        const writes = requests.filter((wire) => wire.method === "PUT");
        assert.deepEqual(
          writes.map((wire) => wire.body),
          [{ name: "skill-11", content: draft, revision: "revision-11" }],
        );
        await record("held-save", { owner, outcome });
      }
    await boot();
    await create().click();
    const name = page.getByRole("textbox", { name: "Skill 名称", exact: true });
    await name.fill("../invalid");
    assert.equal(
      await panel().getByRole("button", { name: "创建 Skill", exact: true }).isDisabled(),
      true,
    );
    assert.equal(requests.filter((wire) => wire.method !== "GET").length, 0);
    await name.fill("owned-created");
    const creation = await page
      .getByRole("textbox", { name: "SKILL.md 内容", exact: true })
      .inputValue();
    await panel().getByRole("button", { name: "创建 Skill", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(create());
    assert.deepEqual(requests.find((wire) => wire.method === "POST").body, {
      name: "owned-created",
      content: creation,
    });
    await record("create-validation-and-wire");
    await boot();
    const card = page.locator(".skills-card").last();
    await card.getByRole("button", { name: "移除", exact: true }).click();
    await expectFocus(heading());
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(search());
    assert.deepEqual(requests.find((wire) => wire.method === "DELETE").body, {
      name: "skill-11",
      revision: "revision-11",
    });
    assert.equal(await page.locator(".skills-card").count(), 11);
    await record("removed-source-search-fallback");
    await boot();
    await create().click();
    const initial = await page
      .getByRole("textbox", { name: "SKILL.md 内容", exact: true })
      .inputValue();
    refreshFails = true;
    await panel().getByRole("button", { name: "创建 Skill", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(create());
    assert.equal(await page.locator(".skills-card").count(), 12);
    assert.equal(await page.getByRole("status").textContent(), "Owned change committed.");
    assert.deepEqual(requests.find((wire) => wire.method === "POST").body, {
      name: "my-skill",
      content: initial,
    });
    await record("committed-write-refresh-failure");
  }
  if (!onlyCase || onlyCase === "preview") {
    await boot();
    const importer = page.getByRole("button", { name: "从 GitHub 导入", exact: true });
    await importer.click();
    await expectFocus(heading());
    const url = panel().getByRole("textbox");
    await url.fill("https://github.com/owned/skills");
    await page.getByRole("button", { name: "预览来源", exact: true }).click();
    await page.getByRole("button", { name: "确认导入到工作区", exact: true }).waitFor();
    await expectFocus(heading());
    await page.getByRole("button", { name: "确认导入到工作区", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(importer);
    assert.deepEqual(
      requests.filter((wire) => wire.method === "POST").map((wire) => wire.body),
      [
        { url: "https://github.com/owned/skills" },
        { reviewToken: "owned-review", pathInRepo: "skills/imported/SKILL.md", name: "imported" },
      ],
    );
    await record("reviewed-import");
    await boot();
    const updater = page
      .locator(".skills-card")
      .first()
      .getByRole("button", { name: "检查更新", exact: true });
    const pending = beginHold("/api/v1/skills/github/update-preview", "POST");
    await updater.click();
    await pending;
    await search().fill("skill-10");
    await release();
    await panel().waitFor();
    assert.equal((await geometry(search())).focused, true);
    assert.equal((await geometry(heading())).focused, false);
    await page.getByRole("button", { name: "确认更新到预览版本", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(search());
    assert.deepEqual(
      requests.filter((wire) => wire.method === "POST").map((wire) => wire.body),
      [{ name: "skill-0", revision: "revision-0" }, { reviewToken: "owned-update" }],
    );
    await record("reviewed-update-owner-and-wire");
  }
  if (!onlyCase || onlyCase === "stale") {
    await boot();
    const pending = beginHold("/api/v1/skills/detail");
    await view().click();
    await pending;
    await page.evaluate(() => window.unmountFixture());
    await page.getByRole("textbox", { name: "Unmounted fixture", exact: true }).focus();
    await release();
    await frames();
    assert.equal(await panel().count(), 0);
    assert.equal((await active()).label, "Unmounted fixture");
    await page.evaluate(() => window.mountFixture());
    await view().waitFor();
    await create().click();
    await expectFocus(heading());
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await panel().waitFor({ state: "hidden" });
    await expectFocus(create());
    await record("unmount-stale-response-and-remount");
    await boot();
    rejectNext = 409;
    await view().click();
    await page.getByRole("alert").filter({ hasText: "Owned operation rejected" }).waitFor();
    assert.equal(await panel().count(), 0);
    await openDetail();
    await record("rejected-detail-explicit-retry");
    await boot();
    rejectNext = 401;
    await view().click();
    await page.waitForFunction(() => window.authLost === 1);
    assert.equal(await panel().count(), 0);
    assert.equal(await page.evaluate(() => window.authLost), 1);
    await record("authentication-loss-contract");
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    JSON.stringify(
      {
        output,
        development,
        sourceRepo,
        observations: reports.length,
        errors,
        external,
        unexpected,
      },
      null,
      2,
    ),
  );
} catch (cause) {
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages())
        await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw cause;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ development, sourceRepo, reports, errors, external, unexpected }, null, 2),
  );
}
