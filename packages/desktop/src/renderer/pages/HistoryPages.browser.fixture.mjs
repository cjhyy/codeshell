/* Real-browser history recovery regression; bundles production pages and CSS in memory. */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, _electron } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionsView } from "./sessions/SessionsView";
import { AppShell, AppMainView } from "./app/AppShell";
import { I18nProvider } from "./i18n/I18nProvider";
import { saveUILanguage } from "./uiLanguage";
const root = createRoot(document.getElementById("root"));
let generation = 0;
const sessions = () =>
  Array.from({ length: window.fixture.sessionCount }, (_, index) => ({
    id: index === 0 ? "search" : "session-" + index,
    file: "/fixture/" + index + ".jsonl",
    size: 1024,
    createdAt: 1800000000000,
    updatedAt: 1800000000000 + index,
    title: "Session " + index + " " + "Long English and 中文 title ".repeat(index % 4),
  }));
const request = (kind, payload) =>
  new Promise((resolve, reject) => window.fixture.pending[kind].push({ resolve, reject, payload }));
window.fixture = {
  calls: [],
  pending: { read: [], delete: [], rename: [], open: [] },
  readMode: "ready",
  sessionCount: 120,
  titles: {},
  deleted: [],
  unexpected: [],
  settle(kind, outcome, message = "Owned request rejected " + "directory/".repeat(32)) {
    const queued = this.pending[kind].shift();
    if (!queued) throw new Error("Missing owned " + kind + " request");
    if (outcome === "reject") {
      queued.reject(new Error(message));
      return;
    }
    if (kind === "delete") {
      this.deleted.push(queued.payload);
      queued.resolve();
    } else if (kind === "rename") {
      this.titles[queued.payload.id] = queued.payload.title;
      queued.resolve();
    } else if (kind === "read")
      queued.resolve(sessions().filter((row) => !this.deleted.includes(row.id)));
    else queued.resolve(null);
  },
};
const bridge = {
  listSessions: () => {
    window.fixture.calls.push(["listSessions"]);
    if (window.fixture.readMode === "hold") return request("read");
    if (window.fixture.readMode === "error")
      return Promise.reject(
        new Error(
          "Cannot read session store /fixture/" + "directory/".repeat(32) + "session.jsonl",
        ),
      );
    return Promise.resolve(sessions().filter((row) => !window.fixture.deleted.includes(row.id)));
  },
  listSessionTitles: async () => ({ ...window.fixture.titles }),
  renameSession: (id, title) => {
    window.fixture.calls.push(["renameSession", id, title]);
    return request("rename", { id, title });
  },
  deleteSession: (id) => {
    window.fixture.calls.push(["deleteSession", id]);
    return request("delete", id);
  },

};
window.codeshell = new Proxy(bridge, {
  get(target, key) {
    if (key in target) return target[key];
    window.fixture.unexpected.push(String(key));
    throw new Error("Unexpected native bridge " + String(key));
  },
});
window.renderFixture = (kind, lang, options = {}) => {
  Object.assign(
    window.fixture,
    {
      calls: [],
      pending: { read: [], delete: [], rename: [], open: [] },
      readMode: "ready",
      sessionCount: 120,
      titles: {},
      deleted: [],
    },
    options,
  );
  localStorage.clear();
  saveUILanguage(lang);
  flushSync(() =>
    root.render(
      <I18nProvider key={++generation}>
        <AppShell platformClass="" sidebarCollapsed={true}>
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 overflow-hidden">
              <AppMainView lifecycle={null} searchLayer={null}>
                <SessionsView
                    onNewSession={() => window.fixture.calls.push(["newSession"])}
                    onOpenSession={(id) => {
                      window.fixture.calls.push(["openSession", id]);
                      return request("open", id);
                    }}
                    onSessionRenamed={(id, title) =>
                      window.fixture.calls.push(["renamed", id, title])
                    }
                    onSessionDeleted={(id) => window.fixture.calls.push(["deleted", id])}
                />
              </AppMainView>
            </div>
          </div>
        </AppShell>
      </I18nProvider>,
    ),
  );
};
window.unmountFixture = () => flushSync(() => root.render(null));
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  // Unopened appearance/Markdown modules import media; their assets are irrelevant here.
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--development") ? "development" : "production",
    ),
  },
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

const html =
  '<style>html,body,#root{height:100%;overflow:hidden}</style><div id="root"></div><input aria-label="Outside field" style="position:fixed;bottom:0;right:0;width:70px;z-index:999"><div id="outside" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999"></div>';
