/**
 * Real Docker project integration check, driven by native Node and the built CLI.
 * Build the server and codeshell-project-runtime:local image before running:
 *   node scripts/smoke-project-sandboxes.mjs [image]
 * CODESHELL_SMOKE_ROOT may point to a separate freshly built checkout.
 * Models run on loopback inside the containers with synthetic credentials. No
 * user model settings are loaded. Cleanup only touches this installation's labels.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.env.CODESHELL_SMOKE_ROOT ?? dirname(fileURLToPath(import.meta.url)) + "/..",
);
const entry = join(root, "packages/server/dist/bin/code-shell-serve.js");
const image = process.argv[2] ?? "codeshell-project-runtime:local";
assert.ok(existsSync(entry), "Build the server first: bun run build:server");
assert.ok(/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image), "Invalid image name");
const { WebSocket } = createRequire(join(root, "packages/server/package.json"))("ws");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-project-smoke-")));
const dataDir = join(scratch, "data");
const isolatedHome = join(scratch, "home");
const label = "io.codeshell.project-runtime.installation";
const password = "synthetic-project-smoke-password-12345";
const proofPath = "/workspace/downloads/shared-proof.txt";
const processProof = "written by panel process\n";
const mainProof = "written by main agent after Read\n";
const taskProof = "written by independent panel task after Read\n";
const sockets = new Set();
let installationId;
let child;
let serverUrl;
let cookie;
let logs = "";
let success = false;
let dockerEnv;
let lastRpc;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(check, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function run(command, args, { input, env = dockerEnv, timeout = 30_000 } = {}) {
  return new Promise((done, fail) => {
    const proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
    proc.stdout.on("data", (data) => (stdout = (stdout + data).slice(-2_000_000)));
    proc.stderr.on("data", (data) => (stderr = (stderr + data).slice(-20_000)));
    proc.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout.trim());
      else fail(new Error(`${command} ${args.slice(0, 2).join(" ")} failed (${code}): ${stderr}`));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}
const docker = (args, options) => run("docker", args, options);

async function request(path, { method = "GET", body, anonymous = false, origin = serverUrl } = {}) {
  return fetch(serverUrl + path, {
    method,
    headers: {
      origin,
      ...(!anonymous && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
    redirect: "error",
  });
}
async function json(path, options, status = 200) {
  const response = await request(path, options);
  const text = await response.text();
  assert.equal(response.status, status, `${path}: ${text}`);
  assert.equal(
    response.headers.get("set-cookie"),
    null,
    "Private runtime cookies must stay private",
  );
  return JSON.parse(text);
}

class RpcClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Project socket closed"));
      }
      this.pending.clear();
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  text(sessionId) {
    return this.messages
      .filter(
        (m) =>
          m.method === "agent/streamEvent" &&
          m.params.sessionId === sessionId &&
          m.params.event.type === "text_delta",
      )
      .map((m) => m.params.event.text)
      .join("");
  }
}
async function connect(projectId) {
  const ws = new WebSocket(`${serverUrl.replace("http:", "ws:")}/p/${projectId}/ws`, {
    headers: { cookie, origin: serverUrl },
    handshakeTimeout: 20_000,
  });
  sockets.add(ws);
  const rpc = new RpcClient(ws);
  await once(ws, "open");
  lastRpc = rpc;
  return rpc;
}

// Serialized into the container. Its only credential and endpoint are synthetic.
async function fixtureModel() {
  const { createServer } = await import("node:http");
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const assert = (await import("node:assert/strict")).default;
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer project-smoke-only");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      appendFileSync("/workspace/model-requests.jsonl", JSON.stringify(body) + "\n");
      const messages = body.messages ?? [];
      const userIndex = messages.findLastIndex(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("SMOKE_"),
      );
      const task = JSON.stringify(messages[userIndex]?.content ?? "");
      const toolResults = messages.slice(userIndex).filter((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "project-model-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      const independent = task.includes("SMOKE_PANEL_RW");
      const readWrite = independent || task.includes("SMOKE_MAIN_RW");
      if (readWrite && body.tools?.length && toolResults.length < 2) {
        const reading = toolResults.length === 0;
        if (!reading)
          assert.ok(
            JSON.stringify(toolResults).includes(
              independent ? "written by main agent after Read" : "written by panel process",
            ),
            "The real Read must contain the previous writer's proof",
          );
        const name = reading ? "Read" : "Write";
        assert.ok(body.tools.some((tool) => tool.function.name === name));
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `smoke-${independent ? "panel" : "main"}-${name}`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({
                  file_path: "/workspace/downloads/shared-proof.txt",
                  ...(!reading
                    ? {
                        content: independent
                          ? "written by independent panel task after Read\n"
                          : "written by main agent after Read\n",
                      }
                    : {}),
                }),
              },
            },
          ],
        });
        frame({}, "tool_calls");
      } else {
        frame({
          role: "assistant",
          content: readWrite
            ? "Shared file Read and Write completed."
            : "Isolated project model replied.",
        });
        frame({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      appendFileSync("/workspace/model-errors.log", String(error.stack ?? error) + "\n");
      res.destroy(error);
    });
  });
  server.listen(18791, "127.0.0.1", () => writeFileSync("/workspace/model-ready", "ready"));
}

async function installFixture(container) {
  const modelSource = `(${fixtureModel.toString()})().catch(error => { console.error(error); process.exit(1); });`;
  await docker(["exec", "-i", container, "node", "--input-type=module"], {
    input: `
    import { mkdirSync, writeFileSync, openSync } from "node:fs";
    import { spawn } from "node:child_process";
    import { previewLocalPanelApp, installReviewedLocalPanelApp } from "/opt/codeshell/packages/core/dist/index.js";
    const source = "/tmp/project-smoke-panel";
    for (const path of [source + "/.codeshell-panel", source + "/app", "/workspace/.code-shell"])
      mkdirSync(path, { recursive: true });
    writeFileSync(source + "/.codeshell-panel/panel.json", JSON.stringify({
      schemaVersion: 2, id: "project-smoke-panel", version: "1.0.0",
      title: { default: "Project smoke panel" }, entry: "app/index.html", icon: "panel",
      singleton: true, placement: "right-dock",
      permissions: ["context.workspace", "context.session", "workspace.info", "workspace.read", "workspace.write", "process", "agent.task"],
      agent: { tools: [], skills: [] },
    }));
    writeFileSync(source + "/app/index.html", '<!doctype html><html><head><title>Smoke panel</title></head><body>Project smoke panel</body></html>');
    const review = await previewLocalPanelApp({ kind: "dir", path: source });
    await installReviewedLocalPanelApp({ kind: "dir", path: source }, review.reviewToken, new Date().toISOString());
    writeFileSync("/workspace/.code-shell/settings.local.json", JSON.stringify({
      credentials: [{ id: "fixture-key", catalogId: "openai", apiKey: "project-smoke-only", baseUrl: "http://127.0.0.1:18791/v1" }],
      modelConnections: [{ id: "project-fixture", catalogId: "openai", tag: "text", model: "gpt-4o-mini", credentialId: "fixture-key" }],
      defaults: { text: "project-fixture" },
      permissions: { defaultMode: "default", rules: [{ tool: "Write", decision: "ask" }] },
      autoUpdates: false,
    }), { mode: 0o600 });
    writeFileSync("/workspace/model-fixture.mjs", ${JSON.stringify(modelSource)});
    const out = openSync("/workspace/model-output.log", "a");
    spawn(process.execPath, ["/workspace/model-fixture.mjs"], { detached: true, stdio: ["ignore", out, out] }).unref();
    console.log("Fixture installed");
  `,
  });
  await waitUntil(
    async () =>
      (await docker([
        "exec",
        container,
        "node",
        "-e",
        'process.stdout.write(String(require("node:fs").existsSync("/workspace/model-ready")))',
      ])) === "true",
    "container model fixture",
  );
}

function panelHarness(projectId, grant) {
  const base = `/p/${projectId}/api/v1/panels/runtime/${grant.instanceId}`;
  const events = [];
  const approved = new Set();
  let cursor = 0;
  return {
    base,
    events,
    approved,
    call: (method, params) => json(base + "/call", { method: "POST", body: { method, params } }),
    async poll() {
      const batch = await json(base + `/events?after=${cursor}`);
      for (const event of batch.events) {
        events.push(event);
        if (event.event === "host.confirm") {
          const requestId = event.payload.requestId;
          assert.ok(!approved.has(requestId), "Confirmation must be consumed once");
          approved.add(requestId);
          await json(base + "/confirm", { method: "POST", body: { requestId, allowed: true } });
        }
      }
      cursor = batch.cursor;
    },
    async finish(promise) {
      let settled = false;
      const tracked = promise.finally(() => (settled = true));
      void tracked.catch(() => {});
      await waitUntil(async () => {
        await this.poll();
        return settled;
      }, "approved panel operation");
      return tracked;
    },
  };
}

async function stopControl() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  child.kill("SIGTERM");
  try {
    const [code, signal] = await exited;
    assert.equal(signal, null, "Control must finish cleanup before the shutdown deadline");
    assert.equal(code, 0, "Control must confirm project shutdown without errors");
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupDocker() {
  if (!installationId) return;
  assert.match(installationId, /^[a-f0-9-]{36}$/);
  for (const kind of ["container", "network", "volume"]) {
    const ids = (
      await docker([
        kind,
        "ls",
        "-q",
        ...(kind === "container" ? ["-a"] : []),
        "--filter",
        `label=${label}=${installationId}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const [resource] = JSON.parse(await docker([kind, "inspect", id]));
      assert.equal(
        (resource.Config?.Labels ?? resource.Labels)?.[label],
        installationId,
        "Cleanup requires the exact fresh installation label",
      );
      await docker([kind, "rm", ...(kind === "container" ? ["-f"] : []), id]);
    }
  }
}

try {
  mkdirSync(isolatedHome, { recursive: true });
  // Resolve only the Docker transport. No Docker registry or model credentials
  // are copied into the isolated control process or project containers.
  const endpoint =
    process.env.DOCKER_HOST ||
    (await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      env: process.env,
    }));
  assert.ok(
    endpoint.startsWith("unix://") || endpoint.startsWith("npipe://"),
    "This smoke requires a local Docker daemon",
  );
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODE_SHELL_HOME: join(isolatedHome, ".code-shell"),
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_DATA_HOME: join(isolatedHome, ".local/share"),
    NODE_ENV: "production",
    DISABLE_AUTOUPDATER: "1",
    DOCKER_HOST: endpoint,
  });
  dockerEnv = env;
  await docker(["image", "inspect", image]);
  child = spawn(
    process.execPath,
    [
      entry,
      "--auth",
      "hub",
      "--runtime",
      "docker",
      "--runtime-image",
      image,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      dataDir,
    ],
    { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("error", (error) => (logs += String(error)));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => (logs = (logs + data).slice(-60_000)));
  await waitUntil(
    () => {
      if (child.exitCode !== null)
        throw new Error(`Control CLI exited (${child.exitCode}): ${logs}`);
      serverUrl = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      return serverUrl && /#setup=[A-Za-z0-9_-]+/.test(logs);
    },
    "Docker control CLI startup",
    25_000,
  );
  installationId = JSON.parse(
    readFileSync(join(dataDir, "project-control/registry.json"), "utf8"),
  ).installationId;
  const login = await request("/api/v1/auth/setup", {
    method: "POST",
    anonymous: true,
    body: { token: /#setup=([A-Za-z0-9_-]+)/.exec(logs)[1], username: "smoke-admin", password },
  });
  assert.equal(login.status, 200, await login.text());
  cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("cs_hub_session="));
  assert.deepEqual(await json("/health"), {
    status: "ok",
    mode: "project-sandbox",
    runtime: "docker",
  });
  const create = async (name) =>
    (await json("/api/v1/projects", { method: "POST", body: { name } }, 201)).project;
  const a = await create("Sandbox smoke A");
  const b = await create("Sandbox smoke B");
  const start = async (id) =>
    (await json(`/api/v1/projects/${id}/start`, { method: "POST", body: {} })).project;
  const runningA = await start(a.id);
  await start(b.id);
  const containerA = `codeshell-${installationId}-${a.id}`;
  const containerB = `codeshell-${installationId}-${b.id}`;
  for (const container of [containerA, containerB]) await installFixture(container);
  console.log(
    "PASS: native control CLI, administrator setup, two real Docker runtimes, isolated loopback models",
  );

  const prefixA = `/p/${a.id}`;
  const snapshot = await json(prefixA + "/api/v1/panels");
  const panel = snapshot.panels.find((item) => item.id === "project-smoke-panel");
  assert.ok(panel?.compatibility.supported);
  const bound = await json(prefixA + `/api/v1/panels/${panel.id}/binding`, {
    method: "PATCH",
    body: { bound: true, expectedRevision: panel.revision },
  });
  const revision = bound.panels.find((item) => item.id === panel.id).revision;
  const grant = await json(prefixA + "/api/v1/panels/runtime/prepare", {
    method: "POST",
    body: { appId: panel.id, revision, sessionId: "smoke-project-main" },
  });
  assert.ok(grant.context.availableMethods.includes("agent.task.start"));
  const asset = await request(prefixA + grant.src, { anonymous: true, origin: "null" });
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).includes("Project smoke panel"));
  assert.ok(
    [404, 410].includes(
      (await request(`/p/${b.id}` + grant.src, { anonymous: true, origin: "null" })).status,
    ),
  );
  const host = panelHarness(a.id, grant);
  const executable = await host.call("process.find", { name: "node" });
  assert.equal(executable.available, true);
  const directory = await host.call("filesystem.getKnownDirectory", { name: "downloads" });
  assert.equal(directory.path, "/workspace/downloads");
  const processTask = await host.finish(
    host.call("process.spawn", {
      executableHandle: executable.handle,
      directoryHandle: directory.handle,
      args: [
        "-e",
        `require("node:fs").writeFileSync("shared-proof.txt", ${JSON.stringify(processProof)}); process.stdout.write("panel process finished")`,
      ],
    }),
  );
  await waitUntil(async () => {
    await host.poll();
    return host.events.some(
      (event) =>
        event.event === "process.exit" &&
        event.payload.processId === processTask.processId &&
        event.payload.code === 0,
    );
  }, "panel process exit");
  assert.ok(
    host.events.some(
      (event) =>
        event.event === "process.output" && event.payload.text.includes("panel process finished"),
    ),
  );
  const download = () =>
    request(prefixA + "/api/v1/files/content?path=downloads%2Fshared-proof.txt");
  assert.equal(await (await download()).text(), processProof);
  console.log(
    "PASS: opaque panel asset capability and approved panel process write the project volume",
  );

  const rpcA = await connect(a.id);
  const rpcB = await connect(b.id);
  const main = rpcA.request("agent/run", {
    sessionId: "smoke-project-main",
    task: "SMOKE_MAIN_RW: read and update the shared proof file.",
  });
  void main.catch(() => {});
  const approval = await waitUntil(
    () =>
      rpcA.messages.find(
        (m) => m.method === "agent/approvalRequest" && m.params.sessionId === "smoke-project-main",
      ),
    "real main-agent Write approval",
  );
  assert.equal(await (await download()).text(), processProof, "Write must wait for approval");
  await rpcA.request("serve/approval.claim", { requestId: approval.params.requestId });
  await rpcA.request("agent/approve", {
    sessionId: "smoke-project-main",
    requestId: approval.params.requestId,
    decision: { approved: true },
  });
  assert.equal((await main).reason, "completed");
  assert.equal(await (await download()).text(), mainProof);
  assert.ok(rpcA.text("smoke-project-main").includes("Read and Write completed"));
  console.log(
    "PASS: proxied WebSocket runs the real Core Read and approved Write in the same container volume",
  );

  const models = await host.call("agent.task.models");
  assert.ok(models.models.some((model) => model.id === "project-fixture"));
  const approvalsBeforeTask = host.approved.size;
  const task = await host.finish(
    host.call("agent.task.start", {
      label: "Smoke shared file",
      prompt: "SMOKE_PANEL_RW: read and update the shared proof file.",
      toolNames: ["Read", "Write"],
      maxTurns: 4,
    }),
  );
  const result = await waitUntil(async () => {
    await host.poll();
    const current = await host.call("agent.task.get", { id: task.id });
    if (current.status === "failed" || current.status === "cancelled")
      throw new Error(JSON.stringify(current));
    return current.status === "completed" ? current : false;
  }, "independent panel Core task");
  assert.ok(
    host.approved.size >= approvalsBeforeTask + 2,
    "Panel Write requires its own trusted tool confirmation",
  );
  assert.ok(result.result.text.includes("Read and Write completed"));
  const downloaded = await download();
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition"), /attachment/);
  assert.equal(await downloaded.text(), taskProof);
  assert.equal(
    await docker([
      "exec",
      containerA,
      "node",
      "-e",
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(proofPath)}, "utf8"))`,
    ]),
    taskProof.trim(),
  );
  console.log(
    "PASS: independently approved panel Core task reads the main Agent's file, writes it, and downloads through HTTP",
  );

  assert.equal(
    (await request(`/p/${b.id}/api/v1/files/content?path=downloads%2Fshared-proof.txt`)).status,
    404,
  );
  assert.equal(
    await docker([
      "exec",
      containerB,
      "node",
      "-e",
      `process.stdout.write(String(require("node:fs").existsSync(${JSON.stringify(proofPath)})))`,
    ]),
    "false",
  );
  const bSessions = await rpcB.request("agent/query", { type: "sessions" });
  assert.ok(!bSessions.data.some((session) => session.sessionId === "smoke-project-main"));
  assert.equal(
    (
      await rpcB.request("agent/run", {
        sessionId: "smoke-project-b",
        task: "SMOKE_B: reply from this separate project.",
      })
    ).reason,
    "completed",
  );
  assert.ok(rpcB.text("smoke-project-b").includes("Isolated project model replied"));
  console.log(
    "PASS: second project has its own real worker and cannot read the first project's file or session",
  );

  await json(`/api/v1/projects/${a.id}/stop`, { method: "POST", body: {} });
  await waitUntil(() => rpcA.ws.readyState === WebSocket.CLOSED, "project stop closes its socket");
  const restarted = await start(a.id);
  assert.equal(restarted.generation, runningA.generation + 1);
  assert.equal(
    await (await download()).text(),
    taskProof,
    "Restart must retain the workspace volume",
  );
  assert.ok(
    [404, 410].includes(
      (await request(prefixA + grant.src, { anonymous: true, origin: "null" })).status,
    ),
  );
  assert.ok(
    [404, 410].includes(
      (await request(host.base + "/call", { method: "POST", body: { method: "context.get" } }))
        .status,
    ),
  );
  const restored = await connect(a.id);
  const sessions = await restored.request("agent/query", { type: "sessions" });
  assert.ok(sessions.data.some((session) => session.sessionId === "smoke-project-main"));
  assert.equal((await json(`/p/${b.id}/api/v1/files`)).path, "");
  console.log(
    "PASS: stop/restart preserves project files and conversations, changes generation, and rejects old panel grants",
  );
  success = true;
  console.log(
    "Real Docker sandbox smoke passed. No external model service or real account key was used.",
  );
} catch (error) {
  console.error(`Docker sandbox smoke failed: ${error.stack ?? error}`);
  console.error(JSON.stringify(lastRpc?.messages.slice(-8) ?? []).slice(-10_000));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  // Recover only this scratch registry's random identity if startup failed early.
  const registryPath = join(dataDir, "project-control/registry.json");
  if (!installationId && existsSync(registryPath))
    installationId = JSON.parse(readFileSync(registryPath, "utf8")).installationId;
  if (!success && installationId) {
    for (const id of (
      await docker([
        "container",
        "ls",
        "-aq",
        "--filter",
        `label=${label}=${installationId}`,
      ]).catch(() => "")
    )
      .split(/\s+/)
      .filter(Boolean)) {
      writeFileSync(join(scratch, `${id}-container.log`), await docker(["logs", id]).catch(String));
      const diagnostics = await docker([
        "exec",
        id,
        "node",
        "-e",
        `
        const fs = require("node:fs");
        const result = {};
        for (const name of ["model-errors.log", "model-output.log", "model-requests.jsonl"]) {
          try { result[name] = fs.readFileSync("/workspace/" + name, "utf8").slice(-60000); }
          catch { result[name] = "unavailable"; }
        }
        process.stdout.write(JSON.stringify(result));
      `,
      ]).catch(String);
      writeFileSync(join(scratch, `${id}-fixture.log`), diagnostics);
    }
  }
  await stopControl().catch((error) => {
    success = false;
    process.exitCode = 1;
    console.error(String(error));
  });
  await cleanupDocker().catch((error) => {
    success = false;
    process.exitCode = 1;
    console.error(`Cleanup failed: ${error}`);
  });
  if (success) rmSync(scratch, { recursive: true, force: true });
  else {
    writeFileSync(
      join(scratch, "control.log"),
      logs.replace(/#setup=[A-Za-z0-9_-]+/g, "#setup=[redacted]"),
    );
    console.error(`Smoke logs retained at ${scratch}`);
  }
}
