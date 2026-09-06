/*
 * Real Electron regression for session history, run records, approvals, and logs.
 * All metadata and mutations are synthetic in an isolated profile. Approval
 * responses are intercepted before the worker; no model or tool is invoked.
 * CODESHELL_OPERATIONS_SCREENSHOT_DIR enables optional local preview images.
 */
/* global document, getComputedStyle, localStorage, window */
import { mkdir, writeFile } from "node:fs/promises";
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
const isolated = await makeIsolatedElectronHome("codeshell-operations-e2e-");
const screenshotDir = process.env.CODESHELL_OPERATIONS_SCREENSHOT_DIR;
let app;
let win;

async function screenshot(name) {
  if (screenshotDir)
    await win.screenshot({
      path: join(screenshotDir, name),
      scale: "css",
      animations: "disabled",
    });
}

async function navigate(label, heading) {
  await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const palette = win.getByRole("dialog", { name: "命令面板", exact: true });
  await palette.waitFor();
  await palette.getByRole("combobox").fill(label);
  await palette.getByRole("option", { name: label, exact: true }).click();
  await palette.waitFor({ state: "hidden" });
  await win.getByRole("heading", { name: heading, level: 1, exact: true }).waitFor();
}

async function checkLayouts(id, heading) {
  for (const [width, height, suffix] of [
    [1280, 820, ""],
    [820, 700, "-compact"],
    [390, 700, "-narrow"],
  ]) {
    await win.setViewportSize({ width, height });
    await win.waitForFunction(
      () =>
        document.querySelector('[data-sidebar-action="toggle"]')?.getAttribute("aria-haspopup") ===
        (window.innerWidth < 640 ? "dialog" : null),
    );
    for (const dark of [false, true]) {
      await win.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark);
      const overflow = await win.evaluate(() => {
        const bad = Array.from(document.querySelectorAll("div, section, article, main, ul"))
          .filter((node) => {
            const style = getComputedStyle(node);
            return (
              node.getClientRects().length > 0 &&
              node.clientWidth > 0 &&
              ["auto", "scroll"].includes(style.overflowX) &&
              node.scrollWidth > node.clientWidth + 1
            );
          })
          .map((node) => ({
            role: node.getAttribute("role"),
            className: node.className,
            width: node.clientWidth,
            content: node.scrollWidth,
          }));
        return {
          page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          bad,
        };
      });
      assert(
        !overflow.page && !overflow.bad.length,
        `${id} ${width}px overflow: ${JSON.stringify(overflow)}`,
      );
      const box = await win
        .getByRole("heading", { name: heading, level: 1, exact: true })
        .boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, `${id} heading fits ${width}px`);
      await screenshot(`${id}${suffix}${dark ? "-dark" : ""}.png`);
    }
  }
  await win.setViewportSize({ width: 1280, height: 820 });
  await win.evaluate(() => document.documentElement.classList.remove("dark"));
  console.log(`PASS: ${id} light/dark layouts at 1280, 820, and 390px`);
}