const labels = (lang) =>
  lang === "zh"
    ? {
        sessions: "会话管理",
        refresh: "刷新",
        retry: "重试",
        rename: "重命名",
        save: "保存",
        title: "会话标题",
        search: "搜索会话 id 或标题…",
        clear: "清空搜索",
        open: "打开会话",
        opening: "正在打开…",
        confirmDelete: "确认删除",
        cancel: "取消",
        nextPage: "下一页",
        previousPage: "上一页",
        sort: "会话排序",
      }
    : {
        sessions: "Conversations",
        refresh: "Refresh",
        retry: "Retry",
        rename: "Rename",
        save: "Save",
        title: "Session title",
        search: "Search session id or title…",
        clear: "Clear search",
        open: "Open conversation",
        opening: "Opening…",
        confirmDelete: "Confirm deletion",
        cancel: "Cancel",
        nextPage: "Next page",
        previousPage: "Previous page",
        sort: "Sort conversations",
      };
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
const hit = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    );
  });
const ledger = (page, method) =>
  page.evaluate((method) => window.fixture.calls.filter((call) => call[0] === method), method);
async function render(page, kind, lang, options = {}) {
  await page.evaluate(({ kind, lang, options }) => window.renderFixture(kind, lang, options), {
    kind,
    lang,
    options,
  });
  await page.getByRole("heading", { level: 1, name: labels(lang)[kind], exact: true }).waitFor();
  await settle(page);
}
async function inject(page) {
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}
async function sessionRecovery(page, lang) {
  const text = labels(lang);
  await render(page, "sessions", lang, { readMode: "error" });
  await page.getByRole("alert").waitFor();
  const pageRegion = page.getByRole("region", { name: text.sessions, exact: true });
  const retry = page.getByRole("button", { name: text.retry, exact: true });
  await pageRegion.focus();
  await page.keyboard.press("End");
  await page.waitForFunction((label) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent === label,
    );
    const r = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, text.retry);
  assert.equal(await hit(retry), true, "Long error recovery is reachable by keyboard scrolling");
  await page.evaluate(() => (window.fixture.readMode = "hold"));
  await retry.focus();
  const initialReads = (await ledger(page, "listSessions")).length;
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal((await ledger(page, "listSessions")).length, initialReads + 1);
  assert.equal(await focused(retry), true);
  assert.equal(await retry.getAttribute("aria-disabled"), "true");
  await page.evaluate(() => window.fixture.settle("read", "reject"));
  await page.getByRole("alert").waitFor();
  await page.waitForFunction(
    (label) =>
      Array.from(document.querySelectorAll("button"))
        .find((node) => node.textContent === label)
        ?.getAttribute("aria-disabled") === "false",
    text.retry,
  );
  assert.equal(await focused(retry), true, "Rejected read keeps its retry focus");
  await pageRegion.click({ position: { x: 10, y: 10 } });
  await page.mouse.move(100, 120);
  await page.mouse.wheel(0, -5000);
  await page
    .waitForFunction(
      (label) =>
        Array.from(document.querySelectorAll('[role="region"]')).find(
          (node) =>
            node.getAttribute("aria-labelledby") &&
            document.getElementById(node.getAttribute("aria-labelledby"))?.textContent === label,
        ).scrollTop === 0,
      text.sessions,
    )
    .catch(async (error) => {
      console.error(
        "WHEEL RESET",
        await pageRegion.evaluate((node) => ({
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          rect: node.getBoundingClientRect().toJSON(),
          hit: document.elementFromPoint(100, 120)?.outerHTML,
        })),
      );
      throw error;
    });
  const box = await pageRegion.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1200);
  await settle(page);
  assert.equal(await hit(retry), true, "Long error recovery is reachable by a real wheel");
  await page.evaluate(() => (window.fixture.readMode = "ready"));
  await retry.click();
  await page.getByRole("list").waitFor();
  assert.equal(
    await focused(page.getByRole("searchbox")),
    true,
    "Successful retry returns to the surviving search field",
  );
  assert.equal(await hit(page.getByRole("searchbox")), true, "Restored search focus is visible");
  assert.ok(
    (await page.getByRole("list").evaluate((node) => node.clientHeight)) >= 128,
    "Loaded sessions retain a readable scrolling area",
  );
  const search = page.getByRole("searchbox");
  await search.fill("session-119");
  assert.equal(await page.getByRole("listitem").count(), 1);
  assert.ok(
    await page
      .getByRole("listitem")
      .textContent()
      .then((value) => value.includes("session-119")),
  );
  await search.fill("no-matching-record");
  const clear = page
    .getByRole("button", { name: text.clear, exact: true })
    .filter({ hasText: text.clear });
  await clear.click();
  assert.equal(await focused(search), true);
  assert.equal(await page.getByRole("listitem").count(), 50);
  await page.getByRole("button", { name: text.nextPage, exact: true }).click();
  assert.equal(await page.getByRole("listitem").count(), 50);
  await page.getByRole("button", { name: text.nextPage, exact: true }).click();
  assert.equal(await page.getByRole("listitem").count(), 20);
  assert.ok(
    await page
      .getByRole("listitem")
      .last()
      .textContent()
      .then((value) => value.includes("search")),
  );
  await page.getByRole("combobox", { name: text.sort, exact: true }).selectOption("oldest");
  assert.equal(await page.getByRole("listitem").count(), 50);
  const open = page.getByRole("button", { name: text.open, exact: true }).first();
  await open.click();
  const opening = page.getByRole("button", { name: text.opening, exact: true });
  await opening.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await ledger(page, "openSession"), [["openSession", "search"]]);
  await page.evaluate(() => window.fixture.settle("open", "reject", "Owned session open rejected"));
  await page.getByRole("alert").waitFor();
  assert.ok(
    await page
      .getByRole("alert")
      .textContent()
      .then((value) => value.includes("Owned session open rejected")),
  );
  await open.click();
  await page.evaluate(() => window.fixture.settle("open", "resolve"));
  await page.getByRole("alert").waitFor({ state: "hidden" });
  const sessionList = page.getByRole("list");
  await sessionList.hover();
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => {
    const list = document.querySelector("[data-sessions-page]");
    return list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
  });
  const lastRename = page
    .getByRole("listitem")
    .last()
    .getByRole("button", { name: text.rename, exact: true });
  assert.equal(
    await hit(lastRename),
    true,
    "The last session row of a page is reachable with the wheel",
  );
  // Delete another row while the valid session ID "search" still exists.
  const row = page.getByRole("listitem").nth(1);
  const deleteButton = row.getByRole("button").last();
  await deleteButton.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await ledger(page, "deleteSession"), []);
  assert.equal(await focused(row.getByRole("button", { name: text.cancel, exact: true })), true);
  const confirmDelete = row.getByRole("button", { name: text.confirmDelete, exact: true });
  await confirmDelete.click();
  await page.keyboard.press("Enter");
  await settle(page);
  assert.deepEqual(await ledger(page, "deleteSession"), [["deleteSession", "session-1"]]);
  assert.equal(await focused(confirmDelete), true);
  await page.evaluate(() => window.fixture.settle("delete", "reject"));
  await row.getByRole("alert").waitFor();
  const deleteRetry = row.getByRole("button", { name: text.retry, exact: true });
  await deleteRetry.focus();
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal(await focused(deleteRetry), true, "Retry stays mounted while pending");
  await page.evaluate(() => window.fixture.settle("delete", "reject"));
  await row.getByRole("alert").waitFor();
  await settle(page);
  assert.equal(await focused(deleteRetry), true);
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.fixture.settle("delete", "resolve"));
  await page.waitForFunction(() => window.fixture.deleted.includes("session-1"));
  await row.getByRole("alert").waitFor({ state: "hidden" });
  assert.equal(
    await focused(search),
    true,
    "Successful delete focuses search without treating the ID search as a sentinel",
  );
  assert.equal(await hit(search), true, "Delete restoration scrolls search into view");
  assert.deepEqual(await ledger(page, "deleted"), [["deleted", "session-1"]]);
  const rename = page.getByRole("button", { name: text.rename, exact: true }).first();
  await rename.click();
  const draft = page.getByRole("textbox", { name: text.title, exact: true });
  await draft.fill("New draft 中文 preserved");
  const save = draft.locator("..").getByRole("button").last();
  await save.click();
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal((await ledger(page, "renameSession")).length, 1);
  assert.equal(await focused(save), true);
  assert.equal(await draft.getAttribute("readonly"), "");
  await page.evaluate(() => window.fixture.settle("rename", "reject"));
  await page.getByRole("alert").waitFor();
  assert.equal(await draft.inputValue(), "New draft 中文 preserved");
  assert.equal(await focused(draft), true, "Owned save failure returns to the preserved draft");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.fixture.settle("rename", "resolve"));
  await draft.waitFor({ state: "hidden" });
  assert.equal(
    await focused(page.getByRole("button", { name: text.rename, exact: true }).first()),
    true,
  );
}
async function ownership(page) {
  for (const operation of ["refresh", "delete", "rename"])
    for (const owner of ["field", "body"])
      for (const outcome of ["reject", "resolve"]) {
        await render(page, "sessions", "en", { sessionCount: 5 });
        await page.getByRole("listitem").first().waitFor();
        if (operation === "refresh") {
          await page.evaluate(() => (window.fixture.readMode = "hold"));
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
        } else if (operation === "delete") {
          await page.getByRole("listitem").nth(1).getByRole("button").last().click();
          await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Rename", exact: true }).first().click();
          await page
            .getByRole("textbox", { name: "Session title", exact: true })
            .fill("Outside focus draft");
          await page.getByRole("button", { name: "Save", exact: true }).click();
        }
        const field = page.getByRole("textbox", { name: "Outside field" });
        if (owner === "field") await field.focus();
        else await page.locator("#outside").click();
        await page.evaluate(
          ({ operation, outcome }) =>
            window.fixture.settle(operation === "refresh" ? "read" : operation, outcome),
          { operation, outcome },
        );
        await settle(page);
        if (owner === "field")
          assert.equal(
            await focused(field),
            true,
            operation + " " + outcome + " preserves external field focus",
          );
        else
          assert.equal(
            await page.evaluate(() => document.activeElement === document.body),
            true,
            operation + " " + outcome + " preserves external nonfocusable pointer intent",
          );
        if (operation === "rename" && outcome === "reject")
          assert.equal(
            await page.getByRole("textbox", { name: "Session title", exact: true }).inputValue(),
            "Outside focus draft",
          );
      }
  // A stale read may outlive this page without changing the new view or focus.
  await render(page, "sessions", "en", { readMode: "hold" });
  await page.evaluate(() => (window.fixture.savedRead = window.fixture.pending.read[0]));
  await render(page, "sessions", "en", { sessionCount: 3 });
  await page.getByRole("listitem").first().waitFor();
  await page.getByRole("textbox", { name: "Outside field" }).focus();
  await page.evaluate(() =>
    window.fixture.savedRead.resolve([
      {
        id: "old",
        file: "/fixture/old",
        size: 1,
        updatedAt: 1800000000000,
        title: "Old late session",
      },
    ]),
  );
  await settle(page);
  assert.equal(await page.getByRole("listitem").count(), 3);
  assert.equal(await focused(page.getByRole("textbox", { name: "Outside field" })), true);
}
async function states(page, lang) {
  for (const kind of ["sessions"])
    for (const mode of ["hold", "empty", "error"]) {
      await render(page, kind, lang, {
        readMode: mode === "empty" ? "ready" : mode,
        sessionCount: 0,
      });
      if (mode === "error") await page.getByRole("alert").waitFor();
      else await page.getByRole("status").first().waitFor();
      const outer = page.getByRole("region", { name: labels(lang)[kind], exact: true });
      await outer.focus();
      await page.keyboard.press("End");
      await settle(page);
      assert.equal(await focused(outer), true);
      assert.ok(await outer.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    }
}
if (!process.argv.includes("--electron-zoom")) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
  });
  try {
    for (const [width, height] of [
      [1000, 700],
      [800, 480],
      [390, 700],
      [320, 360],
    ])
      for (const lang of ["zh", "en"]) {
        const scheme = width === 800 || width === 320 ? "dark" : "light";
        const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
        page.setDefaultTimeout(5000);
        const errors = [],
          blocked = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          if (route.request().url() === "http://history.test/")
            return route.fulfill({ contentType: "text/html", body: html });
          blocked.push(route.request().url());
          return route.abort();
        });
        await page.goto("http://history.test/");
        await inject(page);
        await page.evaluate(
          (scheme) => document.documentElement.classList.toggle("dark", scheme === "dark"),
          scheme,
        );
        await sessionRecovery(page, lang);
        await states(page, lang);
        if (width === 800 && lang === "en") await ownership(page);
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
        assert.deepEqual(await page.evaluate(() => window.fixture.unexpected), []);
        console.log(
          "PASS " +
            width +
            "x" +
            height +
            "/" +
            lang +
            "/" +
            scheme +
            ": sessions pagination, open/delete recovery, scrolling, drafts and states",
        );
        await page.close();
      }
  } finally {
    await browser.close();
  }
} else {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR || "/tmp", "codeshell-history-focus-"),
  );
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? html : "");
  });
  let app;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const entry = path.join(directory, "main.cjs");
    await writeFile(
      entry,
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',process.env.FIXTURE_USER_DATA);app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>callback({cancel:new URL(details.url).origin!==process.env.FIXTURE_ORIGIN}));const window=new BrowserWindow({width:800,height:480,frame:false,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});window.loadURL(process.env.FIXTURE_ORIGIN);});`,
    );
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 15000,
      env: {
        ...process.env,
        FIXTURE_ORIGIN: origin,
        FIXTURE_USER_DATA: path.join(directory, "user-data"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await inject(page);
    for (const lang of ["zh", "en"])
      for (const zoom of [1, 2]) {
        await app.evaluate(
          ({ BrowserWindow }, zoom) =>
            BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
          zoom,
        );
        await sessionRecovery(page, lang);
        await states(page, lang);
        console.log(
          "PASS Electron/" + lang + "/" + zoom + "x: full history scrolling and recovery",
        );
      }
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.fixture.unexpected), []);
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await new Promise((resolve) => server.close(resolve));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
