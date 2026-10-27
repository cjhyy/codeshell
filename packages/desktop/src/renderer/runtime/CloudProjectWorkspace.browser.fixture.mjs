/* Production CloudProjectWorkspace metadata; isolated bridge and exact-origin network guard. */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium, _electron } = require("playwright");
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const renderer = path.join(sourceDesktop, "src/renderer");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CloudProjectWorkspace } from "./runtime/CloudProjectWorkspace";
import { AppShell, AppMainView } from "./app/AppShell";
import { I18nProvider } from "./i18n/I18nProvider";
import { ToastProvider } from "./ui/ToastProvider";
import { saveUILanguage } from "./uiLanguage";
import { applyTheme } from "./theme";
const noop = () => {};
window.unexpected = [];
window.calls = [];
const bridge = {
  sttAvailable: async () => ({ available: false }),
  listPluginCommands: async () => [],
  onPluginCommandsChanged: () => noop,
  listSkills: async () => [],
  inspectAttachments: async () => [],
  getProjectGitBranches: async () => ({ isRepo: true, current: "main", branches: ["main"] }),
  log: noop,
};
window.codeshell = new Proxy(bridge, {
  get(target, key) {
    if (key in target) return target[key];
    window.unexpected.push(String(key));
    throw new Error("Unexpected native " + String(key));
  },
});
function Fixture(initial) {
  const [options, patch] = React.useReducer(
    (previous, next) => ({ ...previous, ...next }),
    initial,
  );
  const { status = "connected", identity = "short", error = "" } = options;
  window.patchFixture = patch;
  const [draft, setDraft] = React.useState("Draft preserved");
  const binding = {
    id: "owned-binding",
    localProjectId: "local-project",
    origin: "https://owned.invalid",
    environmentId: "owned-environment",
    remoteProjectId: "remote-project",
    environmentName:
      identity === "short"
        ? "Cloud environment"
        : identity === "zh"
          ? "云".repeat(128)
          : "Environment_".repeat(11).slice(0, 128),
    remoteProjectName:
      identity === "short"
        ? "Cloud project"
        : identity === "zh"
          ? "项".repeat(80)
          : "Project_".repeat(10),
    createdAt: 1,
    updatedAt: 1,
  };
  const action = (method) => {
    window.calls.push([method, binding.id, binding.environmentId, binding.remoteProjectId]);
    return Promise.resolve();
  };
  window.fixtureBinding = binding;
  const runtime = {
    binding,
    status: status === "connected-error" ? "connected" : status,
    connectionId: "owned-connection",
    configuration: null,
    sessions: [],
    activeSessionId: "remote-session",
    remoteSessionId: "remote-session",
    state: {
      messages: [
        { kind: "user", id: "human", text: "Review this cloud project." },
        { kind: "assistant", id: "assistant", text: "Earlier output.\n".repeat(40), done: true },
      ],
    },
    busy: false,
    loading: false,
    error,
    draft,
    uploads: [],
    failedSubmissions: options.failedSubmissions || [],
    restoreFailedSubmission: (id) => action("restore:" + id),
    uploading: options.uploading || false,
    pendingApproval: null,
    approvalVersion: 0,
    uncertain: options.uncertain || false,
    historyFailed: options.historyFailed || false,
    model: null,
    setDraft,
    send: (text) => {
      window.calls.push(["send", text, binding.id, binding.environmentId, binding.remoteProjectId]);
      return Promise.resolve();
    },
    stop: () => action("stop"),
    approve: () => action("approve"),
    addFiles: () => action("addFiles"),
    removeUpload: noop,
    setModel: noop,
    refresh: () => action("refresh"),
    reconnect: () => action("reconnect"),
    start: () => action("start"),
  };
  return (
    <AppShell platformClass="" sidebarCollapsed={true}>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          <AppMainView lifecycle={null} searchLayer={null}>
            <CloudProjectWorkspace
              runtime={runtime}
              projects={[]}
              activeProjectId="local-project"
              onSelectProject={noop}
              onAddProject={noop}
            />
          </AppMainView>
        </div>
      </div>
    </AppShell>
  );
}
const root = createRoot(document.getElementById("root"));
let generation = 0;
window.unmountFixture = () => flushSync(() => root.render(null));
window.renderFixture = (options) => {
  localStorage.clear();
  saveUILanguage(options.lang || "en");
  applyTheme(options.mode || "light");
  window.calls = [];
  flushSync(() =>
    root.render(
      <React.StrictMode>
        <I18nProvider key={++generation}>
          <ToastProvider>
            <Fixture {...options} />
          </ToastProvider>
        </I18nProvider>
      </React.StrictMode>,
    ),
  );
};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
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
  '<style>html,body,#root{height:100%;overflow:hidden}</style><div id="root"></div><input aria-label="Outside field" style="position:fixed;top:0;right:0;width:70px;z-index:999"><div id="outside" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999"></div>';