async function seedMetadata() {
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now();
    const fixture = {
      titles: {
        "ui-history-daily": "工作进度与计划",
        "ui-history-long": "项目文档与发布准备",
        "ui-history-notes": "学习笔记",
        "ui-history-delete": "可移除的临时记录",
      },
      sessionsFail: false,
      renameCalls: 0,
      deleteCalls: 0,
      deletionAllowedId: null,
      detailCalls: 0,
      runsFail: false,
      logsFail: false,
      approvals: [],
    };
    globalThis.__operationsFixture = fixture;
    const replace = (channel, fn) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, fn);
    };
    replace("sessions:list", () => {
      if (fixture.sessionsFail) throw new Error("synthetic session list failure");
      return Object.keys(fixture.titles).map((id, index) => ({
        id,
        file: `/fixture/${id}.jsonl`,
        size: 3200 + index * 1840,
        createdAt: now - 86_400_000,
        updatedAt: now - index * 3_600_000,
      }));
    });
    replace("sessions:titles", () => ({ ...fixture.titles }));
    replace("logs:tail", (_event, bucket, limit) => {
      if (limit !== 500) throw new Error("Unexpected log preview limit");
      if (fixture.logsFail) throw new Error("synthetic log read failure");
      if (bucket === "desktop")
        return [
          "[info] 应用已启动，工作区准备就绪。",
          "[info] 已恢复会话与面板状态。",
          "[warn] 服务连接暂不可用，请稍后重试。",
          "[debug] /workspace/" + "release-notes/".repeat(50) + "LOG-TAIL",
        ];
      if (bucket === "engine") return ["[info] 任务引擎已就绪。", "[info] 等待下一条任务。"];
      if (bucket === "ui-ink") return [];
      throw new Error("Unknown fixture log source");
    });
    replace("sessions:rename", (_event, id, title) => {
      fixture.renameCalls += 1;
      if (!Object.hasOwn(fixture.titles, id)) throw new Error("Unexpected non-fixture rename");
      if (fixture.renameCalls === 1) throw new Error("synthetic rename failure");
      fixture.titles[id] = title;
    });
    replace("sessions:delete", (_event, id) => {
      fixture.deleteCalls += 1;
      if (!Object.hasOwn(fixture.titles, id)) throw new Error("Unexpected non-fixture delete");
      if (fixture.deletionAllowedId === id) {
        delete fixture.titles[id];
        return;
      }
      throw new Error("synthetic delete failure");
    });
    const runBase = {
      cwd: "/workspace/产品设计/界面更新",
      preset: "default",
      createdAt: now - 3_600_000,
      updatedAt: now,
      startedAt: now - 3_000_000,
      finishedAt: now,
      sessionId: null,
      error: null,
      summary: "已整理界面改动、验证结果与后续事项。",
    };
    const runs = [
      {
        ...runBase,
        runId: "ui-run-summary",
        objective: "整理界面更新与验证结果",
        status: "completed",
      },
      {
        ...runBase,
        runId: "ui-run-pending",
        objective: "等待确认发布前的文档更新",
        status: "waiting_approval",
        finishedAt: null,
      },
      {
        ...runBase,
        runId: "ui-run-failed",
        objective: "检查外部服务连接",
        status: "failed",
        error: "服务暂时不可用，请稍后重试。",
      },
    ];
    replace("runs:list", () => {
      if (fixture.runsFail) throw new Error("synthetic run list failure");
      return runs;
    });
    replace("runs:get", (_event, id) => {
      fixture.detailCalls += 1;
      if (fixture.detailCalls === 1) throw new Error("synthetic run detail failure");
      const summary = runs.find((run) => run.runId === id);
      return summary
        ? {
            ...summary,
            attemptCount: 1,
            latestCheckpointId: "checkpoint-1",
            latestApprovalId: null,
            tags: [],
            metadata: {},
            checkpoints: [
              {
                checkpointId: "checkpoint-1",
                createdAt: now - 600_000,
                phase: "completed",
                summary: "欢迎页、会话和设置页面已完成检查。",
                nextAction: "整理变更说明与预览",
              },
            ],
            artifacts: ["/workspace/" + "release-notes/".repeat(12) + "ui-review.md"],
            events: [
              { eventId: "event-1", type: "run_created", timestamp: now - 3_600_000, data: {} },
              { eventId: "event-2", type: "run_completed", timestamp: now, data: {} },
            ],
          }
        : null;
    });

    // Intercept only the three synthetic request IDs, forwarding all unrelated
    // application traffic to its original listeners without changing payloads.
    const listeners = ipcMain.listeners("agent:msg");
    ipcMain.removeAllListeners("agent:msg");
    ipcMain.on("agent:msg", (event, line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        /* handled by the original listener */
      }
      if (
        message?.method === "agent/approve" &&
        ["ui-approval-allow", "ui-approval-deny", "ui-approval-pending"].includes(
          message.params?.requestId,
        )
      ) {
        fixture.approvals.push(message.params);
        event.sender.send(
          "agent:msg",
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }),
        );
        return;
      }
      for (const listener of listeners) listener.call(ipcMain, event, line);
    });
  });
}

