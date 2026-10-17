/** Actual Workbench/useHubController/ProtocolClient against owned HTTP/WS responses.
 * No Core/Host/Engine/provider runs. Optional --reducer-ref freezes only the
 * reducer from a local commit; all cases, guards and other sources stay identical.
 * Run with run-isolated-node-smoke.mjs --evidence-dir <fresh outside directory>. */
/* global window, document, navigator */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";
import { watchElectronTestProcess } from "../../desktop/scripts/electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated Node smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const args = process.argv.slice(2);
assert.ok(
  (args.length === 2 || args.length === 4) &&
    args[0] === "--evidence-dir" &&
    args[1] &&
    (args.length === 2 || (args[2] === "--reducer-ref" && /^[a-f0-9]{40}$/.test(args[3]))),
  "Expected --evidence-dir <new outside directory> [--reducer-ref <full local commit>]",
);
const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const requested = path.resolve(args[1]);
const evidence = path.join(await realpath(path.dirname(requested)), path.basename(requested));
const outside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
assert.ok(outside(repo, evidence), "Evidence must be outside this checkout");
assert.ok(
  outside(await realpath(process.env.HOME), evidence),
  "Evidence must survive outer HOME cleanup",
);
await mkdir(evidence, { mode: 0o700 }); // EEXIST rejects adoption, including symlinks.
const write = (name, value) =>
  writeFile(
    path.join(evidence, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
    {
      mode: 0o600,
    },
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) =>
  children.execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 5000 }).trim();
const reducerPath = "packages/web/src/lib/streamReducer.ts";
const cases = [],
  failures = [],
  rendererErrors = [],
  deniedAttempts = [],
  unexpected = [],
  signals = [],
  rpc = [],
  requests = [];
const report = {
  fixture: "real-web-subagent-state",
  status: "failed",
  evidence,
  platform: process.platform,
  sourceHead: git("rev-parse", "HEAD"),
  sourceDirty: git("status", "--porcelain", "--untracked-files=no") !== "",
  fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  reducerRef: args[3] ?? null,
  cases,
  failures,
  rendererErrors,
  deniedAttempts,
  unexpected,
  signals,
  rpc,
  requests,
  boundary:
    "Actual Chromium Workbench/useHubController/ProtocolClient and production CSS at 1280/390. Owned HTTP/JSON-RPC WS Host replies only; no Core, Engine, provider, account, real repository or native app. Browser routes/init guards and Node exact-origin refusal are test confinement, not an OS egress sandbox. Legacy paired Mobile adapter is not covered.",
};
await write("receipt.json", report);
const homeRoot = path.join(evidence, "private-browser");
await mkdir(homeRoot, { mode: 0o700 });
const browserEnv = createBunTestEnvironment(process.env, homeRoot);
const profile = path.join(browserEnv.HOME, "chromium-profile");
report.privateHome = browserEnv.HOME;
report.privateHomeRemoved = false;
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
let context, child, childClosed, monitor, origin, sockets, page, scripts, styles;
let stdout = "",
  stderr = "";