const failure =
  ("Owned connection failed /fixture/" + "directory/".repeat(100)).slice(0, 1014) + "Z";
assert.equal(failure.length, 1015);
const frames = (page) =>
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
const metadata = (page) => page.locator('[data-runtime="cloud"] > [role="region"]');
const text = (lang) =>
  lang === "zh"
    ? {
        region: "云端项目状态",
        start: "启动云端环境",
        signin: "重新登录",
        reconnect: "重新连接",
        reload: "重新加载云端对话",
        username: "用户名",
        send: "发送",
      }
    : {
        region: "Cloud project status",
        start: "Start cloud environment",
        signin: "Sign in again",
        reconnect: "Reconnect",
        reload: "Reload cloud conversation",
        username: "Username",
        send: "Send",
      };
async function render(page, options = {}) {
  await page.evaluate((options) => window.renderFixture(options), {
    mode: page.fixtureMode || "light",
    ...options,
  });
  await page.locator("textarea").waitFor({ state: "attached" });
  await frames(page);
}
async function bounded(page, lang) {
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    page.fixtureMode === "dark",
    "The matrix renders its declared theme",
  );
  const region = metadata(page);
  assert.equal(await region.getAttribute("aria-label"), text(lang).region);
  assert.equal(await region.getAttribute("tabindex"), "0");
  const result = await page.evaluate(() => {
    const root = document.querySelector('[data-runtime="cloud"]'),
      region = root.querySelector(':scope > [role="region"]'),
      chat = root.querySelector("[data-chat-variant]"),
      main = document.querySelector("main");
    return {
      height: root.clientHeight,
      metadata: region.clientHeight,
      chat: chat.clientHeight,
      regionHorizontal: region.scrollWidth > region.clientWidth + 1,
      hiddenAncestors: (() => {
        const clipped = [];
        for (let node = root; node; node = node.parentElement) {
          const style = window.getComputedStyle(node);
          if (
            ((style.overflowY === "hidden" || style.overflowY === "clip") &&
              node.scrollHeight > node.clientHeight + 1) ||
            ((style.overflowX === "hidden" || style.overflowX === "clip") &&
              node.scrollWidth > node.clientWidth + 1)
          )
            clipped.push(node.tagName + ":" + node.className);
        }
        return clipped;
      })(),
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      mainTop: main.scrollTop,
      mainOverflows: main.scrollHeight > main.clientHeight + 1,
      stream: root.querySelector(".cs-chat-transcript")?.parentElement.clientHeight,
    };
  });
  assert.ok(result.metadata <= result.height * 0.4 + 1, "Metadata stays within 40% of the pane");
  assert.ok(
    result.chat >= result.height * 0.6 - 1,
    "The conversation retains at least 60% of the pane",
  );
  assert.ok(result.stream > 0, "Transcript retains a reading area");
  assert.equal(result.regionHorizontal, false);
  assert.deepEqual(
    result.hiddenAncestors,
    [],
    "No hidden ancestor clips overflow from the workspace",
  );
  assert.ok(
    result.documentHeight <= result.viewportHeight + 1,
    "Workspace metadata does not overflow the hidden document",
  );
  assert.equal(result.mainTop, 0);
  assert.equal(result.mainOverflows, false);
  const binding = await page.evaluate(() => window.fixtureBinding);
  assert.equal(
    await region.locator('[role="status"] > span').first().textContent(),
    binding.environmentName + " · " + binding.remoteProjectName,
    "Complete captured cloud identity remains present",
  );
  assert.equal(
    await page.locator('[data-runtime="cloud"]').getAttribute("data-environment-id"),
    binding.environmentId,
  );
  assert.equal(
    await page.locator('[data-runtime="cloud"]').getAttribute("data-remote-project-id"),
    binding.remoteProjectId,
  );
}
async function matrix(page, lang) {
  for (const identity of ["short", "en", "zh"])
    for (const status of [
      "connected",
      "connected-error",
      "project-stopped",
      "auth-required",
      "disconnected",
    ]) {
      await render(page, {
        identity,
        status,
        error: status === "connected-error" || status === "disconnected" ? failure : "",
        lang,
      });
      await bounded(page, lang);
      const region = metadata(page);
      if (identity !== "short")
        assert.deepEqual(
          await page.evaluate(() => [
            window.fixtureBinding.environmentName.length,
            window.fixtureBinding.remoteProjectName.length,
          ]),
          [128, 80],
        );
      if (status === "connected" && identity === "short") {
        assert.ok(await region.evaluate((node) => node.clientHeight <= 50));
        assert.equal(
          await region.evaluate((node) => node.scrollHeight > node.clientHeight + 1),
          false,
          "Normal cloud identity needs no inner scrolling",
        );
      }
      if (status === "connected-error" || status === "disconnected") {
        assert.equal(await region.getByRole("alert").textContent(), failure);
        await region.focus();
        // With only 2px of overflow, the 1px endpoint tolerance can pass
        // halfway through End's native scroll animation. Wait for scrollend
        // before sending a wheel event so the keyboard scroll cannot overtake it.
        const willScroll = await region.evaluate((node) => {
          const willScroll = node.scrollTop < node.scrollHeight - node.clientHeight - 1;
          window.metadataScrollEnded = !willScroll;
          if (willScroll)
            node.addEventListener("scrollend", () => (window.metadataScrollEnded = true), {
              once: true,
            });
          return willScroll;
        });
        await page.keyboard.press("End");
        if (willScroll) await page.waitForFunction(() => window.metadataScrollEnded);
        await page.waitForFunction(() => {
          const node = document.querySelector('[data-runtime="cloud"] > [role="region"]');
          return node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
        });
        assert.equal(await focused(region), true);
        assert.equal(
          await region.getByRole("alert").evaluate((node) => {
            const range = document.createRange();
            range.setStart(node.firstChild, node.textContent.length - 1);
            range.setEnd(node.firstChild, node.textContent.length);
            const r = range.getBoundingClientRect();
            const outer = node.closest('[role="region"]').getBoundingClientRect();
            return r.width > 0 && r.top >= outer.top - 1 && r.bottom <= outer.bottom + 1;
          }),
          true,
          "Last error glyph can be read with native keyboard scrolling",
        );
        if (await region.evaluate((node) => node.scrollHeight > node.clientHeight + 1)) {
          await region.click({ position: { x: 5, y: 5 } });
          await region.hover();
          await page.mouse.wheel(0, -5000);
          await page.waitForFunction(
            () =>
              document.querySelector('[data-runtime="cloud"] > [role="region"]').scrollTop === 0,
          );
          await region.hover();
          await page.mouse.wheel(0, 5000);
          await page.waitForFunction(
            () => document.querySelector('[data-runtime="cloud"] > [role="region"]').scrollTop > 0,
          );
        }
      }
      if (status === "connected" || status === "connected-error") {
        const draft = page.locator("textarea");
        assert.equal(await draft.isDisabled(), false);
        await draft.focus();
        assert.equal(
          await hit(draft),
          true,
          "The enabled restored draft remains visible after focus",
        );
        assert.equal(await draft.inputValue(), "Draft preserved");
        assert.equal(
          await page.locator("main").evaluate((node) => node.scrollTop),
          0,
          "Focusing draft does not shift the app ancestor",
        );
        const send = page.getByRole("button", { name: text(lang).send, exact: true });
        await send.focus();
        assert.equal(
          await hit(send),
          true,
          "Existing Send remains keyboard and pointer reachable in the composer scroller",
        );
        await send.click();
        assert.deepEqual(await page.evaluate(() => window.calls), [
          ["send", "Draft preserved", "owned-binding", "owned-environment", "remote-project"],
        ]);
      }
      const label =
        status === "project-stopped"
          ? text(lang).start
          : status === "disconnected"
            ? text(lang).reconnect
            : null;
      if (label) {
        const action = page.getByRole("button", { name: label, exact: true });
        await action.focus();
        assert.equal(await hit(action), true);
        await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.calls), [
          [
            status === "project-stopped" ? "start" : "reconnect",
            "owned-binding",
            "owned-environment",
            "remote-project",
          ],
        ]);
      }
    }
}
async function recoveryStates(page, lang) {
  await render(page, {
    status: "connected",
    lang,
    failedSubmissions: [
      {
        clientMessageId: "failed-input",
        text: "Preserved rejected request",
        uploads: [{ id: "file", name: "original.txt", mimeType: "text/plain", size: 1 }],
      },
    ],
  });
  await bounded(page, lang);
  assert.equal(await page.locator("textarea").inputValue(), "Draft preserved");
  assert.equal(
    await metadata(page).getByText("Preserved rejected request", { exact: true }).count(),
    1,
  );
  assert.equal(await metadata(page).getByText("original.txt", { exact: true }).count(), 1);
  const restore = page.getByRole("button", {
    name: lang === "zh" ? "添加到输入框" : "Add to composer",
    exact: true,
  });
  await restore.focus();
  assert.equal(await hit(restore), true);
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.calls), [
    ["restore:failed-input", "owned-binding", "owned-environment", "remote-project"],
  ]);
  for (const flags of [
    { historyFailed: true },
    { uncertain: true },
    { uncertain: true, uploading: true },
  ]) {
    await render(page, { identity: "zh", status: "connected", error: failure, lang, ...flags });
    await bounded(page, lang);
    const reload = page.getByRole("button", { name: text(lang).reload, exact: true });
    await reload.focus();
    assert.equal(await hit(reload), true);
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.calls), [
      ["refresh", "owned-binding", "owned-environment", "remote-project"],
    ]);
    assert.equal(
      await page.locator("textarea").isDisabled(),
      true,
      "Existing uncertain/history/upload policy remains enforced",
    );
  }
}
async function resizeAndOwnership(page, lang, nativeResize) {
  const resize = nativeResize || ((size) => page.setViewportSize(size));
  const initial = page.viewportSize() || { width: 800, height: 480 };
  await resize({ width: 1000, height: 700 });
  await render(page, { identity: "zh", status: "project-stopped", lang });
  const start = page.getByRole("button", { name: text(lang).start, exact: true });
  await start.focus();
  await resize({ width: 320, height: 240 });
  await page.waitForFunction((label) => {
    const node = Array.from(document.querySelectorAll("button")).find(
        (node) => node.textContent === label,
      ),
      r = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, text(lang).start);
  assert.equal(await focused(start), true, "Resize preserves the current action");
  assert.equal(await hit(start), true);
  assert.ok((await metadata(page).evaluate((node) => node.scrollTop)) > 0);
  for (const owner of ["field", "body"]) {
    await resize({ width: 1000, height: 700 });
    await render(page, { identity: "zh", status: "project-stopped", lang });
    if (owner === "field") await page.getByRole("textbox", { name: "Outside field" }).focus();
    else await page.locator("#outside").click();
    await resize({ width: 320, height: 240 });
    await frames(page);
    assert.equal(
      await metadata(page).evaluate((node) => node.scrollTop),
      0,
      "Resize does not scroll metadata for an outside owner",
    );
    assert.equal(
      owner === "field"
        ? await focused(page.getByRole("textbox", { name: "Outside field" }))
        : await page.evaluate(() => document.activeElement === document.body),
      true,
    );
  }
  await resize({ width: 1000, height: 700 });
  await render(page, { identity: "zh", status: "auth-required", lang });
  await page.getByRole("button", { name: text(lang).signin, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const username = dialog.getByRole("textbox", { name: text(lang).username, exact: true });
  await username.focus();
  await resize({ width: 320, height: 240 });
  await frames(page);
  assert.equal(
    await focused(username),
    true,
    "Metadata resize does not take focus from its sign-in portal",
  );
  assert.equal(await metadata(page).evaluate((node) => node.scrollTop), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const trigger = page.getByRole("button", { name: text(lang).signin, exact: true });
  assert.equal(await focused(trigger), true);
  assert.equal(
    await hit(trigger),
    true,
    "Portal close makes its existing trigger visible inside metadata",
  );
  // Dynamic metadata can move a focused action while the capped region height remains unchanged.
  await render(page, { identity: "short", status: "project-stopped", lang });
  const source = page.getByRole("button", { name: text(lang).start, exact: true });
  await source.focus();
  await page.evaluate(() =>
    window.patchFixture({ identity: "zh", error: "Changed metadata " + "directory/".repeat(20) }),
  );
  await frames(page);
  assert.equal(await focused(source), true);
  assert.equal(await hit(source), true);
  await resize(initial);
}
async function staleObserver(page, lang) {
  await page.evaluate(() => {
    window.originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.inner = new window.originalResizeObserver((entries) => callback(entries, this));
      }
      observe(node) {
        this.inner.observe(node);
        if (node.matches('[data-runtime="cloud"] > [role="region"]'))
          window.latestMetadataObserver = this;
      }
      unobserve(node) {
        this.inner.unobserve(node);
      }
      disconnect() {
        this.disconnected = true;
        this.inner.disconnect();
      }
    };
  });
  try {
    await render(page, { identity: "zh", status: "project-stopped", lang });
    await page.evaluate(() => {
      window.oldMetadataObserver = window.latestMetadataObserver;
      window.unmountFixture();
    });
    await render(page, { identity: "short", status: "connected", lang });
    const outside = page.getByRole("textbox", { name: "Outside field" });
    await outside.focus();
    await page.evaluate(() => {
      if (!window.oldMetadataObserver.disconnected)
        throw new Error("Metadata observer survived unmount");
      window.oldMetadataObserver.callback([], window.oldMetadataObserver);
    });
    assert.equal(await focused(outside), true);
    assert.equal(await metadata(page).evaluate((node) => node.scrollTop), 0);
  } finally {
    await page.evaluate(() => {
      window.ResizeObserver = window.originalResizeObserver;
    });
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
      [390, 360],
      [320, 240],
    ])
      for (const lang of ["zh", "en"]) {
        const scheme = width === 800 || width === 320 ? "dark" : "light";
        const page = await browser.newPage({
          viewport: { width, height },
          serviceWorkers: "block",
          colorScheme: scheme,
        });
        page.fixtureMode = scheme;
        page.setDefaultTimeout(5000);
        const errors = [],
          blocked = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          if (route.request().url() === "http://cloud-metadata.test/")
            return route.fulfill({ contentType: "text/html", body: html });
          blocked.push(route.request().url());
          return route.abort();
        });
        await page.goto("http://cloud-metadata.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        await page.evaluate(
          (scheme) => document.documentElement.classList.toggle("dark", scheme === "dark"),
          scheme,
        );
        if (!process.argv.includes("--recovery-only")) await matrix(page, lang);
        await recoveryStates(page, lang);
        if (width === 800 && !process.argv.includes("--recovery-only")) {
          await resizeAndOwnership(page, lang);
          await staleObserver(page, lang);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
        assert.deepEqual(await page.evaluate(() => window.unexpected), []);
        console.log(
          "PASS " +
            width +
            "x" +
            height +
            "/" +
            lang +
            "/" +
            scheme +
            (process.argv.includes("--recovery-only")
              ? ": preserved messages/files, recovery actions, bounded chat"
              : ": complete cloud identity/error, bounded chat, keyboard/wheel actions, focus ownership"),
        );
        await page.close();
      }
  } finally {
    await browser.close();
  }
} else {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR || "/tmp", "codeshell-cloud-metadata-"),
  );
  let app;
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? html : "");
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const entry = path.join(directory, "main.cjs");
    await writeFile(
      entry,
      `const {app,BrowserWindow,session}=require('electron');global.blocked=[];app.setPath('userData',process.env.FIXTURE_USER_DATA);app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>{const blocked=new URL(details.url).origin!==process.env.FIXTURE_ORIGIN;if(blocked)global.blocked.push(details.url);callback({cancel:blocked});});const window=new BrowserWindow({width:800,height:480,frame:false,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});window.loadURL(process.env.FIXTURE_ORIGIN);});`,
    );
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 15000,
      env: {
        ...process.env,
        FIXTURE_ORIGIN: origin,
        FIXTURE_USER_DATA: path.join(directory, "data"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: built.outputFiles[0].text });
    const zoom = (value) =>
      app.evaluate(
        ({ BrowserWindow }, value) =>
          BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
        value,
      );
    for (const lang of ["zh", "en"])
      for (const value of [1, 2]) {
        await zoom(value);
        page.fixtureMode = value === 2 ? "dark" : "light";
        await matrix(page, lang);
        await recoveryStates(page, lang);
        if (value === 2)
          await resizeAndOwnership(page, lang, (size) => zoom(size.width >= 800 ? 1 : 2));
        console.log(
          "PASS Electron/" +
            lang +
            "/" +
            value +
            "x: complete metadata, preserved conversation and native zoom focus ownership",
        );
      }
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.unexpected), []);
    assert.deepEqual(await app.evaluate(() => globalThis.blocked), []);
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