async function checkSessions() {
  await navigate("打开 会话", "会话历史");
  const page = win.locator("[data-sessions-page]");
  const list = page.getByRole("list", { name: "会话历史", exact: true });
  await list.getByRole("heading", { name: "工作进度与计划", exact: true }).waitFor();
  const row = list.getByRole("listitem").first();
  assert(
    (await row.innerText()).includes("ui-history-daily"),
    "The first fixture is the rename target",
  );
  const rename = row.getByRole("button", { name: "重命名", exact: true });
  await rename.focus();
  await rename.press("Enter");
  const input = row.getByRole("textbox", { name: "会话标题", exact: true });
  await input.waitFor();
  assert(
    await input.evaluate((node) => node === document.activeElement),
    "Session rename receives focus",
  );
  await input.fill("已整理的工作进度");
  for (const key of ["Enter", "Escape"]) {
    await input.dispatchEvent("keydown", { key, isComposing: true, bubbles: true });
    assert(await input.isVisible(), `Composing ${key} preserves the session editor`);
  }
  assert(
    (await app.evaluate(() => globalThis.__operationsFixture.renameCalls)) === 0,
    "Composing Enter does not rename a session",
  );
  await input.press("Enter");
  await row.getByRole("alert").filter({ hasText: "synthetic rename failure" }).waitFor();
  assert((await input.inputValue()) === "已整理的工作进度", "Failed rename preserves the draft");
  assert(
    await input.evaluate((node) => node === document.activeElement),
    "Failed rename returns focus to the draft",
  );
  await row.getByRole("button", { name: "保存", exact: true }).click();
  await row.getByRole("heading", { name: "已整理的工作进度", exact: true }).waitFor();
  assert(
    await rename.evaluate((node) => node === document.activeElement),
    "Successful rename restores the action focus",
  );
  assert(
    (await app.evaluate(() => globalThis.__operationsFixture.renameCalls)) === 2,
    "Rename retry sends exactly one second request",
  );
  await win.getByRole("button", { name: "已整理的工作进度", exact: true }).waitFor();
  const localTitle = await win.evaluate(
    () =>
      JSON.parse(localStorage.getItem("codeshell.sessionIndex.__no_repo__")).sessions.find(
        (session) => session.id === "ui-local-daily",
      )?.title,
  );
  assert(localTitle === "已整理的工作进度", "History rename updates the sidebar's mapped local ID");
  await row.getByRole("button", { name: "删除会话：已整理的工作进度", exact: true }).click();
  await row.getByRole("alert").filter({ hasText: "synthetic delete failure" }).waitFor();
  assert(await row.isVisible(), "Failed deletion retains the session row");
  assert(
    await win.getByRole("button", { name: "已整理的工作进度", exact: true }).isVisible(),
    "Failed deletion preserves the sidebar record",
  );
  await app.evaluate(() => {
    globalThis.__operationsFixture.deletionAllowedId = "ui-history-delete";
  });
  await page.getByRole("button", { name: "删除会话：可移除的临时记录", exact: true }).click();
  await page
    .getByRole("heading", { name: "可移除的临时记录", exact: true })
    .waitFor({ state: "hidden" });
  await win
    .getByRole("button", { name: "可移除的临时记录", exact: true })
    .waitFor({ state: "hidden" });
  const deleted = await win.evaluate(() =>
    JSON.parse(localStorage.getItem("codeshell.sessionIndex.__no_repo__")).sessions.every(
      (session) => session.id !== "ui-local-delete",
    ),
  );
  assert(deleted, "History deletion removes its mapped sidebar record from storage");
  assert(
    (await app.evaluate(() => globalThis.__operationsFixture.deleteCalls)) === 2,
    "History success callbacks never duplicate deletion IPC",
  );

  const search = page.getByRole("searchbox");
  await search.fill("nothing-matches-this-fixture");
  await page.getByRole("heading", { name: "暂无匹配的会话", exact: true }).waitFor();
  await page.getByRole("button", { name: "清空搜索", exact: true }).last().click();
  assert(
    await search.evaluate((node) => node === document.activeElement),
    "Clearing session search restores input focus",
  );
  await app.evaluate(() => {
    globalThis.__operationsFixture.sessionsFail = true;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "synthetic session list failure" }).waitFor();
  assert(
    (await list.getByRole("listitem").count()) === 3,
    "Failed refresh retains readable sessions",
  );
  await app.evaluate(() => {
    globalThis.__operationsFixture.sessionsFail = false;
  });
  await page.getByRole("button", { name: "重试", exact: true }).first().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "synthetic session list failure" })
    .waitFor({ state: "hidden" });
  // Clear the synthetic delete warning by navigating away and reloading this view.
  await navigate("打开 运行", "运行记录");
  await navigate("打开 会话", "会话历史");
  await checkLayouts("sessions", "会话历史");
  await win.getByRole("button", { name: "新会话", exact: true }).click();
  await win.getByRole("heading", { name: "今天想完成什么？", exact: true }).waitFor();
  console.log("PASS: session editing, IME, failed writes, read retry, and focus restoration");
}

