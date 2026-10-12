/* Native existing-project runtime selection, using an authenticated protocol fixture. */
/* global document, window */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-native-cloud-e2e-");
const screenshotDir = process.env.CODESHELL_PROJECT_LOCATION_SCREENSHOT_DIR;
const localPath = join(isolated.home, "Existing project");
const sessionId = "shared-local-and-cloud-session";
const localTitle = "已有本地会话";
const cloudTitle = "已有云端会话";
const localText = "仅保存在此计算机的历史消息。";
const cloudText = "仅保存在云端的历史消息。";
const environmentId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const cookie = `cs_hub_session=${"a".repeat(43)}`;
const password = "native-test-password";
const rpcCalls = [];
const sockets = new Set();
const wss = new WebSocketServer({ noServer: true });
const remote = new Map([[sessionId, { title: cloudTitle, records: [], running: false }]]);
let app, win, origin;
let processLog = "";
let sequence = 0;
function history(id, user, assistant, clientMessageId) {
  const now = Date.now();
  return [
    { id: `${id}-meta`, type: "session_meta", timestamp: now, data: { sessionId: id } },
    {
      id: `${id}-user`,
      type: "message",
      timestamp: now,
      data: { role: "user", content: user, ...(clientMessageId ? { clientMessageId } : {}) },
    },
    { id: `${id}-turn`, type: "turn_boundary", timestamp: now, data: {} },
    {
      id: `${id}-assistant`,
      type: "message",
      timestamp: now,
      data: { role: "assistant", content: assistant },
    },
  ];
}
remote.get(sessionId).records = history(sessionId, "云端已有问题", cloudText);
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/api/v1/auth/status")
    return reply(200, { initialized: true, authenticated: req.headers.cookie === cookie });
  if (req.url === "/api/v1/auth/login" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.username !== "owner" || input.password !== password)
      return reply(401, { error: "Invalid login" });
    res.setHeader("set-cookie", `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
    return reply(200, { ok: true });
  }
  if (req.headers.cookie !== cookie) return reply(401, { error: "Authentication required" });
  if (req.url === "/api/v1/environment")
    return reply(200, {
      version: 1,
      id: environmentId,
      name: "Cloud fixture",
      kind: "project-host",
      entryPath: "/",
    });
  if (req.url === "/api/v1/projects")
    return reply(200, {
      projects: [
        {
          id: projectId,
          name: "Existing remote project",
          status: "running",
          generation: 1,
          createdAt: 123,
          updatedAt: 123,
        },
      ],
    });
  if (req.url === `/p/${projectId}/api/v1/sessions`)
    return reply(200, {
      sessions: [...remote].map(([sessionId, row]) => ({
        sessionId,
        title: row.title,
        startedAt: 123,
        lastActiveAt: 123,
        running: row.running,
      })),
    });
  if (req.url === `/p/${projectId}/api/v1/configuration`)
    return reply(200, {
      workspace: { path: "/remote/workspace", settingsScope: "local", skillDirectories: [] },
      defaults: {},
      connections: [],
      catalog: [],
      skills: [],
      mcpServers: [],
      restartRequired: false,
    });
  return reply(404, { error: "Unknown fixture route" });
});
server.on("upgrade", (req, socket, head) => {
  if (
    req.url !== `/p/${projectId}/ws` ||
    req.headers.cookie !== cookie ||
    req.headers.origin !== origin
  )
    return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  const stream = (id, event) =>
    notify("agent/streamEvent", {
      sessionId: id,
      event,
      hubEpoch: "fixture",
      hubSequence: ++sequence,
    });
  const pendingRuns = new Map();
  const finish = (id) => {
    const run = pendingRuns.get(id);
    if (!run) return;
    pendingRuns.delete(id);
    const item = remote.get(id);
    item.running = false;
    item.records = history(id, run.params.task, "云端原生流式回复", run.params.clientMessageId);
    notify("agent/approvalResolved", { sessionId: id, requestId: `approval-${id}` });
    stream(id, { type: "turn_complete" });
    notify("serve/sessionStatus", { sessionId: id, running: false });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: run.id, result: { ok: true } }));
  };
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    rpcCalls.push(message);
    const { method, params = {}, id } = message;
    const response = (value) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: value }));
    if (method === "agent/query") {
      if (params.type === "sessions")
        return response({
          data: [...remote].map(([sessionId, row]) => ({
            sessionId,
            title: row.title,
            startedAt: 123,
            lastActiveAt: 123,
            running: row.running,
          })),
        });
      if (params.type === "session_detail") {
        const item = remote.get(params.sessionId);
        return response({
          data: {
            transcript: item?.records ?? [],
            running: item?.running ?? false,
            outputJournal: { status: "unavailable" },
            outputCoverage: { unpaired: false, inputIds: [] },
            streamCursor: { epoch: "fixture", sequence },
            liveStream: { events: [], truncated: false },
          },
        });
      }
      if (params.type === "output_journal") return response({ data: { status: "unavailable" } });
      if (params.type === "output_coverage")
        return response({ data: { unpaired: false, inputIds: [] } });
    }
    if (method === "agent/run") {
      assert(
        !("cwd" in params) && !("projectId" in params),
        "Native local authority cannot cross the cloud transport",
      );
      pendingRuns.set(params.sessionId, message);
      remote.set(params.sessionId, {
        title: params.task,
        records: history(params.sessionId, params.task, "", params.clientMessageId),
        running: true,
      });
      notify("agent/runAccepted", {
        sessionId: params.sessionId,
        clientMessageId: params.clientMessageId,
      });
      stream(params.sessionId, { type: "stream_request_start" });
      stream(params.sessionId, { type: "text_delta", text: "云端原生流式回复" });
      notify("agent/approvalRequest", {
        sessionId: params.sessionId,
        requestId: `approval-${params.sessionId}`,
        request: {
          toolName: "Shell",
          args: { command: "echo remote" },
          description: "云端审批测试",
        },
      });
      return;
    }
    if (method === "agent/approve" || method === "agent/cancel") {
      response({ ok: true });
      finish(params.sessionId);
      return;
    }
    response({});
  });
});
const locationTrigger = () => win.getByRole("button", { name: /^运行位置：/ });
const sidebar = () => win.locator("aside");
async function dismissTrust() {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
}
async function locationMenu() {
  await locationTrigger().click();
  return win.getByRole("menu");
}
async function screenshot(step) {
  if (screenshotDir)
    await win.screenshot({
      path: join(screenshotDir, `native-cloud-${step}.png`),
      animations: "disabled",
      scale: "css",
    });
}
try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await mkdir(localPath, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(join(localPath, "README.md"), "# Existing local project\n");
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: { CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk.toString()).slice(-12000);
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await dismissTrust();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, localPath);
  await sidebar()
    .getByRole("button", { name: /^(添加项目|Add project)$/ })
    .first()
    .click();
  await win.waitForFunction(
    async () => (await window.codeshell.projectRegistry.list()).length === 1,
  );
  await dismissTrust();
  const project = (await win.evaluate(() => window.codeshell.projectRegistry.list()))[0];
  const directory = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      sessionId,
      title: localTitle,
      cwd: localPath,
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: 123,
    }),
  );
  await writeFile(
    join(directory, "transcript.jsonl"),
    history(sessionId, "本地已有问题", localText).map(JSON.stringify).join("\n") + "\n",
  );
  await seedSessionCatalog(win, {
    [project.id]: {
      sessions: [
        {
          id: sessionId,
          engineSessionId: sessionId,
          title: localTitle,
          createdAt: 123,
          updatedAt: 123,
        },
      ],
      activeSessionId: sessionId,
    },
  });
  await win.reload();
  await dismissTrust();
  await win.getByText(localText, { exact: true }).waitFor();
  const registryBefore = await win.evaluate(() => window.codeshell.projectRegistry.list());
  const catalogBefore = await win.evaluate(() => window.codeshell.sessionCatalog.load());
  await (await locationMenu())
    .getByRole("menuitem", { name: "关联云端项目…", exact: true })
    .click();
  const dialog = win.getByRole("dialog", { name: "关联已有云端项目" });
  await dialog.getByLabel("云端服务地址", { exact: true }).fill(origin);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await dialog.getByLabel("用户名", { exact: true }).fill("owner");
  await dialog.getByLabel("密码", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await dialog.getByLabel("已有云端项目", { exact: true }).selectOption(projectId);
  await screenshot("bind");
  await dialog.getByRole("button", { name: "使用云端", exact: true }).click();
  await win.locator('[data-runtime="cloud"]').waitFor();
  await sidebar().getByRole("button", { name: cloudTitle, exact: true }).click();
  await win.getByText(cloudText, { exact: true }).waitFor();
  assert(
    app.windows().length === 1 && !win.url().startsWith(origin),
    "Cloud stays in the existing native window",
  );
  assert(
    (await win.getByText(localText, { exact: true }).count()) === 0,
    "Equal local/cloud engine IDs cannot mix transcripts",
  );
  await screenshot("history");
  await (await locationMenu()).getByRole("menuitem", { name: "此计算机", exact: true }).click();
  await win.getByText(localText, { exact: true }).waitFor();
  await (await locationMenu())
    .getByRole("menuitem")
    .filter({ hasText: "Existing remote project" })
    .click();
  await win.getByText(cloudText, { exact: true }).waitFor();
  await sidebar().getByRole("button", { name: "在 Existing project 中开始新对话" }).click();
  const composer = win.locator("textarea").last();
  await composer.fill("请在云端执行");
  await composer.press("Enter");
  await win.getByText("云端原生流式回复", { exact: true }).waitFor();
  await win.getByText("云端审批测试", { exact: true }).waitFor();
  await screenshot("stream-approval");
  await win.getByRole("button", { name: /允许一次|仅本次|Allow once/ }).click();
  await win.waitForFunction(
    () => !document.querySelector('[data-runtime="cloud"] button[title="停止"]'),
  );
  assert(
    rpcCalls.filter((row) => row.method === "agent/run").length === 1,
    "One native send produces one cloud run",
  );
  assert(
    rpcCalls.some((row) => row.method === "agent/approve"),
    "Native approval reaches the cloud",
  );
  await win.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  await sidebar().getByRole("button", { name: "在 Existing project 中开始新对话" }).click();
  await composer.fill("请在云端取消");
  await composer.press("Enter");
  await win.getByText("云端审批测试", { exact: true }).waitFor();
  await win.getByRole("button", { name: "停止", exact: true }).click();
  await win.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  const cancel = rpcCalls.find((row) => row.method === "agent/cancel");
  assert(
    cancel && cancel.params.sessionId !== sessionId,
    "Native stop uses the captured cloud session",
  );
  const firstRunCount = rpcCalls.filter((row) => row.method === "agent/run").length;
  for (const socket of sockets) socket.terminate();
  await win.getByRole("button", { name: "重新连接", exact: true }).waitFor();
  await win.getByRole("button", { name: "重新连接", exact: true }).click();
  await win.getByText("云端原生流式回复", { exact: true }).waitFor();
  assert(
    rpcCalls.filter((row) => row.method === "agent/run").length === firstRunCount,
    "Reconnect never resends an executed command",
  );
  assert(
    JSON.stringify(await win.evaluate(() => window.codeshell.projectRegistry.list())) ===
      JSON.stringify(registryBefore),
    "Remote runtime leaves local roots intact",
  );
  assert(
    JSON.stringify(await win.evaluate(() => window.codeshell.sessionCatalog.load())) ===
      JSON.stringify(catalogBefore),
    "Cloud history never writes local session catalog",
  );
  await win.reload();
  await win.locator('[data-runtime="cloud"]').waitFor();
  assert(
    (await locationTrigger().getAttribute("aria-label")) === "运行位置：云端",
    "Runtime selection persists across reload",
  );
  await sidebar().getByRole("button", { name: cloudTitle, exact: true }).click();
  await win.getByText(cloudText, { exact: true }).waitFor();
  await win.setViewportSize({ width: 390, height: 844 });
  await screenshot("390-zh");
  assert(
    await win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "Native cloud fits a narrow window",
  );

  await (await locationMenu()).getByRole("menuitem", { name: "此计算机", exact: true }).click();
  await win.getByText(localText, { exact: true }).waitFor();
  assert(
    (await readFile(join(directory, "transcript.jsonl"), "utf8")).includes(localText),
    "Local durable transcript survives cloud work",
  );
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.evaluate(() => window.localStorage.setItem("codeshell.uiLanguage", "en"));
  await win.reload();
  await win.getByRole("button", { name: "Work in: This computer", exact: true }).waitFor();
  await win.getByRole("button", { name: "Work in: This computer", exact: true }).click();
  await win.getByRole("menuitem").filter({ hasText: "Existing remote project" }).click();
  await win.locator('[data-runtime="cloud"]').waitFor();
  await win.getByRole("button", { name: "Work in: Cloud", exact: true }).waitFor();
  await screenshot("1280-en");
  assert(errors.length === 0, `Renderer errors: ${errors.join("\n")}`);
  console.log(
    "PASS native cloud: existing project binding, one window, scoped history, streaming, approval, reconnect, persistence",
  );
} catch (error) {
  console.error(error);
  if (screenshotDir && win) await screenshot("failure").catch(() => {});
  if (processLog) console.error(processLog);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  for (const socket of sockets) socket.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await isolated.cleanup();
}
