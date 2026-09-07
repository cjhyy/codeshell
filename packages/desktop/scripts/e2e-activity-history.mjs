/* Real files → production IPC → activity pages, with an isolated Electron profile. */
/* global localStorage, window */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
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

  await navigate("打开 会话", "会话历史");
  await win
    .locator("[data-sessions-page]")
    .getByRole("heading", { name: title, exact: true })
    .waitFor();
  await navigate("打开 运行", "运行记录");
  await win
    .getByRole("region", { name: "运行列表", exact: true })
    .getByRole("button", { name: new RegExp(`^${objective}`) })
    .click();
  const detail = win.getByRole("region", { name: "运行详情", exact: true });
  await detail.getByRole("heading", { name: objective, exact: true }).waitFor();
  await detail.getByText(summary, { exact: true }).waitFor();

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
  await navigate("打开 日志", "日志");
  await win.getByRole("tab", { name: "桌面应用", exact: true }).click();
  await win.getByRole("searchbox", { name: "搜索日志内容…", exact: true }).fill(marker);
  await win.getByRole("tabpanel").getByText(marker, { exact: true }).waitFor();
  assert(errors.length === 0, "No renderer exceptions");
  console.log(
    "PASS: real session files, run receipts and desktop logs reach activity pages through production IPC",
  );
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
