/** Production WebsiteEntry → AuthGate → ProjectsGate → Workbench/controller →
 * real cookie HTTP + ProtocolClient WebSocket against an owned loopback Hub.
 * The Hub auth store, disk sessions, upload store and RPC responses are fixture
 * implementations. No Core/Host/Engine, provider or operator credentials load.
 * Requests are held at the actual server response boundary, never in React. */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use run-isolated-node-smoke.mjs");
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { WebSocketServer, WebSocket } = require("ws");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--evidence-dir" && args[1]),
  "Expected no arguments or --evidence-dir <fresh-directory-outside-checkout>",
);
let output;
if (args.length) {
  const requested = path.resolve(args[1]);
  output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  const relative = path.relative(await realpath(repo), output);
  assert.ok(
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "Evidence must remain outside this checkout",
  );
  await mkdir(output, { mode: 0o700 }); // Exclusive: never adopt or overwrite caller data.
} else output = await mkdtemp(path.join(tmpdir(), "codeshell-web-auth-boundary-"));
const reports = [],
  requests = [],
  rpc = [],
  errors = [],
  blocked = [],
  unexpected = [];
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{WebsiteEntry}from'./WebsiteShell';import './app.css';createRoot(document.getElementById('root')).render(<React.StrictMode><WebsiteEntry setupToken=''/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const configuration = {
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: {},
  connections: [],
  catalog: [],
  skills: [],
  mcpServers: [],
  restartRequired: false,
};
let state, browser, context, page, origin, failure, driverGuard;
const reset = () =>
  (state = {
    epoch: 0,
    valid: new Set(),
    holdLogin: false,
    holdDevice: false,
    holdUpload: false,
    holdLists: false,
    holdDetail: false,
    holdRun: false,
    held: [],
    uploads: 0,
    sessions: ["first", "second"].map((sessionId, index) => ({
      sessionId,
      cwd: "/owned",
      title: `Owned ${sessionId}`,
      model: "owned-ui",
      status: "completed",
      startedAt: index + 1,
      lastActiveAt: index + 1,
      running: false,
      turnCount: 1,
      archivedAt: null,
      customTitle: "",
    })),
  });
reset();
const tokenOf = (request) => /(?:^|;\s*)owned-auth=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
const identity = (token) => ({ id: token, username: "owned-admin", deviceName: "Owned browser" });
const json = (response, data, status = 200, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(data));
};
const hold = (kind, response, deliver, extra = {}) => {
  const entry = { kind, response, deliver, ...extra };
  state.held.push(entry);
  response?.once("close", () => {
    entry.closed = true;
  });
};
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://owned.invalid");
    const token = tokenOf(request);
    requests.push({
      path: url.pathname + url.search,
      method: request.method,
      token,
      at: Date.now(),
    });
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js}</script>`,
      );
    }
    if (["/api/v1/cloud-browser/capabilities", "/api/v1/environment"].includes(url.pathname))
      return json(response, {}, 404);
    if (url.pathname === "/api/v1/auth/status")
      return json(response, {
        initialized: true,
        authenticated: state.valid.has(token),
        ...(state.valid.has(token) ? { session: identity(token) } : {}),
      });
    if (url.pathname === "/api/v1/auth/login" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.username, "owned-admin");
      assert.equal(input.password, "owned-auth-boundary-password");
      const deliver = () => {
        const next = `owned-session-${++state.epoch}`;
        state.valid.add(next);
        json(response, { authenticated: true, session: identity(next) }, 200, {
          "set-cookie": `owned-auth=${next}; HttpOnly; SameSite=Strict; Path=/`,
        });
      };
      return state.holdLogin ? hold("login", response, deliver) : deliver();
    }
    if (!state.valid.has(token)) return json(response, { error: "Owned login expired" }, 401);
    if (url.pathname === "/api/v1/projects") return json(response, {}, 404);
    if (url.pathname === "/api/v1/auth/sessions" && request.method === "GET")
      return json(response, {
        sessions: [
          {
            id: token,
            deviceName: "Owned current",
            createdAt: 1,
            lastSeenAt: 1,
            expiresAt: Date.now() + 60_000,
            current: true,
          },
          {
            id: "owned-other-device",
            deviceName: "Owned other",
            createdAt: 1,
            lastSeenAt: 1,
            expiresAt: Date.now() + 60_000,
            current: false,
          },
        ],
      });
    if (
      url.pathname === "/api/v1/auth/sessions/owned-other-device" &&
      request.method === "DELETE"
    ) {
      const deliver = (status) =>
        json(
          response,
          status === 401 ? { error: "Owned old identity revoked" } : { ok: true },
          status ?? 200,
        );
      return state.holdDevice ? hold("device", response, deliver, { token }) : deliver();
    }
    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      request.resume();
      state.valid.delete(token);
      for (const socket of sockets.clients)
        if (socket.token === token) socket.close(4401, "Owned logout");
      return json(response, { ok: true }, 200, {
        "set-cookie": "owned-auth=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
      });
    }
    if (url.pathname === "/api/v1/configuration") return json(response, configuration);
    if (url.pathname === "/api/v1/sessions") {
      const data = { sessions: state.sessions.map((row) => ({ ...row })), nextCursor: null };
      return state.holdLists
        ? hold(
            "list",
            response,
            () =>
              json(response, {
                ...data,
                sessions: [{ ...data.sessions[0], title: "OLD_LIST_MUST_NOT_ENTER_NEW_LOGIN" }],
              }),
            { query: url.search },
          )
        : json(response, data);
    }
    if (url.pathname.startsWith("/api/v1/uploads/") && request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const file = {
        id: `owned-upload-${++state.uploads}`,
        name: decodeURIComponent(request.headers["x-file-name"]),
        size: Buffer.concat(chunks).length,
        mimeType: "text/plain",
        path: "/owned/fixture-upload",
      };
      return state.holdUpload
        ? hold("upload", response, () => json(response, file), { file })
        : json(response, file);
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    json(response, { error: "Unhandled owned auth fixture API" }, 404);
  })().catch((error) => {
    unexpected.push(error.stack);
    if (!response.headersSent) json(response, { error: "Owned fixture failure" }, 500);
  });
});
const sockets = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info) => state.valid.has(tokenOf(info.req)),
});
const reply = (socket, id, result, error) => {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
};
const notify = (method, params, token) => {
  for (const socket of sockets.clients)
    if (socket.readyState === WebSocket.OPEN && (!token || socket.token === token))
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
};
const question = (sessionId = "second") => ({
  requestId: "owned-replayed-question",
  sessionId,
  request: {
    toolName: "__ask_user__",
    args: { asynchronous: true },
    description: "Owned persistent question",
  },
});
sockets.on("connection", (socket, request) => {
  socket.token = tokenOf(request);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    rpc.push({ token: socket.token, ...message });
    const { id, method, params } = message;
    if (method === "agent/query" && params.type === "sessions")
      return reply(socket, id, { type: "sessions", data: state.sessions });
    if (method === "agent/query" && params.type === "session_detail") {
      const result = {
        type: "session_detail",
        data: {
          state: {},
          transcript: [{ message: { role: "assistant", content: `Saved ${params.sessionId}` } }],
          running: false,
        },
      };
      return state.holdDetail
        ? hold("detail", null, () =>
            reply(socket, id, {
              ...result,
              data: {
                ...result.data,
                transcript: [
                  {
                    message: { role: "assistant", content: "OLD_RESTORE_MUST_NOT_ENTER_NEW_LOGIN" },
                  },
                ],
              },
            }),
          )
        : reply(socket, id, result);
    }
    if (method === "agent/query" && params.type === "output_journal")
      return reply(socket, id, undefined, {
        code: -32602,
        message: "Unknown query type: output_journal",
      });
    if (method === "serve/approval.snapshot")
      return reply(socket, id, { approvals: [], leases: [] });
    if (method === "agent/run")
      return state.holdRun
        ? hold("run", null, () =>
            reply(socket, id, undefined, {
              code: -32000,
              message: "OLD_RUN_MUST_NOT_RESTORE_NEW_DRAFT",
            }),
          )
        : reply(socket, id, {});
    if (method === "agent/approve" || method === "agent/cancel") return reply(socket, id, {});
    unexpected.push(`WS ${method} ${JSON.stringify(params)}`);
    reply(socket, id, undefined, { code: -32601, message: "Unhandled owned method" });
  });
});
async function until(check, label, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let timer;
    const value = await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
const held = (kind) => state.held.filter((item) => item.kind === kind);
const composer = () => page.getByRole("textbox", { name: "任务内容", exact: true });
async function login() {
  await page.getByRole("heading", { name: "登录工作空间", exact: true }).waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("owned-admin");
  await page.getByLabel("密码", { exact: true }).fill("owned-auth-boundary-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
async function ready() {
  await composer().waitFor();
  await page.locator(".connection-pill .dot.open").waitFor();
}
async function expire() {
  const token = `owned-session-${state.epoch}`;
  state.valid.delete(token);
  for (const socket of sockets.clients)
    if (socket.token === token) socket.close(4401, "Owned expiry");
  await page.getByRole("heading", { name: "登录工作空间", exact: true }).waitFor();
}
async function openDevices() {
  await page.locator(".account-button").click();
  const dialog = page.getByRole("dialog", { name: "账号与设备", exact: true });
  await dialog.waitFor();
  await dialog.getByText("Owned other", { exact: true }).waitFor();
  return dialog;
}
async function boot(name) {
  reset();
  context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : (blocked.push(route.request().url()), route.abort()),
  );
  await context.routeWebSocket("**/*", (route) =>
    route.url() === origin.replace("http:", "ws:") + "/ws"
      ? route.connectToServer()
      : (blocked.push(route.url()), route.close()),
  );
  page = await context.newPage();
  page.setDefaultTimeout(7_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?session=first`);
  return { name, requestsAt: requests.length, rpcAt: rpc.length };
}
async function run(name, operation) {
  const record = await boot(name);
  try {
    await operation(record);
    record.result = "pass";
  } catch (error) {
    record.result = "fail";
    record.failure = error.stack;
    record.body = await page.locator("body").innerText();
    failure ??= error;
  } finally {
    record.requests = requests.slice(record.requestsAt);
    record.rpc = rpc.slice(record.rpcAt);
    record.held = state.held.map(({ kind, closed, query }) => ({ kind, closed, query }));
    await page.screenshot({ path: path.join(output, name + ".png") });
    reports.push(record);
    await context.close();
    context = undefined;
  }
}
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
  installLocalNetworkGuard(origin);
  let negativeProbes = 0;
  for (const probe of [
    () => fetch("https://example.invalid/denied"),
    () => http.request("http://localhost:9/denied"),
    () => http.get("http://127.0.0.1:9/denied"),
    () => https.request("https://example.invalid/denied"),
    () => https.get("https://example.invalid/denied"),
  ]) {
    assert.throws(probe, /refused a non-fixture request/);
    negativeProbes++;
  }
  driverGuard = { origin, negativeProbes, coreImported: false, workerCreated: false };
  await run("login-survives-real-tab-visibility-check", async (record) => {
    state.holdLogin = true;
    await login();
    await until(() => held("login").length === 1, "held actual login POST");
    // Playwright forces every tab focused by default. Disable only that test
    // emulation so native tab activation can emit real visibility/focus events.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await page.evaluate(() => {
      window.__authFocusEvents = [];
      window.addEventListener("focus", (event) =>
        window.__authFocusEvents.push({ type: "focus", trusted: event.isTrusted }),
      );
      document.addEventListener("visibilitychange", (event) =>
        window.__authFocusEvents.push({
          type: "visibilitychange",
          trusted: event.isTrusted,
          state: document.visibilityState,
        }),
      );
    });
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    const status = page
      .waitForResponse((response) => response.url() === origin + "/api/v1/auth/status", {
        timeout: 1_000,
      })
      .catch(() => null);
    await page.bringToFront();
    await page.waitForFunction(() =>
      window.__authFocusEvents.some(
        (event) => event.trusted && (event.type === "focus" || event.state === "visible"),
      ),
    );
    const checked = await status;
    if (checked) await checked.finished();
    record.realFocusEvents = await page.evaluate(() => window.__authFocusEvents);
    record.backgroundCheckDuringLogin = !!checked;
    state.holdLogin = false;
    const loginResponse = page.waitForResponse(
      (response) => response.url() === origin + "/api/v1/auth/login" && response.status() === 200,
    );
    held("login")[0].deliver();
    await (await loginResponse).finished();
    record.serverAuthenticated = state.valid.size === 1;
    await composer().waitFor({ timeout: 2_500 });
    await ready();
    await other.close();
  });
  await run("old-device-401-cannot-expire-relogin", async (record) => {
    await login();
    await ready();
    state.holdDevice = true;
    const dialog = await openDevices();
    await dialog
      .locator(".device-list li")
      .last()
      .getByRole("button", { name: "撤销登录", exact: true })
      .click();
    await until(() => held("device").length === 1, "held authenticated device DELETE");
    await expire();
    await login();
    await ready();
    await composer().fill("NEW_LOGIN_DRAFT_MUST_SURVIVE_OLD_401");
    record.activeToken = `owned-session-${state.epoch}`;
    record.newLoginAuthenticatedBeforeOldResponse = state.valid.has(record.activeToken);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/sessions/owned-other-device") && response.status() === 401,
    );
    held("device")[0].deliver(401);
    await (await response).finished();
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    assert.equal(await composer().inputValue(), "NEW_LOGIN_DRAFT_MUST_SURVIVE_OLD_401");
    assert.equal(await page.getByRole("heading", { name: "登录工作空间", exact: true }).count(), 0);
    assert.ok(state.valid.has(record.activeToken));
  });
  await run("explicit-logout-clears-pending-chat-state", async (record) => {
    await login();
    await ready();
    await page.getByText("Saved first", { exact: true }).waitFor();
    await composer().fill("OLD_PENDING_RUN");
    state.holdRun = true;
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await until(() => held("run").length === 1, "held actual run");
    state.holdDetail = true;
    await page.getByRole("button", { name: /Owned second/ }).click();
    await until(() => held("detail").length === 1, "held actual restore");
    await composer().fill("OLD_UNSENT_DRAFT");
    await page.locator('input[type="file"]').setInputFiles({
      name: "old-complete.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("owned"),
    });
    await page.getByRole("button", { name: "移除 old-complete.txt", exact: true }).waitFor();
    notify("agent/approvalRequest", question());
    await page.getByLabel("自定义回答", { exact: true }).fill("OLD_UNSENT_ANSWER");
    state.holdUpload = true;
    await page.locator('input[type="file"]').setInputFiles({
      name: "old-pending.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("owned"),
    });
    await until(() => held("upload").length === 1, "held actual upload");
    state.holdLists = true;
    notify("serve/sessionsChanged", {});
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await until(() => held("list").length >= 2, "held sidebar and history lists");
    const dialog = await openDevices();
    await dialog.getByRole("button", { name: "退出当前设备", exact: true }).click();
    await page.getByRole("heading", { name: "登录工作空间", exact: true }).waitFor();
    state.holdUpload = state.holdLists = state.holdDetail = state.holdRun = false;
    await login();
    await page
      .getByRole("button", { name: /Owned second/ })
      .first()
      .click();
    await ready();
    await page.getByText("Saved second", { exact: true }).waitFor();
    assert.equal(await composer().inputValue(), "");
    assert.equal(await page.getByRole("button", { name: /^移除 old-/ }).count(), 0);
    // A Host may replay the same still-pending question after login. The form's
    // local answer must start empty while legitimate server state remains.
    notify("agent/approvalRequest", question());
    await page.getByLabel("自定义回答", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("自定义回答", { exact: true }).inputValue(), "");
    await composer().fill("NEW_UNSENT_DRAFT");
    for (const entry of state.held.filter((entry) => entry.kind !== "login")) entry.deliver();
    notify("agent/streamEvent", {
      sessionId: "second",
      event: { type: "session_title", title: "Fresh authenticated marker" },
    });
    await page.locator(".topbar-title", { hasText: "Fresh authenticated marker" }).waitFor();
    assert.equal(await composer().inputValue(), "NEW_UNSENT_DRAFT");
    assert.equal(await page.getByLabel("自定义回答", { exact: true }).inputValue(), "");
    assert.equal(await page.getByText(/OLD_(LIST|RESTORE|RUN|UNSENT)/).count(), 0);
    assert.equal(
      rpc.slice(record.rpcAt).filter((item) => item.method === "agent/run").length,
      1,
      "No run replay crosses login",
    );
    record.isolated = [
      "pending restore",
      "pending upload",
      "pending run",
      "sidebar list",
      "history list",
      "draft",
      "completed attachment",
      "replayed question answer",
    ];
  });
  await run("current-login-401-after-dialog-close-remains-effective", async () => {
    await login();
    await ready();
    state.holdDevice = true;
    const dialog = await openDevices();
    await dialog
      .locator(".device-list li")
      .last()
      .getByRole("button", { name: "撤销登录", exact: true })
      .click();
    await until(() => held("device").length === 1, "held current identity request");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    state.valid.delete(`owned-session-${state.epoch}`);
    held("device")[0].deliver(401);
    await page.getByRole("heading", { name: "登录工作空间", exact: true }).waitFor();
    assert.equal(await composer().count(), 0);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(unexpected, []);
  if (failure) throw failure;
  reports.push({ operation: "driver exact-origin negative probes", negativeProbes });
} catch (error) {
  failure ??= error;
} finally {
  try {
    await context?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await browser?.close();
  } catch (error) {
    failure ??= error;
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((done) => sockets.close(done));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        result: failure ? "fail" : "pass",
        boundary:
          "Production WebsiteEntry/AuthGate/React/ProtocolClient; owned HTTP cookie auth and WS Hub fixtures; no Core/Host/Engine/provider",
        driverGuard,
        reports,
        errors,
        blocked,
        unexpected,
        failure: failure?.stack,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    output,
    result: failure ? "fail" : "pass",
    reports: reports.map(({ name, result }) => ({ name, result })),
    errors,
    blocked,
    unexpected,
  }),
);
if (failure) throw failure;
