/* Real files → production IPC → activity pages, with an isolated Electron profile. */
/* global localStorage, window */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-activity-history-e2e-");
const sessionId = "activity-file-session";
const title = "来自磁盘的活动会话";
const objective = "核对活动记录的真实文件读取";
const summary = "会话、运行结果与桌面日志均已读取。";
const marker = "ACTIVITY-HISTORY-DESKTOP-FILE-OK";
let app;
let win;

async function navigate(label, heading) {
  await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const palette = win.getByRole("dialog", { name: "命令面板", exact: true });
  await palette.waitFor();
  await palette.getByRole("combobox").fill(label);
  await palette.getByRole("option", { name: label, exact: true }).click();
  await palette.waitFor({ state: "hidden" });
  await win.getByRole("heading", { name: heading, level: 1, exact: true }).waitFor();
}

try {
  const sessionDir = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  const now = Date.now();
  await writeFile(
    join(sessionDir, "state.json"),
    JSON.stringify({
      sessionId,
      title,
      cwd: isolated.home,
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: now - 1000,
      archivedAt: now,
    }),
  );
  const clientMessageId = "activity-file-input";
  const events = [
    {
      id: "activity-input",
      type: "message",
      timestamp: now - 1000,
      data: { role: "user", content: objective, clientMessageId },
    },
    {
      id: "activity-result",
      type: "run_result",
      timestamp: now,
      data: {
        clientMessageId,
        result: {
          sessionId,
          reason: "completed",
          text: summary,
          turnCount: 1,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      },
    },
  ];
  await writeFile(
    join(sessionDir, "transcript.jsonl"),
    events.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    join(isolated.codeShellHome, "sessions", "activity-legacy.jsonl"),
    events.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    join(isolated.codeShellHome, "sessions", "activity-export.json"),
    JSON.stringify(events),
  );
  const traces = new ModelTraceStore({
    storageDir: join(isolated.codeShellHome, "sessions", ".model-traces"),
  });
  traces.write({
    version: 1,
    id: "activity-file-model-call",
    traceId: "activity-file-execution",
    sessionId,
    runId: "activity-file-run-1",
    workspacePath: isolated.home,
    source: "fixture",
    purpose: "main",
    provider: "fixture",
    model: "activity-fixture-model",
    startedAt: now - 1000,
    endedAt: now,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: {
      systemPrompt: "Activity fixture system",
      messages: [{ role: "user", content: objective }],
      tools: [],
      parameters: {},
    },
    outputState: "recorded",
    output: { text: summary },
    attempts: [],
  });
  traces.write({
    version: 1,
    id: "activity-file-second-call",
    traceId: "activity-file-second-execution",
    sessionId,
    runId: "activity-file-run-2",
    workspacePath: isolated.home,
    source: "fixture",
    purpose: "main",
    provider: "fixture",
    model: "activity-fixture-model",
    startedAt: now + 100,
    endedAt: now + 200,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: {
      messages: [{ role: "user", content: "同一会话的第二轮 Prompt" }],
    },
    outputState: "recorded",
    output: { text: "第二轮结果" },
    attempts: [],
  });
  // Deliberately omit callType: the Host classifies records written by older versions.
  traces.write({
    version: 1,
    id: "activity-file-summary-call",
    traceId: "activity-file-second-execution",
    sessionId,
    runId: "activity-file-run-2",
    workspacePath: isolated.home,
    source: "fixture",
    purpose: "aux_summary",
    provider: "fixture",
    model: "activity-fixture-model",
    startedAt: now + 50,
    endedAt: now + 60,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: {
      messages: [{ role: "user", content: "归纳同一会话的历史内容" }],
    },
    outputState: "recorded",
    output: { text: "会话摘要结果" },
    attempts: [],
  });
  traces.write({
    version: 1,
    id: "activity-file-panel-call",
    traceId: "activity-file-panel-execution",
    workspacePath: isolated.home,
    source: "panel:video-studio",
    purpose: "tts",
    provider: "fixture",
    model: "activity-panel-fixture-model",
    startedAt: now - 500,
    endedAt: now - 200,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: {
      messages: [{ role: "user", content: "独立 Panel 的实际语音输入" }],
    },
    outputState: "recorded",
    output: { data: { mimeType: "audio/wav", bytes: 1234 } },
    attempts: [],
  });
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: { CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1280, height: 820 });
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "zh");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });

  const sessions = await win.evaluate(() => window.codeshell.listSessions());
  assert(
    sessions.some((item) => item.id === sessionId && item.title === title),
    "IPC reads state.json title",
  );
  const runs = await win.evaluate(async () => ({
    legacy: await window.codeshell.listRuns(),
    activity: await window.codeshell.listRuns({ includeSessions: true }),
  }));
  assert(
    runs.legacy.length === 0,
    "Default run IPC excludes archived Session receipts from legacy importers",
  );
  const receipt = runs.activity.find((item) => item.sessionId === sessionId);
  assert(
    receipt?.objective === objective &&
      receipt.summary === summary &&
      receipt.status === "completed",
    "Opt-in run IPC reads the archived Session receipt",
  );

  await navigate("会话管理", "会话管理");
  await win
    .locator("[data-sessions-page]")
    .getByRole("heading", { name: title, exact: true })
    .waitFor();
  const historyPage = win.locator("[data-sessions-page]");
  const archivedRow = historyPage
    .getByRole("listitem")
    .filter({ has: win.getByRole("heading", { name: title, exact: true }) });
  await archivedRow.getByRole("button", { name: "打开会话", exact: true }).click();
  await win.getByText("只读历史记录", { exact: true }).waitFor();
  await win.getByText(objective, { exact: true }).waitFor();
  await win.getByRole("button", { name: "返回会话历史", exact: true }).click();
  for (const id of ["activity-legacy", "activity-export"]) {
    await historyPage.getByRole("searchbox").fill(id);
    await historyPage.getByRole("button", { name: "查看记录", exact: true }).click();
    await win.getByText("只读历史记录", { exact: true }).waitFor();
    await win.getByText(objective, { exact: true }).waitFor();
    await win.getByRole("button", { name: "返回会话历史", exact: true }).click();
  }
  await historyPage.getByRole("searchbox").fill("");
  await navigate("执行观测", "执行观测");
  const tracePage = win.locator("[data-model-traces-page]");
  const traceSessions = await win.evaluate(() => window.codeshell.modelTraces.sessions());
  const conversation = traceSessions.items.find(
    (item) => item.sessionId === "activity-file-session",
  );
  assert(
    traceSessions.total === 2 && conversation?.callCount === 3 && conversation.traceCount === 2,
    "Production IPC groups all call types into one conversation before pagination",
  );
  assert(
    traceSessions.items.some(
      (item) => !item.sessionId && item.traceId === "activity-file-panel-execution",
    ),
    "Independent Panel inference remains visible without a fabricated session",
  );
  assert(
    [...conversation.callTypes].sort().join(",") === "execution,summary",
    "Old records receive Host-derived types before session aggregation",
  );
  const summaries = await win.evaluate(() =>
    window.codeshell.modelTraces.sessions({ callType: "summary" }),
  );
  assert(
    summaries.total === 1 &&
      summaries.items[0].callCount === 1 &&
      summaries.items[0].traceCount === 1,
    "Type filtering occurs before session counting and paging through production IPC",
  );
  const typeFilter = tracePage.locator("[data-trace-type-filter]");
  await typeFilter.selectOption("summary");
  await tracePage.locator('[data-trace-session="session:activity-file-session"]').click();
  await tracePage.locator('[data-trace-request="activity-file-summary-call"]').waitFor();
  assert(
    (await tracePage.locator("[data-trace-request]").count()) === 1,
    "Only the summary call remains after filtering",
  );
  await typeFilter.selectOption("");
  await tracePage.locator('[data-trace-request="activity-file-second-call"]').waitFor();
  assert(
    (await tracePage.locator("[data-trace-request]").count()) === 3,
    "Clearing the type filter restores every call",
  );
  const sessionRow = tracePage.locator('[data-trace-session="session:activity-file-session"]');
  if (!(await sessionRow.isVisible())) {
    await tracePage.getByRole("button", { name: "返回会话列表", exact: true }).click();
  }
  await sessionRow.getByText(title, { exact: true }).waitFor();
  await sessionRow.click();
  await tracePage.locator('[data-trace-group="activity-file-execution"]').waitFor();
  await tracePage.locator('[data-trace-group="activity-file-second-execution"]').waitFor();
  await tracePage.locator('[data-trace-request="activity-file-second-call"]').waitFor();
  await tracePage.locator('[data-trace-request="activity-file-model-call"]').click();
  const detail = tracePage.locator('[data-trace-detail-id="activity-file-model-call"]');
  await detail.getByText(objective, { exact: true }).waitFor();
  await detail.getByText("运行时输入快照", { exact: true }).waitFor();
  await detail.getByText("用户角色消息 · user", { exact: false }).waitFor();
  await detail.getByRole("button", { name: "输出", exact: true }).click();
  await detail.getByText(summary, { exact: true }).waitFor();
  const panelRow = tracePage.locator('[data-trace-session="trace:activity-file-panel-execution"]');
  if (!(await panelRow.isVisible())) {
    await tracePage.getByRole("button", { name: "返回执行与调用", exact: true }).click();
    await tracePage.getByRole("button", { name: "返回会话列表", exact: true }).click();
  }
  await panelRow.click();
  await tracePage.locator('[data-trace-request="activity-file-panel-call"]').click();
  await tracePage
    .locator('[data-trace-detail-id="activity-file-panel-call"]')
    .getByText("独立 Panel 的实际语音输入", { exact: true })
    .waitFor();
  const config = await win.evaluate(() => window.codeshell.modelTraces.getConfig());
  assert(
    config.captureContent && config.includeEphemeral,
    "Prompt and temporary-call recording default to enabled",
  );
  assert(
    (await win.getByRole("button", { name: "旧版运行记录", exact: true }).count()) === 0,
    "No obsolete activity entrance remains",
  );

  const logDir = join(isolated.codeShellHome, "logs", "desktop");
  await mkdir(logDir, { recursive: true });
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  await appendFile(join(logDir, `desktop-${stamp}.log`), `${marker}\n`);
  const lines = await win.evaluate(() => window.codeshell.tailLog("desktop", 500));
  assert(lines.includes(marker), "IPC reads the desktop logger's nested directory");
  await navigate("诊断日志", "诊断日志");
  await win.getByRole("tab", { name: "桌面应用", exact: true }).click();
  await win.getByRole("searchbox", { name: "搜索日志内容…", exact: true }).fill(marker);
  await win.getByRole("tabpanel").getByText(marker, { exact: true }).waitFor();
  assert(errors.length === 0, "No renderer exceptions");
  console.log(
    "PASS: real sessions group and filter Host-derived call types, preserve Prompt snapshots and standalone Panel media inputs through production IPC",
  );
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