const observerFailures = (report.observerFailures = []);
const browserDenied = (report.browserDenied = []);
const sessions = new Map();
const configuration = {
  workspace: { path: "/owned-fixture", settingsScope: "local", skillDirectories: [] },
  defaults: {},
  connections: [],
  catalog: [],
  skills: [],
  mcpServers: [],
  restartRequired: false,
};
const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url, origin);
    requests.push({ method: request.method, path: url.pathname + url.search });
    const json = (value, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return response.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><div id="root"></div><script>${scripts.replace(/<\/script/gi, "<\\/script")}</script>`,
      );
    }
    if (request.method === "GET" && url.pathname === "/api/v1/environment") return json({}, 404);
    if (request.method === "GET" && url.pathname === "/api/v1/configuration")
      return json(configuration);
    if (request.method === "GET" && url.pathname === "/api/v1/sessions")
      return json({
        sessions: [...sessions.values()].map(({ summary }) => summary),
        nextCursor: null,
      });
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    unexpected.push(`HTTP ${request.method} ${url.pathname}`);
    json({ error: "Unexpected owned fixture request" }, 404);
  } catch (error) {
    unexpected.push(`HTTP fixture failure: ${error.message}`);
    response.destroy();
  }
});
const until = async (predicate, label) => {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const bounded = async (promise, milliseconds, message) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => (timer = setTimeout(() => reject(Error(message)), milliseconds))),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  installLocalNetworkGuard(origin); // Before bundling or executing any product source.
  const negativeProbes = (report.negativeProbes = []);
  for (const [name, invoke] of [
    ["fetch foreign", () => fetch("http://127.0.0.1:1/")],
    ["http foreign", () => http.get("http://127.0.0.1:1/")],
    ["https foreign", () => https.get("https://owned.invalid/")],
    [
      "http custom socket",
      () =>
        http.request({
          hostname: "127.0.0.1",
          port: server.address().port,
          socketPath: "/owned-unused",
        }),
    ],
  ]) {
    assert.throws(invoke, /Cost smoke refused/);
    negativeProbes.push({ name, refused: true });
  }
  const { build } = require("esbuild"),
    { chromium } = require("playwright");
  const { WebSocketServer, WebSocket } = require("ws");
  const executable = await realpath(
    process.env.CODESHELL_TEST_CHROMIUM ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : chromium.executablePath()),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...values) => {
    try {
      return originalFetch(...values);
    } catch (error) {
      deniedAttempts.push({ kind: "node-fetch" });
      throw error;
    }
  };
  const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';import{useHubController}from'./useHubController';function Fixture(){const controller=useHubController({hub:true});window.ownedController=controller;return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
  let frozen;
  if (args[3]) {
    assert.equal(git("rev-parse", "--verify", `${args[3]}^{commit}`), args[3]);
    frozen = children.execFileSync("git", ["show", `${args[3]}:${reducerPath}`], {
      cwd: repo,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    await write("reducer-frozen.ts", frozen);
  }
  report.reducerSHA256 = hash(frozen ?? (await readFile(path.join(repo, reducerPath))));
  const bundle = await build({
    stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
    bundle: true,
    write: false,
    outdir: evidence,
    metafile: true,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "owned-source-only",
        setup(builder) {
          builder.onResolve({ filter: /^@cjhyy\// }, (args) => {
            throw Error(`Runtime workspace package import refused: ${args.path}`);
          });
          builder.onLoad({ filter: /streamReducer\.ts$/ }, (args) => {
            assert.equal(args.path, path.join(repo, reducerPath));
            return frozen === undefined
              ? undefined
              : { contents: frozen, loader: "ts", resolveDir: path.dirname(args.path) };
          });
        },
      },
    ],
  });
  scripts = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
  styles = bundle.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
  report.bundleSHA256 = hash(scripts);
  report.cssSHA256 = hash(styles);
  report.productSources = {};
  for (const input of Object.keys(bundle.metafile.inputs)) {
    if (input === "<stdin>") continue;
    const resolved = path.resolve(repo, input);
    if (!outside(repo, resolved) && !resolved.includes(`${path.sep}node_modules${path.sep}`)) {
      assert.ok(
        !/(?:^|[/\\])(?:dist|out)(?:[/\\])/.test(input),
        "Read production source, not shared build output",
      );
      report.productSources[input] = hash(
        resolved === path.join(repo, reducerPath) && frozen !== undefined
          ? frozen
          : await readFile(resolved),
      );
    }
  }
  sockets = new WebSocketServer({ server, path: "/ws" });
  const reply = (socket, id, result) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      try {
        const request = JSON.parse(String(raw));
        rpc.push(request);
        const { id, method, params } = request;
        if (method === "agent/query" && params.type === "sessions")
          return reply(socket, id, {
            type: "sessions",
            data: [...sessions.values()].map((v) => v.summary),
          });
        if (method === "serve/approval.snapshot")
          return reply(socket, id, { approvals: [], leases: [] });
        if (method === "agent/query" && params.type === "session_detail") {
          const session = sessions.get(params.sessionId);
          assert.ok(session, "Only owned sessions can be restored");
          return reply(socket, id, { type: "session_detail", data: session.detail });
        }
        if (method === "agent/query" && params.type === "output_journal")
          return reply(socket, id, { type: "output_journal", data: { status: "unavailable" } });
        if (method === "agent/run" || method === "agent/cancel") {
          assert.ok(sessions.has(params.sessionId));
          return reply(socket, id, {}); // Explicit fixture admission/cancel only; no engine.
        }
        unexpected.push(`WS ${method} ${params?.type ?? ""}`);
        reply(socket, id, {});
      } catch (error) {
        unexpected.push(`WS fixture failure: ${error.message}`);
      }
    }),
  );
  const notify = (sessionId, event) => {
    assert.ok(sessions.has(sessionId));
    for (const socket of sockets.clients)
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/streamEvent",
            params: { sessionId, event },
          }),
        );
  };
  const originalSpawn = children.spawn;
  children.spawn = function (command, values, options) {
    if (values?.some((value) => String(value).includes("agent-server-stdio"))) {
      deniedAttempts.push({ kind: "worker" });
      throw Error("No Engine worker is allowed");
    }
    const spawned = originalSpawn.call(this, command, values, options);
    if (
      command === executable &&
      options?.env?.HOME === browserEnv.HOME &&
      values.includes(`--user-data-dir=${profile}`)
    ) {
      assert.equal(child, undefined, "Capture only one exact owned browser");
      child = spawned;
      childClosed = new Promise((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned browser spawn error"));
      child.stdout?.on("data", (bytes) => (stdout = (stdout + bytes).slice(-1024 * 1024)));
      child.stderr?.on("data", (bytes) => (stderr = (stderr + bytes).slice(-1024 * 1024)));
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 120000,
        reportFailure: (message) => observerFailures.push(message),
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
          process.kill(pid, signal);
        },
      });
      report.browserPid = child.pid;
    }
    return spawned;
  };
  syncBuiltinESMExports();
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: executable,
      env: browserEnv,
      headless: true,
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--no-pings",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.ok(monitor, "Browser birth custody must precede all UI operations");
  await context.exposeBinding("__ownedDenied", (_source, kind) => browserDenied.push({ kind }));
  await context.addInitScript(
    ({ origin }) => {
      window.ownedGuardAttempts = [];
      const deny = (kind) => {
        window.ownedGuardAttempts.push(kind);
        void window.__ownedDenied(kind);
        throw Error("Owned browser fixture denied " + kind);
      };
      const allowed = (value) => new URL(String(value), window.location.href).origin === origin;
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!allowed(typeof input === "string" || input instanceof URL ? input : input.url))
          return deny("fetch");
        return originalFetch(input, { ...init, redirect: "error" });
      };
      const OriginalSocket = window.WebSocket;
      window.WebSocket = class extends OriginalSocket {
        constructor(url, protocols) {
          if (String(url) !== origin.replace("http:", "ws:") + "/ws") deny("WebSocket");
          super(url, protocols);
        }
      };
      for (const name of ["Worker", "SharedWorker", "EventSource", "XMLHttpRequest"])
        window[name] = class {
          constructor() {
            deny(name);
          }
        };
      navigator.sendBeacon = () => deny("sendBeacon");
      window.codeshell = new Proxy({}, { get: () => deny("IPC") });
    },
    { origin },
  );
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    browserDenied.push({ kind: "route", resource: route.request().resourceType() });
    return route.abort();
  });
  await context.routeWebSocket("**/*", (route) => {
    if (route.url() === origin.replace("http:", "ws:") + "/ws") return void route.connectToServer();
    browserDenied.push({ kind: "socket-route" });
    route.close();
  });
  context.on("page", (next) => next.on("pageerror", (error) => rendererErrors.push(error.message)));
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  const input = page.getByRole("textbox", { name: "任务内容", exact: true });
  const send = page.getByRole("button", { name: "发送", exact: true });
  const stop = page.getByRole("button", { name: "停止", exact: true });
  const state = () =>
    page.evaluate(() => ({
      run: window.ownedController.chat.run,
      running: window.ownedController.running,
      live: window.ownedController.chat.liveByAgent,
      items: window.ownedController.chat.items,
    }));
  const start = async (id, width) => {
    const text = `Saved owned parent ${id}`;
    sessions.set(id, {
      summary: {
        cwd: "/owned-fixture",
        sessionId: id,
        title: id,
        startedAt: sessions.size + 1,
        model: "owned-no-model",
        status: "completed",
        turnCount: 1,
        running: false,
      },
      detail: {
        state: {},
        transcript: [{ message: { role: "assistant", content: text } }],
        running: false,
      },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?session=${id}`);
    await page.getByText(text, { exact: true }).waitFor();
    await until(
      async () => !(await page.evaluate(() => window.ownedController.loading)),
      "Actual snapshot must finish",
    );
    await input.waitFor({ state: "visible" });
  };
  const hit = async (target) => {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await target.evaluate((node) => {
        const r = node.getBoundingClientRect(),
          top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return (
          r.width > 0 &&
          r.left >= 0 &&
          r.right <= window.innerWidth + 1 &&
          (top === node || node.contains(top))
        );
      }),
      true,
      "Actual UI control must be reachable",
    );
  };
  const runCase = async (name, action) => {
    const item = { name, status: "failed" };
    cases.push(item);
    try {
      await action(item);
      item.status = "passed";
    } catch (error) {
      item.error = error.message;
      failures.push({ name, message: error.message });
    }
    item.finalState = await state().catch(() => null);
    await page
      .screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true })
      .catch((error) => failures.push({ name: "screenshot", message: error.message }));
  };
  for (const width of [1280, 390]) {
    await runCase(`${width}-normal-completed-snapshot-send-once`, async (item) => {
      const id = `control-${width}`;
      await start(id, width);
      item.sessionId = id;
      await hit(input);
      await input.pressSequentially(`Owned normal draft ${width}`);
      item.draftBefore = await input.inputValue();
      item.beforeSend = await state();
      assert.equal(item.beforeSend.running, false);
      assert.equal(await send.isEnabled(), true);
      await hit(send);
      await send.click();
      await until(
        () => rpc.filter((v) => v.method === "agent/run" && v.params.sessionId === id).length === 1,
        "Normal snapshot Send must reach owned Host exactly once",
      );
      item.actualRunRequests = rpc.filter(
        (v) => v.method === "agent/run" && v.params.sessionId === id,
      );
      assert.equal(item.actualRunRequests[0].params.task, item.draftBefore);
      await until(
        async () => (await page.locator(".msg.user").count()) === 1,
        "Normal snapshot must show exactly one user message",
      );
      assert.equal(await input.inputValue(), "");
    });
    await runCase(`${width}-completed-parent-child-details-send-once`, async (item) => {
      const id = `send-${width}`;
      await start(id, width);
      item.sessionId = id;
      await hit(input);
      await input.pressSequentially(`Owned actual typed draft ${width}`);
      item.draftBefore = await input.inputValue();
      const parentRun = (await state()).run;
      item.beforeChild = await state();
      notify(id, {
        type: "agent_start",
        agentId: "owned-background",
        name: "Owned background child",
      });
      for (const event of [
        { type: "stream_request_start" },
        { type: "text_delta", text: `Owned child details ${width}` },
        { type: "thinking_delta", text: "Owned background reasoning" },
        {
          type: "tool_use_start",
          toolCall: {
            id: `bg-tool-${width}`,
            toolName: "Read",
            args: { path: "owned/background.txt" },
          },
        },
      ]) {
        notify(id, { ...event, agentId: "owned-background" });
        await until(async () => {
          const value = await state();
          return event.type === "stream_request_start"
            ? Boolean(value.live["owned-background"])
            : event.type === "tool_use_start"
              ? value.items.some((v) => v.id === `bg-tool-${width}`)
              : value.items.some(
                  (v) =>
                    v.kind === "assistant" &&
                    v.agentId === "owned-background" &&
                    (event.type === "text_delta" ? v.text : v.reasoning).includes(event.text),
                );
        }, "Actual child notification must reach reducer");
        assert.equal(
          (await state()).run,
          parentRun,
          `${event.type} must preserve completed parent state`,
        );
        assert.equal(await send.isEnabled(), true, "Background child must leave Send enabled");
        assert.equal(await input.inputValue(), item.draftBefore);
      }
      notify(id, {
        type: "tool_result",
        agentId: "owned-background",
        result: { id: `bg-tool-${width}`, result: "Owned background tool result", isError: false },
      });
      await until(
        async () => (await state()).items.some((v) => v.id === `bg-tool-${width}` && v.done),
        "Owned background tool result must complete its actual card",
      );
      notify(id, { type: "assistant_message", agentId: "owned-background" });
      notify(id, { type: "turn_complete", agentId: "owned-background", reason: "completed" });
      notify(id, { type: "agent_end", agentId: "owned-background" });
      await page.getByText("Owned background child · 已完成", { exact: false }).waitFor();
      assert.equal(await send.isEnabled(), true);
      await hit(send);
      await page.screenshot({
        path: path.join(evidence, `${width}-child-complete-before-send.png`),
      });
      const before = rpc.filter((v) => v.method === "agent/run").length;
      await send.click();
      await until(
        () => rpc.filter((v) => v.method === "agent/run").length === before + 1,
        "Actual click must reach owned Host exactly once",
      );
      item.actualRunRequests = rpc.filter(
        (v) => v.method === "agent/run" && v.params.sessionId === id,
      );
      assert.equal(item.actualRunRequests.length, 1);
      assert.equal(item.actualRunRequests[0].params.task, item.draftBefore);
      await until(
        async () => (await page.locator(".msg.user").count()) === 1,
        "Actual user message must appear",
      );
      assert.equal(await input.inputValue(), "");
    });
    await runCase(`${width}-child-error-keeps-parent-and-sibling-live-stop`, async (item) => {
      const id = `error-${width}`;
      await start(id, width);
      item.sessionId = id;
      for (const agentId of [undefined, "owned-child-a", "owned-child-b"]) {
        notify(id, { type: "stream_request_start", ...(agentId ? { agentId } : {}) });
        notify(id, {
          type: "text_delta",
          text: agentId ?? "Owned live parent",
          ...(agentId ? { agentId } : {}),
        });
      }
      await page.getByText("Owned live parent", { exact: false }).waitFor();
      await stop.waitFor({ state: "visible" });
      item.before = await state();
      notify(id, { type: "error", agentId: "owned-child-a", error: "Owned scoped child failure" });
      await page
        .locator(".msg.error")
        .getByText("Owned scoped child failure", { exact: true })
        .waitFor();
      item.afterError = await state();
      assert.equal(item.afterError.run, "running");
      assert.equal(await stop.isEnabled(), true);
      assert.equal(item.afterError.live[""], item.before.live[""]);
      assert.equal(item.afterError.live["owned-child-b"], item.before.live["owned-child-b"]);
      assert.equal(item.afterError.live["owned-child-a"], undefined);
      const failed = page.locator(".msg.assistant").filter({ hasText: "owned-child-a" });
      assert.equal(await failed.count(), 1, "Failed child must retain its actual bubble");
      assert.equal(
        await failed.locator(".message-streaming").count(),
        0,
        "Only failed child bubble must stop streaming",
      );
      notify(id, { type: "text_delta", text: " continues after child failure" });
      notify(id, { type: "text_delta", agentId: "owned-child-b", text: " sibling continues" });
      await page
        .locator(".message-streaming")
        .getByText("Owned live parent continues after child failure", { exact: false })
        .waitFor();
      await page
        .locator(".message-streaming")
        .getByText("owned-child-b sibling continues", { exact: false })
        .waitFor();
      await hit(stop);
      await page.screenshot({
        path: path.join(evidence, `${width}-child-error-parent-live-before-stop.png`),
      });
      await stop.click();
      await until(
        () =>
          rpc.filter((v) => v.method === "agent/cancel" && v.params.sessionId === id).length === 1,
        "Actual Stop click must reach owned Host once",
      );
      item.actualCancelRequests = rpc.filter(
        (v) => v.method === "agent/cancel" && v.params.sessionId === id,
      );
      notify(id, { type: "turn_complete", reason: "aborted_streaming" });
      await send.waitFor({ state: "visible" });
    });
    await runCase(`${width}-ordered-orphan-results-clean-identically`, async (item) => {
      const id = `order-${width}`;
      await start(id, width);
      for (const order of ["ordered", "orphan"]) {
        const toolId = `tool-${order}-${width}`;
        const start = {
          type: "tool_use_start",
          toolCall: { id: toolId, toolName: "Read", args: { path: `owned/${order}.txt` } },
        };
        const result = {
          type: "tool_result",
          result: {
            id: toolId,
            result:
              "Visible owned answer.\n<system-reminder>OWNED_MODEL_NOTE_MUST_BE_HIDDEN</system-reminder>\n",
            isError: false,
          },
        };
        for (const event of order === "ordered" ? [start, result] : [result, start])
          notify(id, event);
      }
      await until(
        async () => (await state()).items.filter((v) => v.kind === "tool" && v.done).length === 2,
        "Both orderings must complete through ProtocolClient",
      );
      const tools = page.locator(".message-tool-card");
      assert.equal(await tools.count(), 2);
      item.actualRenderedResults = [];
      for (let i = 0; i < 2; i++) {
        const tool = tools.nth(i);
        await hit(tool.locator("summary"));
        await tool.locator("summary").click();
        item.actualRenderedResults.push(
          await tool.locator(".message-tool-section").last().locator("pre").textContent(),
        );
        assert.equal(await tool.locator(".message-tool-status").textContent(), "已完成");
      }
      assert.deepEqual(item.actualRenderedResults, [
        "Visible owned answer.\n",
        "Visible owned answer.\n",
      ]);
      assert.equal(
        await page.getByText("OWNED_MODEL_NOTE_MUST_BE_HIDDEN", { exact: false }).count(),
        0,
      );
    });
  }
  report.finalBrowserGuardAttempts = await page.evaluate(() => window.ownedGuardAttempts);
  assert.deepEqual(report.finalBrowserGuardAttempts, []);
  assert.deepEqual(await context.cookies(), []);
} catch (error) {
  failures.push({ name: "fixture lifecycle", message: error.message });
} finally {
  const errors = [];
  try {
    if (context) {
      assert.ok(monitor, "No birth custody: unsafe browser close skipped");
      await bounded(context.close(), 8000, "Owned browser close timed out");
    }
  } catch (error) {
    errors.push(error.message);
  }
  try {
    assert.ok(monitor, "Browser custody was never established");
    report.settlement = await monitor.terminate();
    report.processExit = await bounded(childClosed, 3000, "Owned browser close event unavailable");
    assert.equal(report.settlement.status, "cleaned");
    assert.equal(report.settlement.queryFailed, false);
    assert.equal(report.settlement.remainingCount, 0);
    assert.deepEqual(report.processExit, { code: 0, signal: null });
    assert.equal(
      signals.some((v) => v.pid === child.pid),
      false,
      "Browser must not require a watchdog root signal",
    );
  } catch (error) {
    errors.push(error.message);
    child?.unref();
    child?.stdout?.unref?.();
    child?.stderr?.unref?.();
  }
  for (const socket of sockets?.clients ?? []) socket.terminate();
  try {
    if (sockets)
      await bounded(
        new Promise((resolve) => sockets.close(resolve)),
        3000,
        "Owned WS server close timed out",
      );
    await bounded(
      new Promise((resolve) => server.close(resolve)),
      3000,
      "Owned HTTP server close timed out",
    );
  } catch (error) {
    errors.push(error.message);
  }
  for (const message of errors) failures.push({ name: "settled cleanup", message });
  for (const item of cases) {
    for (const [field, method] of [
      ["actualRunRequests", "agent/run"],
      ["actualCancelRequests", "agent/cancel"],
    ]) {
      if (!item[field]) continue;
      const finalCount = rpc.filter(
        (request) => request.method === method && request.params.sessionId === item.sessionId,
      ).length;
      if (finalCount !== 1)
        failures.push({
          name: `${item.name} final request count`,
          message: `${method} settled count ${finalCount}, expected 1`,
        });
    }
  }
  await write("browser.stdout.log", stdout);
  await write("browser.stderr.log", stderr);
  const clean =
    errors.length === 0 &&
    observerFailures.length === 0 &&
    rendererErrors.length === 0 &&
    deniedAttempts.length === 0 &&
    browserDenied.length === 0 &&
    unexpected.length === 0;
  const operationsPassed =
    cases.length === 8 && cases.every((item) => item.status === "passed") && failures.length === 0;
  if (clean && operationsPassed) {
    await rm(homeRoot, { recursive: true, force: true });
    report.privateHomeRemoved = true;
  }
  if (!clean)
    failures.push({
      name: "settled ledgers",
      message: "Runtime error, forbidden attempt, fixture error or custody remains unproven",
    });
  report.status = clean && operationsPassed ? "passed" : "failed";
  await write("receipt.json", report);
}
console.log(
  JSON.stringify({
    status: report.status,
    cases: cases.length,
    evidence,
    privateHomeRemoved: report.privateHomeRemoved,
  }),
);
assert.equal(report.status, "passed", "Web subagent browser regression failed; evidence retained");