async function checkRuns() {
  await navigate("打开 运行", "运行记录");
  const list = win.getByRole("region", { name: "运行列表", exact: true });
  const detail = win.getByRole("region", { name: "运行详情", exact: true });
  const first = list.getByRole("button", { name: /^整理界面更新与验证结果/ });
  await first.focus();
  await first.press("Enter");
  await detail.getByRole("alert").filter({ hasText: "synthetic run detail failure" }).waitFor();
  await detail.getByRole("button", { name: "重试详情", exact: true }).click();
  await detail.getByRole("heading", { name: "整理界面更新与验证结果", exact: true }).waitFor();
  assert(
    await detail.evaluate((node) => node === document.activeElement),
    "Detail retry preserves a stable focus target",
  );
  assert((await first.getAttribute("aria-pressed")) === "true", "Enter selects a run");
  const filter = list.getByRole("combobox", { name: "按运行状态筛选", exact: true });
  await filter.click();
  await win.getByRole("option", { name: "已取消", exact: true }).click();
  await list.getByRole("button", { name: "显示全部运行", exact: true }).click();
  assert(
    await filter.evaluate((node) => node === document.activeElement),
    "Clearing a run filter restores its control focus",
  );
  const pending = list.getByRole("button", { name: /^等待确认发布前的文档更新/ });
  await pending.focus();
  await pending.press("Space");
  await detail.getByRole("heading", { name: "等待确认发布前的文档更新", exact: true }).waitFor();
  assert((await pending.getAttribute("aria-pressed")) === "true", "Space selects a run");
  await app.evaluate(() => {
    globalThis.__operationsFixture.runsFail = true;
  });
  await win.getByRole("button", { name: "刷新", exact: true }).click();
  await win.getByRole("alert").filter({ hasText: "synthetic run list failure" }).waitFor();
  assert(await pending.isVisible(), "Run list survives refresh failure");
  await app.evaluate(() => {
    globalThis.__operationsFixture.runsFail = false;
  });
  await win.getByRole("button", { name: "重试加载", exact: true }).click();
  await win
    .getByRole("alert")
    .filter({ hasText: "synthetic run list failure" })
    .waitFor({ state: "hidden" });
  await first.click();
  await detail.getByRole("heading", { name: "整理界面更新与验证结果", exact: true }).waitFor();
  await checkLayouts("runs", "运行记录");
  console.log("PASS: run selection, filtering, independent retries, and keyboard focus");
}

async function checkApprovals() {
  await navigate("打开 审批", "审批记录");
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("index.html"),
    );
    if (!main) throw new Error("Main renderer was not found for the synthetic approval fixture");
    for (const [requestId, command] of [
      ["ui-approval-allow", "读取项目发布记录"],
      ["ui-approval-deny", "synthetic-preview/".repeat(30) + "REQUEST-TAIL"],
      ["ui-approval-pending", "整理发布前的文档检查结果"],
    ]) {
      main.webContents.send(
        "agent:msg",
        JSON.stringify({
          jsonrpc: "2.0",
          method: "agent/approvalRequest",
          params: {
            requestId,
            request: { toolName: "Bash", args: { command }, riskLevel: "medium" },
          },
        }),
      );
    }
  });
  const pending = win.getByRole("region", { name: /^待批准/ });
  await pending.getByRole("listitem").nth(2).waitFor();
  await pending
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "仅本次批准", exact: true })
    .click();
  await win.getByText("已批准", { exact: true }).waitFor();
  await pending
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "拒绝", exact: true })
    .click();
  await win.getByText("已拒绝", { exact: true }).waitFor();
  const decisions = await app.evaluate(() => globalThis.__operationsFixture.approvals);
  assert(
    decisions.length === 2 &&
      decisions[0].requestId === "ui-approval-allow" &&
      decisions[0].decision.approved === true &&
      decisions[1].requestId === "ui-approval-deny" &&
      decisions[1].decision.approved === false,
    "Only the intended synthetic decisions reached their intercepted transport",
  );
  assert(
    !decisions[0].decision.always && !decisions[0].decision.scope,
    "Approve once does not create a session or project grant",
  );
  assert(
    (await pending.getByRole("listitem").count()) === 1,
    "Each decision removes only its matching request",
  );
  assert(
    (await win.getByLabel("请求内容", { exact: true }).first().innerText()).endsWith(
      "REQUEST-TAIL",
    ),
    "Approval history retains the full long request",
  );
  const rawToggle = pending.getByRole("button", { name: /^(展开|收起)原始参数$/ });
  await rawToggle.focus();
  await rawToggle.press("Enter");
  const raw = pending.getByLabel("原始参数", { exact: true });
  await raw.waitFor();
  assert(
    (await rawToggle.getAttribute("aria-expanded")) === "true",
    "Raw arguments expose their expanded state",
  );
  await rawToggle.press("Tab");
  assert(
    await raw.evaluate((node) => node === document.activeElement),
    "Raw arguments are keyboard reachable",
  );
  assert(
    (await raw.innerText()).includes("整理发布前的文档检查结果"),
    "Raw arguments retain their full request",
  );
  await pending.getByRole("button", { name: "收起原始参数", exact: true }).click();
  await raw.waitFor({ state: "hidden" });
  assert(
    (await app.evaluate(() => globalThis.__operationsFixture.approvals.length)) === 2,
    "Inspecting raw arguments never sends an approval decision",
  );
  await checkLayouts("approvals", "审批记录");
  console.log("PASS: pending approvals, isolated decisions, full history content, and ordering");
}

