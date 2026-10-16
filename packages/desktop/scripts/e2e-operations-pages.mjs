/*
 * Real Electron regression for conversation management, execution traces, approvals, and diagnostic logs.
 * All metadata and mutations are synthetic in an isolated profile. Approval
 * responses are intercepted before the worker; no model or tool is invoked.
 * CODESHELL_OPERATIONS_SCREENSHOT_DIR enables optional local preview images.
 */
/* global document, getComputedStyle, window */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-operations-e2e-");
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
await mkdir(isolated.codeShellHome, { recursive: true });
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: "http://127.0.0.1:9",
  guardModule: new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
const applicationImport = `await import(${JSON.stringify(pathToFileURL(join(appDir, "out/main/index.mjs")).href)});`;
const bootstrap = await readFile(fixture.mainEntry, "utf8");
assert(
  bootstrap.includes(applicationImport),
  "Owned fixture main entry contains its production import",
);
await writeFile(
  fixture.mainEntry,
  bootstrap.replace(
    applicationImport,
    `const { createModelTraceHistory } = await import(${JSON.stringify(import.meta.resolve("@cjhyy/code-shell-server/storage"))});
globalThis.__operationsTraceHistory = createModelTraceHistory({ storageDir: ${JSON.stringify(join(isolated.codeShellHome, "sessions", ".model-traces"))} });
${applicationImport}`,
  ),
);
const screenshotDir =
  process.env.CODESHELL_OPERATIONS_SCREENSHOT_DIR ||
  (await mkdtemp(join(tmpdir(), "codeshell-current-operations-evidence-")));
