/* Production activity pages, navigation and CSS with fixture-owned bridge data. */
/* global document, window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const output = process.env.CODESHELL_ACTIVITY_QA_DIR || "/tmp/codeshell-activity-pages-qa";
await mkdir(output, { recursive: true });
const source = String.raw`
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelTracesView } from "./activity/ModelTracesView";
import { ActivityNavigation } from "./activity/ActivityNavigation";
import { AppMainView } from "./app/AppShell";
import { LogsView } from "./logs/LogsView";
import { ApprovalsView } from "./approvals/ApprovalsView";
import { SessionsView } from "./sessions/SessionsView";
import { RunsView } from "./runs/RunsView";
import { TaskInboxPage } from "./task-inbox/TaskInboxPage";
import { I18nProvider } from "./i18n/I18nProvider";
const root = createRoot(document.getElementById("root"));
window.fixture = { calls: [], logMode: "ready", failApproval: false, copied: "" };
Object.defineProperty(window, "isSecureContext", { value: true });
Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.fixture.copied = text; } } });
const envelope = (id) => ({ sessionId: "original-session", requestId: id, request: { toolName: "Bash", args: { command: "echo " + id, cwd: "/original/project", nested: { value: "完整参数" } }, riskLevel: "medium" } });
const history = Array.from({ length: 75 }, (_, i) => ({ envelope: envelope("history-" + i), at: 1800000000000 + i, decision: i % 2 ? "deny" : "approve", reason: "reason-" + i }));
const sessions = Array.from({ length: 120 }, (_, i) => ({ id: "session-" + i, title: "Session " + i, file: "/fixture/" + i, size: 1024, createdAt: 1800000000000, updatedAt: 1800000000000 + i }));
const run = { runId: "run-original", objective: "Original run", status: "completed", cwd: "/original/project", createdAt: 1800000000000, updatedAt: 1800000000010, startedAt: 1800000000000, finishedAt: 1800000000010, sessionId: "original-session", error: null, summary: "Run completed", model: null, provider: null, durationMs: 10, usage: null, attemptCount: 1, latestCheckpointId: null, latestApprovalId: null, tags: [], metadata: {} };
window.codeshell = {
  modelTraces: { list: async () => ({items:[], total:0}), get: async () => null, getConfig: async () => ({enabled:true,captureContent:false,includeEphemeral:false,retentionDays:7}), setConfig: async (patch) => ({enabled:true,captureContent:false,includeEphemeral:false,retentionDays:7,...patch}) },
  tailLog: async (bucket, limit) => {
    window.fixture.calls.push(["tail", bucket, limit]);
    if (window.fixture.logMode === "error") throw new Error("Owned log failure");
    return Array.from({ length: limit }, (_, i) => bucket + " log " + i + (i % 50 === 0 ? " ERROR" : ""));
  },
  listSessions: async () => sessions, listSessionTitles: async () => ({}),
  renameSession: async () => {}, deleteSession: async () => {},
  getSessionTranscriptPage: async (id, options) => {
    window.fixture.calls.push(["history", id, options.maxBytes]);
    return { items: [{ kind: "user", text: "Historical transcript from original storage" }], loadedBytes: options.maxBytes, hasMore: options.maxBytes < 1048576 };
  },
  listRuns: async () => [run], getRun: async () => ({ ...run, checkpoints: [], artifacts: [], events: [] }),
  taskInbox: { list: async () => ({ version: 1, errors: [], records: [{ schemaVersion: 1, taskKey: "job:1", source: "background-job", sourceId: "1", title: "Original task", status: "done", summary: "Full task summary", artifacts: [], capabilities: ["open"], createdAt: 1800000000000, updatedAt: 1800000000010, sourceRevision: "r1" }] }), onChanged: () => () => {}, act: async () => ({ status: "ok" }) },
};
function App() {
  const [page, setPage] = useState("logs");
  const [queue, setQueue] = useState([envelope("pending")]);
  return <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
    <div className="h-11 shrink-0 border-b px-3 py-3 text-xs">CodeShell</div>
    <AppMainView lifecycle={null} searchLayer={null} navigation={<ActivityNavigation page={page} onNavigate={setPage} taskInboxEnabled={true} />}>
      {page === "traces" ? <ModelTracesView /> : page === "logs" ? <LogsView /> : page === "approvals" ? <ApprovalsView queue={queue} history={history} onDecide={async (env) => {
        window.fixture.calls.push(["decide", env.requestId]);
        if (window.fixture.failApproval) throw new Error("Owned approval failure");
        setQueue([]);
      }} /> : page === "sessions" ? <SessionsView onOpenSession={async id => { window.fixture.calls.push(["open", id]); }} /> : page === "runs" ? <RunsView initialRunId={"run-original"} /> : <TaskInboxPage onOpenTaskInboxRecord={async () => {}} />}
    </AppMainView>
  </div>;
}
window.mount = (lang) => {
  localStorage.setItem("codeshell.uiLanguage", lang);
  document.documentElement.classList.toggle("dark", lang === "en");
  root.render(<I18nProvider key={lang}><App /></I18nProvider>);
};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [];
const cases = [];
try {
  for (const lang of ["zh", "en"]) {
    for (const viewport of [
      { width: 320, height: 360 },
      { width: 390, height: 540 },
      { width: 1280, height: 820 },
    ]) {
      const page = await browser.newPage({ viewport, serviceWorkers: "block" });
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("Activity browser error:", error.message);
      });
      await page.route("**/*", (route) =>
        route.request().url() === "http://codeshell-activity.test/"
          ? route.fulfill({
              contentType: "text/html",
              body: '<style>html,body,#root{height:100%;overflow:hidden}</style><div id="root"></div>',
            })
          : route.abort(),
      );
      await page.goto("http://codeshell-activity.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((lang) => window.mount(lang), lang);
      const nav = page.getByRole("navigation", { name: lang === "zh" ? "活动记录" : "Activity" });
      await nav.waitFor();
      const logPanel = page.getByRole("tabpanel");
      await logPanel.getByText("desktop log 499", { exact: false }).waitFor();
      assert.ok(
        (await logPanel.boundingBox()).height >= 70,
        "Logs retain readable height below activity navigation",
      );
      const latest = page.getByRole("button", {
        name: lang === "zh" ? "跳到最新日志" : "Jump to latest logs",
        exact: true,
      });
      await latest.click();
      assert.ok(
        await logPanel.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight < 2,
        ),
      );
      const search = page.getByRole("searchbox");
      await search.fill(" ERROR ");
      await page
        .getByRole("button", {
          name: lang === "zh" ? "复制显示的日志" : "Copy displayed logs",
          exact: true,
        })
        .click();
      assert.equal((await page.evaluate(() => window.fixture.copied)).split("\n").length, 10);
      await search.fill("");
      await page
        .getByRole("combobox", { name: lang === "zh" ? "读取行数" : "Lines to read" })
        .click();
      await page.getByRole("option", { name: "2000", exact: true }).click();
      await page.waitForFunction(() =>
        window.fixture.calls.some((call) => call[0] === "tail" && call[2] === 2000),
      );
      await page.evaluate(() => {
        window.fixture.logMode = "error";
      });
      await page
        .getByRole("button", { name: lang === "zh" ? "刷新" : "Refresh", exact: true })
        .click();
      await page.getByRole("alert").filter({ hasText: "Owned log failure" }).waitFor();
      assert.ok(
        (await logPanel.textContent()).includes("desktop log 1999"),
        "Failed refresh keeps loaded logs",
      );
      await page.evaluate(() => {
        window.fixture.logMode = "ready";
      });
      await page
        .getByRole("button", { name: lang === "zh" ? "重试读取" : "Retry reading", exact: true })
        .click();
      await page.getByRole("alert").waitFor({ state: "hidden" });

      const routes =
        lang === "zh"
          ? ["执行观测", "后台工作", "会话管理", "审批记录", "诊断日志", "旧版运行记录"]
          : [
              "Execution traces",
              "Background work",
              "Conversations",
              "Approvals",
              "Diagnostic logs",
              "Legacy runs",
            ];
      // Use the actual navigation labels from the translated production tree.
      const navButtons = await nav.getByRole("button").all();
      for (let index = 0; index < navButtons.length; index += 1) {
        const button = navButtons[index];
        const label = await button.textContent();
        await button.click();
        await page
          .getByRole("heading", { level: 1 })
          .filter({ hasText: label ?? "" })
          .waitFor()
          .catch(async (error) => {
            await page.screenshot({ path: path.join(output, "failure.png") });
            throw new Error(error.message + "\n" + (await page.locator("body").innerText()));
          });
        assert.equal(await button.getAttribute("aria-current"), "page");
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          "No horizontal page overflow",
        );
        await page.screenshot({
          path: path.join(output, `${lang}-${viewport.width}-${index}.png`),
        });
        cases.push({ lang, viewport, label });
        if (index === 2) {
          await page
            .getByRole("button", { name: lang === "zh" ? "查看记录" : "View record", exact: true })
            .first()
            .click();
          await page
            .getByText("Historical transcript from original storage", { exact: true })
            .waitFor();
          await page
            .getByRole("button", {
              name: lang === "zh" ? "加载更早记录" : "Load earlier history",
              exact: true,
            })
            .click();
          await page.waitForFunction(() =>
            window.fixture.calls.some((call) => call[0] === "history" && call[2] === 1048576),
          );
          await page
            .getByRole("button", {
              name: lang === "zh" ? "返回会话历史" : "Back to session history",
              exact: true,
            })
            .click();
          assert.ok(
            await page.getByRole("searchbox").evaluate((node) => document.activeElement === node),
            "Returning from read-only history restores keyboard focus",
          );
        }
      }
      assert.equal(routes.length, navButtons.length);
      await nav.getByRole("button").nth(3).click();
      await page
        .getByRole("button", { name: lang === "zh" ? "加载更多" : "Load more", exact: true })
        .click();
      assert.equal(
        await page.locator("[data-approvals-page] section").nth(1).locator("ul > li").count(),
        75,
      );
      await page.evaluate(() => {
        window.fixture.failApproval = true;
      });
      await page
        .getByRole("button", { name: lang === "zh" ? "仅本次批准" : "Approve once", exact: true })
        .click();
      await page.getByRole("alert").filter({ hasText: "Owned approval failure" }).waitFor();
      assert.ok(
        await page
          .getByRole("button", { name: lang === "zh" ? "仅本次批准" : "Approve once", exact: true })
          .isEnabled(),
      );
      await page.evaluate(() => {
        window.fixture.failApproval = false;
      });
      await page
        .getByRole("button", { name: lang === "zh" ? "仅本次批准" : "Approve once", exact: true })
        .click();
      await page
        .getByRole("button", { name: lang === "zh" ? "仅本次批准" : "Approve once", exact: true })
        .waitFor({ state: "hidden" });
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "report.json"), JSON.stringify(cases, null, 2));
  console.log(JSON.stringify({ result: "pass", cases: cases.length, errors, output }));
} finally {
  await browser.close();
}