async function checkLogs() {
  await navigate("打开 日志", "日志");
  const desktop = win.getByRole("tab", { name: "桌面应用", exact: true });
  const engine = win.getByRole("tab", { name: "任务引擎", exact: true });
  const terminal = win.getByRole("tab", { name: "终端界面", exact: true });
  await win
    .getByRole("tabpanel")
    .getByText(/LOG-TAIL/)
    .waitFor();
  await desktop.focus();
  await desktop.press("ArrowRight");
  await win
    .getByRole("tabpanel", { name: "任务引擎", exact: true })
    .getByText(/任务引擎已就绪/)
    .waitFor();
  assert(
    (await engine.getAttribute("aria-selected")) === "true",
    "ArrowRight selects the next log source",
  );
  await engine.press("ArrowRight");
  await win.getByRole("heading", { name: "暂无日志记录", exact: true }).waitFor();
  assert(
    (await terminal.getAttribute("aria-selected")) === "true",
    "An empty source is still the selected tab",
  );
  await terminal.press("Home");
  await win
    .getByRole("tabpanel", { name: "桌面应用", exact: true })
    .getByText(/LOG-TAIL/)
    .waitFor();
  const search = win.getByRole("searchbox", { name: "搜索日志内容…", exact: true });
  await search.fill("WARN");
  await win.getByRole("status").filter({ hasText: "显示 1 / 4 行" }).waitFor();
  assert(
    !(await win.getByRole("tabpanel").innerText()).includes("LOG-TAIL"),
    "Case-insensitive log filtering hides unrelated lines",
  );
  await search.fill("unmatched-log-query");
  await win.getByRole("heading", { name: "没有匹配的日志", exact: true }).waitFor();
  await win.getByRole("button", { name: "清除搜索", exact: true }).last().click();
  assert(
    await search.evaluate((node) => node === document.activeElement),
    "Clearing log search restores its field focus",
  );
  const panel = win.getByRole("tabpanel", { name: "桌面应用", exact: true });
  const wrap = win.getByRole("button", { name: "自动换行", exact: true });
  await wrap.click();
  assert(
    (await wrap.getAttribute("aria-pressed")) === "false",
    "Raw log lines can disable wrapping",
  );
  assert((await panel.innerText()).endsWith("LOG-TAIL"), "Raw log view retains the full long line");
  await wrap.click();
  await app.evaluate(() => {
    globalThis.__operationsFixture.logsFail = true;
  });
  await win.getByRole("button", { name: "刷新", exact: true }).click();
  await win.getByRole("alert").filter({ hasText: "synthetic log read failure" }).waitFor();
  assert(
    (await panel.innerText()).includes("LOG-TAIL"),
    "Read failure keeps previously loaded log content",
  );
  await app.evaluate(() => {
    globalThis.__operationsFixture.logsFail = false;
  });
  await win.getByRole("button", { name: "重试读取", exact: true }).click();
  await win.getByRole("alert").waitFor({ state: "hidden" });
  assert(
    await win
      .getByRole("button", { name: "刷新", exact: true })
      .evaluate((node) => node === document.activeElement),
    "Log retry keeps focus on a persistent control",
  );
  await checkLayouts("logs", "日志");
  console.log(
    "PASS: log source keyboard navigation, filtering, full lines, retry, and responsive layouts",
  );
}

try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
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
  await seedMetadata();
  await win.evaluate(() => {
    const now = Date.now();
    localStorage.setItem(
      "codeshell.sessionIndex.__no_repo__",
      JSON.stringify({
        activeSessionId: null,
        sessions: [
          {
            id: "ui-local-daily",
            engineSessionId: "ui-history-daily",
            title: "工作进度与计划",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "ui-local-delete",
            engineSessionId: "ui-history-delete",
            title: "可移除的临时记录",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
  });
  await win.reload();
  await win.getByRole("button", { name: "工作进度与计划", exact: true }).waitFor();
  await checkSessions();
  await checkRuns();
  await checkApprovals();
  await checkLogs();
  assert(errors.length === 0, "No renderer exceptions");
  console.log("PASS: operations pages and interactions");
} catch (error) {
  if (win) {
    await screenshot("operations-failure.png").catch(() => undefined);
    console.error(
      (
        await win
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-8000),
    );
  }
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