let app;
let win;
const traceKeyboardReachability = [];
let traceDetailRetryFocus;

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
      if (id === "execution-traces") {
        const strip = win.getByRole("group", { name: "按类型查看", exact: true });
        const last = strip.getByRole("button").last();
        await win.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
            ),
        );
        await strip.getByRole("button").first().focus();
        for (let index = 1; index < (await strip.getByRole("button").count()); index++)
          await win.keyboard.press("Tab");
        await win.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
            ),
        );
        const keyboardReach = await last.evaluate((node) => {
          const button = node.getBoundingClientRect(),
            group = node.parentElement.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          return {
            focused: document.activeElement === node,
            active: document.activeElement?.textContent,
            button: button.toJSON(),
            group: group.toJSON(),
            text: range.getBoundingClientRect().toJSON(),
            scroll: node.parentElement.scrollLeft,
            centerVisible: node.contains(
              document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2),
            ),
          };
        });
        traceKeyboardReachability.push({ width, dark, ...keyboardReach });
        assert(
          keyboardReach.focused &&
            keyboardReach.centerVisible &&
            keyboardReach.text.left >= keyboardReach.group.left - 1 &&
            keyboardReach.text.right <= keyboardReach.group.right + 1,
          `The intentionally horizontal call-type strip keeps its final button keyboard reachable: ${JSON.stringify({ width, dark, ...keyboardReach })}`,
        );
      }
      const overflow = await win.evaluate(() => {
        const bad = Array.from(document.querySelectorAll("div, section, article, main, ul"))
          .filter((node) => {
            const style = getComputedStyle(node);
            return (
              node.getClientRects().length > 0 &&
              // The call-type chip strip intentionally scrolls horizontally;
              // its keyboard reachability is verified separately above.
              node.getAttribute("aria-label") !== "按类型查看" &&
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
  await app.evaluate(async ({ ipcMain }) => {
    const history = globalThis.__operationsTraceHistory;
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
      tracesFail: false,
      callsFail: false,
      detailFail: false,
      traceQueries: [],
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
    replace("modelTraces:sessions", (_event, query) => {
      fixture.traceQueries.push(["sessions", query]);
      if (fixture.tracesFail) throw new Error("synthetic trace list failure");
      return history.sessions(query);
    });
    replace("modelTraces:list", (_event, query) => {
      fixture.traceQueries.push(["list", query]);
      if (fixture.callsFail) throw new Error("synthetic trace calls failure");
      return history.list(query);
    });
    replace("modelTraces:get", (_event, id) => {
      fixture.detailCalls++;
      if (fixture.detailFail && id === "ui-trace-summary") {
        fixture.detailFail = false;
        throw new Error("synthetic trace detail failure");
      }
      return history.get(id);
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
  await navigate("会话管理", "会话管理");
  const page = win.locator("[data-sessions-page]");
  const list = page.getByRole("list", { name: "会话管理", exact: true });
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
  await win
    .getByRole("region", { name: "导航", exact: true })
    .getByRole("button", { name: "已整理的工作进度", exact: true })
    .waitFor();
  const localTitle = await win.evaluate(
    async () =>
      (await window.codeshell.sessionCatalog.load()).indices.__no_repo__.sessions.find(
        (session) => session.id === "ui-local-daily",
      )?.title,
  );
  assert(localTitle === "已整理的工作进度", "History rename updates the sidebar's mapped local ID");
  await row.getByRole("button", { name: "删除会话：已整理的工作进度", exact: true }).click();
  await row.getByRole("button", { name: "取消", exact: true }).click();
  assert(
    (await app.evaluate(() => globalThis.__operationsFixture.deleteCalls)) === 0,
    "Cancelling deletion sends no IPC",
  );
  await row.getByRole("button", { name: "删除会话：已整理的工作进度", exact: true }).click();
  await row.getByRole("button", { name: "确认删除", exact: true }).click();
  await row.getByRole("alert").filter({ hasText: "synthetic delete failure" }).waitFor();
  assert(await row.isVisible(), "Failed deletion retains the session row");
  assert(
    await win
      .getByRole("region", { name: "导航", exact: true })
      .getByRole("button", { name: "已整理的工作进度", exact: true })
      .isVisible(),
    "Failed deletion preserves the sidebar record",
  );
  await row.getByRole("button", { name: "取消", exact: true }).click();
  await app.evaluate(() => {
    globalThis.__operationsFixture.deletionAllowedId = "ui-history-delete";
  });
  await page.getByRole("button", { name: "删除会话：可移除的临时记录", exact: true }).click();
  await list
    .getByRole("listitem")
    .filter({ hasText: "ui-history-delete" })
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "可移除的临时记录", exact: true })
    .waitFor({ state: "hidden" });
  await win
    .getByRole("region", { name: "导航", exact: true })
    .getByRole("button", { name: "可移除的临时记录", exact: true })
    .waitFor({ state: "hidden" });
  const deleted = await win.evaluate(async () =>
    (await window.codeshell.sessionCatalog.load()).indices.__no_repo__.sessions.every(
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
  await navigate("执行观测", "执行观测");
  await navigate("会话管理", "会话管理");
  await checkLayouts("sessions", "会话管理");
  await win.getByRole("button", { name: "新会话", exact: true }).click();
  await win.getByRole("heading", { name: "今天想完成什么？", exact: true }).waitFor();
  console.log("PASS: session editing, IME, failed writes, read retry, and focus restoration");
}

async function checkTraces() {
  await app.evaluate(() => {
    globalThis.__operationsFixture.detailFail = true;
  });
  await win.setViewportSize({ width: 1440, height: 900 });
  await navigate("执行观测", "执行观测");
  const page = win.locator("[data-model-traces-page]");
  const list = page.getByRole("region", { name: "会话与独立调用", exact: true });
  const tree = page.getByRole("region", { name: "会话内执行与调用", exact: true });
  const detail = page.getByRole("region", { name: "调用详情", exact: true });
  const firstSession = page.locator('[data-trace-session="session:ui-history-daily"]');
  await firstSession.focus();
  await firstSession.press("Enter");
  const first = page.locator('[data-trace-request="ui-trace-summary"]');
  await first.focus();
  await first.press("Enter");
  await detail.getByRole("alert").filter({ hasText: "synthetic trace detail failure" }).waitFor();
  await detail.getByRole("button", { name: "重试", exact: true }).click();
  await page.locator('[data-trace-detail-id="ui-trace-summary"]').waitFor();
  await detail.getByText("整理界面更新与验证结果", { exact: true }).waitFor();
  traceDetailRetryFocus = await detail
    .getByRole("heading", { name: "调用详情", exact: true })
    .evaluate(
      (node) =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() =>
            resolve({
              focused: node === document.activeElement,
              activeTag: document.activeElement?.tagName,
              activeText: document.activeElement?.textContent?.slice(0, 100),
            }),
          ),
        ),
    );
  assert(
    traceDetailRetryFocus.focused,
    `Trace detail retry preserves a stable focus target after its button unmounts: ${JSON.stringify(traceDetailRetryFocus)}`,
  );
  assert((await first.getAttribute("aria-pressed")) === "true", "Enter selects the model call");
  const filter = page.getByRole("combobox", { name: "状态", exact: true });
  await filter.selectOption("cancelled");
  await list.getByText("没有符合筛选条件的调用", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "搜索模型、用途、来源或编号", exact: true });
  assert(
    await search.evaluate((node) => node === document.activeElement),
    "Clearing trace filters restores search focus",
  );
  await filter.selectOption("failed");
  await page.locator('[data-trace-session="session:ui-history-notes"]').waitFor();
  assert(
    (await list.locator("[data-trace-session]").count()) === 1,
    "Status filtering uses the real trace store",
  );
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  const pendingSession = page.locator('[data-trace-session="session:ui-history-long"]');
  await pendingSession.focus();
  await pendingSession.press("Space");
  const pending = tree.locator('[data-trace-request="ui-trace-pending"]');
  await pending.focus();
  await pending.press("Space");
  await page.locator('[data-trace-detail-id="ui-trace-pending"]').waitFor();
  assert((await pending.getAttribute("aria-pressed")) === "true", "Space selects a model call");
  await app.evaluate(() => {
    globalThis.__operationsFixture.tracesFail = true;
  });
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await list.getByRole("alert").filter({ hasText: "synthetic trace list failure" }).waitFor();
  assert(await pendingSession.isVisible(), "Trace sessions survive refresh failure");
  await app.evaluate(() => {
    globalThis.__operationsFixture.tracesFail = false;
    globalThis.__operationsFixture.callsFail = true;
  });
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await tree.getByRole("alert").filter({ hasText: "synthetic trace calls failure" }).waitFor();
  assert(await pending.isVisible(), "Trace calls survive refresh failure");
  await app.evaluate(() => {
    globalThis.__operationsFixture.callsFail = false;
  });
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await firstSession.click();
  await first.click();
  await page.locator('[data-trace-detail-id="ui-trace-summary"]').waitFor();
  await checkLayouts("execution-traces", "执行观测");
  // At phone width the current detail uses the real step-based back controls.
  await win.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "返回执行与调用", exact: true }).click();
  await tree.getByRole("heading", { name: "会话内执行与调用", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await firstSession.waitFor();
  await win.setViewportSize({ width: 1280, height: 820 });
  console.log(
    "PASS: real trace store → sessions/calls/details, keyboard selection, status/empty filters, independent list/calls/detail retry, and 390px navigation",
  );
}

async function checkApprovals() {
  await navigate("审批记录", "审批记录");
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
  await win.locator("span").getByText("已批准", { exact: true }).waitFor();
  await pending
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "拒绝", exact: true })
    .click();
  await win.locator("span").getByText("已拒绝", { exact: true }).waitFor();
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
  await navigate("诊断日志", "诊断日志");
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
  await checkLayouts("logs", "诊断日志");
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
    mainEntry: fixture.mainEntry,
    env: fixture.env,
  });
  Object.assign(
    process.env,
    Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => value !== undefined)),
  );
  for (const key of Object.keys(process.env))
    if (fixture.env[key] === undefined && Object.hasOwn(fixture.env, key)) delete process.env[key];
  await import("./runtime-cost-gui-guard.mjs");
  const { ModelTraceStore } = await import("@cjhyy/code-shell-core/internal");
  const traces = new ModelTraceStore({
    storageDir: join(isolated.codeShellHome, "sessions", ".model-traces"),
  });
  const startedAt = Date.now();
  for (const [id, sessionId, objective, status] of [
    ["summary", "ui-history-daily", "整理界面更新与验证结果", "completed"],
    ["pending", "ui-history-long", "等待确认发布前的文档更新", "running"],
    ["failed", "ui-history-notes", "检查外部服务连接", "failed"],
  ])
    traces.write({
      version: 1,
      id: "ui-trace-" + id,
      traceId: "ui-execution-" + id,
      sessionId,
      runId: "ui-run-" + id,
      workspacePath: isolated.home,
      source: "fixture",
      purpose: "main",
      callType: "execution",
      provider: "fixture",
      model: "fixture-" + id,
      startedAt: startedAt - (id === "summary" ? 0 : 1000),
      endedAt: status === "running" ? undefined : startedAt + 10,
      status,
      stream: false,
      inputState: "recorded",
      input: { messages: [{ role: "user", content: objective }] },
      outputState: "recorded",
      output: { text: "已整理界面改动、验证结果与后续事项。" },
      error: status === "failed" ? "Owned synthetic provider failure" : undefined,
      attempts: [],
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
  const fixtureNow = Date.now();
  await seedSessionCatalog(win, {
    __no_repo__: {
      activeSessionId: null,
      sessions: [
        {
          id: "ui-local-daily",
          engineSessionId: "ui-history-daily",
          title: "工作进度与计划",
          createdAt: fixtureNow,
          updatedAt: fixtureNow,
        },
        {
          id: "ui-local-delete",
          engineSessionId: "ui-history-delete",
          title: "可移除的临时记录",
          createdAt: fixtureNow,
          updatedAt: fixtureNow,
        },
      ],
    },
  });
  await win.reload();
  await win.getByRole("button", { name: "工作进度与计划", exact: true }).waitFor();
  await checkSessions();
  await checkTraces();
  await checkApprovals();
  await checkLogs();
  assert(errors.length === 0, "No renderer exceptions");
  const guard = (await readFile(fixture.env.CODESHELL_COST_GUI_GUARD_LOG, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    guard.some((receipt) => receipt.pid === app.process().pid && receipt.negativeProbes === 7),
    "Actual Electron main process carries the deny-all HTTP guard",
  );
  if (screenshotDir)
    await writeFile(
      join(screenshotDir, "acceptance.json"),
      JSON.stringify(
        {
          routes: ["会话管理", "执行观测", "审批记录", "诊断日志"],
          traceQueries: await app.evaluate(() => globalThis.__operationsFixture.traceQueries),
          guard,
          traceKeyboardReachability,
          traceDetailRetryFocus,
          rendererErrors: errors,
          coverage:
            "Native Electron React+preload; trace IPC shim delegates to compiled real ModelTraceHistory/ModelTraceStore and injects independent read failures; sessions/log metadata and approval responses are synthetic; no provider requests",
        },
        null,
        2,
      ),
    );
  console.log(`PASS: current operation pages and interactions; evidence: ${screenshotDir}`);
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
