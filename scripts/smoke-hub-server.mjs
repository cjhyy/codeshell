/**
 * Native Node deployment check against the built CLI and the real Core worker.
 * The only model endpoint is an in-process loopback fixture. All settings,
 * credentials, sessions and tool writes are confined to a fresh temporary tree.
 * Run `bun run build:server` first, then `node scripts/smoke-hub-server.mjs`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages/server/dist/bin/code-shell-serve.js");
assert.ok(existsSync(entry), "Build the server first: bun run build:server");
const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const { WebSocket } = require("ws");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-hub-smoke-")));
const workspace = join(scratch, "workspace");
const dataDir = join(scratch, "data");
const isolatedHome = join(scratch, "home");
const proofFile = join(workspace, "approved.txt");
const fixtureKey = "local-hub-smoke-only";
const password = "local-smoke-password-12345";
const firstReply = "Native Hub streaming completed.";
const resumedReply = "Native Hub resumed the saved conversation.";
const approvalReply = "The approved write completed.";
const modelRequests = [];
const sockets = new Set();
const processes = new Set();
let lastLogs = "";
let lastRpc;

function chunk(model, delta, finishReason = null) {
  return {
    id: "chatcmpl-hub-native-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(res, item) {
  res.write(`data: ${JSON.stringify(item)}\n\n`);
}

const modelServer = createServer((req, res) => {
  void (async () => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`);
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    assert.equal(body.stream, true);
    modelRequests.push(body);
    const messages = body.messages ?? [];
    const userIndex = messages.findLastIndex(
      (message) => message.role === "user" && JSON.stringify(message.content).includes("SMOKE_"),
    );
    const task = JSON.stringify(messages[userIndex]?.content ?? "");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (task.includes("SMOKE_CANCEL")) {
      sse(res, chunk(body.model, { role: "assistant", content: "Waiting for cancellation." }));
      // Keep the stream open so agent/cancel must abort an actual model request.
      return;
    }
    if (
      task.includes("SMOKE_APPROVAL") &&
      !messages.slice(userIndex).some((m) => m.role === "tool")
    ) {
      sse(
        res,
        chunk(body.model, {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_hub_smoke_write",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: proofFile, content: "approved by Hub\n" }),
              },
            },
          ],
        }),
      );
      sse(res, chunk(body.model, {}, "tool_calls"));
    } else {
      const reply = task.includes("SMOKE_RESUME")
        ? resumedReply
        : task.includes("SMOKE_APPROVAL")
          ? approvalReply
          : firstReply;
      const split = Math.floor(reply.length / 2);
      sse(res, chunk(body.model, { role: "assistant", content: reply.slice(0, split) }));
      sse(res, chunk(body.model, { content: reply.slice(split) }));
      sse(res, chunk(body.model, {}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  })().catch((error) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  });
});

class RpcClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.waiters = new Set();
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
      for (const waiter of this.waiters) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    });
    ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket closed before RPC completion"));
      }
      this.pending.clear();
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("WebSocket closed before notification"));
      }
      this.waiters.clear();
    });
    ws.on("error", () => {});
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  waitFor(predicate, label) {
    const seen = this.messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Notification timed out: ${label}`));
      }, 30_000);
      this.waiters.add(waiter);
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

async function boot() {
  const needsSetup = !existsSync(join(dataDir, "hub/auth.json"));
  // Do not inherit user API keys, Node preload hooks, proxy settings or tool configuration.
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
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODE_SHELL_HOME: join(isolatedHome, ".code-shell"),
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_DATA_HOME: join(isolatedHome, ".local/share"),
    NODE_ENV: "production",
    DISABLE_AUTOUPDATER: "1",
  });
  const child = spawn(
    process.execPath,
    [
      entry,
      "--auth",
      "hub",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--cwd",
      workspace,
      "--data-dir",
      dataDir,
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  processes.add(child);
  let logs = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Node Hub startup timed out")), 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      processes.delete(child);
      clearTimeout(timer);
      reject(new Error(`Node Hub exited during startup (${code})`));
    });
    const receive = (data) => {
      logs = (logs + data).slice(-30_000);
      lastLogs = logs;
      const url = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      if (url && (!needsSetup || /#setup=[A-Za-z0-9_-]+/.test(logs))) {
        clearTimeout(timer);
        resolve({ child, url, logs: () => logs });
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
  });
  const server = await ready;
  assert.deepEqual(await (await fetch(`${server.url}/health`)).json(), {
    status: "ok",
    mode: "hub",
  });
  return server;
}

async function stop(child) {
  if (!processes.has(child)) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => {
    if (process.platform === "win32") child.kill("SIGKILL");
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }, 10_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function connect(server, cookie) {
  const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`, {
    headers: { cookie, origin: server.url },
  });
  sockets.add(ws);
  const rpc = new RpcClient(ws);
  lastRpc = rpc;
  await once(ws, "open");
  return rpc;
}

async function auth(server, action, body) {
  const response = await fetch(`${server.url}/api/v1/auth/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${action}: ${await response.text()}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("cs_hub_session="));
  return cookie;
}

try {
  for (const dir of [join(workspace, ".code-shell"), isolatedHome, dataDir])
    mkdirSync(dir, { recursive: true });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const modelPort = modelServer.address().port;
  const settings = JSON.parse(readFileSync(join(root, "deploy/settings.example.json"), "utf8"));
  settings.credentials[0].apiKey = fixtureKey;
  settings.credentials[0].baseUrl = `http://127.0.0.1:${modelPort}/v1`;
  settings.modelConnections[0].model = "gpt-4o-mini";
  settings.permissions.rules = [{ tool: "Write", decision: "ask" }];
  writeFileSync(join(workspace, ".code-shell/settings.local.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  const skillDir = join(workspace, ".code-shell/skills/deployment-smoke");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: deployment-smoke\ndescription: HUB_SKILL_DISCOVERY_MARKER\n---\nUse the local fixture.\n",
  );

  let server = await boot();
  const token = /#setup=([A-Za-z0-9_-]+)/.exec(server.logs())?.[1];
  assert.ok(token, "First launch must print an administrator initialization link");
  const cookie = await auth(server, "setup", { token, username: "smoke-admin", password });
  const shell = await fetch(server.url);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<script[^>]*src=.*assets\//);
  let rpc = await connect(server, cookie);
  console.log("PASS: Node CLI, Web build, health, administrator setup and authenticated WebSocket");

  const sessionId = "hub-smoke-stream";
  const result = await rpc.request("agent/run", {
    sessionId,
    task: "SMOKE_STREAM: reply briefly.",
  });
  assert.equal(result.reason, "completed");
  assert.equal(rpc.text(sessionId), firstReply);
  const detail = await rpc.request("agent/query", { type: "session_detail", sessionId });
  assert.ok(JSON.stringify(detail.data.transcript).includes(firstReply));
  assert.ok(existsSync(join(dataDir, "worker/sessions", sessionId, "state.json")));
  console.log("PASS: real Core worker, local model SSE, streamed reply and persisted transcript");

  assert.ok(JSON.stringify(modelRequests.at(-1).messages).includes("HUB_SKILL_DISCOVERY_MARKER"));
  const configure = async (section, body) => {
    const response = await fetch(`${server.url}/api/v1/configuration/${section}`, {
      method: "PUT",
      headers: { cookie, origin: server.url, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const snapshot = await response.json();
    assert.equal(response.status, 200, JSON.stringify(snapshot));
    assert.ok(
      !JSON.stringify(snapshot).includes(fixtureKey),
      "Configuration must not return credentials",
    );
    return snapshot;
  };
  const changedSkills = await configure("skills", { name: "deployment-smoke", enabled: false });
  assert.equal(
    changedSkills.skills.find((skill) => skill.name === "deployment-smoke").enabled,
    false,
  );
  await configure("connections", {
    id: settings.modelConnections[0].id,
    catalogId: "openai",
    model: "gpt-4o",
  });
  await rpc.request("agent/run", {
    sessionId,
    task: "SMOKE_SETTINGS: reply briefly.",
  });
  assert.equal(modelRequests.at(-1).model, "gpt-4o");
  assert.ok(!JSON.stringify(modelRequests.at(-1).messages).includes("HUB_SKILL_DISCOVERY_MARKER"));
  console.log(
    "PASS: Web settings change the real worker model and Skill prompt in the same existing session without restarting",
  );

  const approvalSession = "hub-smoke-approval";
  const approvedRun = rpc.request("agent/run", {
    sessionId: approvalSession,
    task: "SMOKE_APPROVAL: write the requested fixture.",
  });
  void approvedRun.catch(() => {});
  const approval = await rpc.waitFor(
    (m) => m.method === "agent/approvalRequest" && m.params.sessionId === approvalSession,
    "tool approval",
  );
  assert.equal(existsSync(proofFile), false, "Write must wait for approval");
  await rpc.request("serve/approval.claim", { requestId: approval.params.requestId });
  await rpc.request("agent/approve", {
    sessionId: approvalSession,
    requestId: approval.params.requestId,
    decision: { approved: true },
  });
  assert.equal((await approvedRun).reason, "completed");
  assert.equal(readFileSync(proofFile, "utf8"), "approved by Hub\n");
  assert.equal(rpc.text(approvalSession), approvalReply);
  console.log(
    "PASS: tool waits for a Hub approval lease, then writes only the temporary workspace",
  );

  const cancelSession = "hub-smoke-cancel";
  const cancelRequestId = rpc.nextId;
  const cancelledRun = rpc.request("agent/run", {
    sessionId: cancelSession,
    task: "SMOKE_CANCEL: stream until stopped.",
    clientMessageId: "smoke-cancel-client-message",
  });
  void cancelledRun.catch(() => {});
  await rpc.waitFor(
    (m) =>
      m.method === "agent/streamEvent" &&
      m.params.sessionId === cancelSession &&
      m.params.event.type === "text_delta",
    "stream before cancellation",
  );
  const accepted = await rpc.waitFor(
    (message) =>
      message.method === "agent/runAccepted" && message.params.sessionId === cancelSession,
    "mapped run acceptance",
  );
  assert.equal(accepted.params.requestId, cancelRequestId);
  const viewer = await connect(server, cookie);
  const activeSnapshot = await viewer.request("agent/query", {
    type: "session_detail",
    sessionId: cancelSession,
  });
  assert.equal(activeSnapshot.data.running, true);
  assert.equal(activeSnapshot.data.liveStream.truncated, false);
  const recovered = activeSnapshot.data.liveStream.events;
  assert.equal(recovered.filter(({ event }) => event.type === "session_user_message").length, 1);
  assert.ok(recovered.some(({ event }) => event.clientMessageId === "smoke-cancel-client-message"));
  assert.equal(
    recovered
      .filter(({ event }) => event.type === "text_delta")
      .map(({ event }) => event.text)
      .join(""),
    "Waiting for cancellation.",
  );
  assert.ok(
    recovered.every(({ sequence }) => sequence <= activeSnapshot.data.streamCursor.sequence),
  );
  assert.ok(
    !JSON.stringify(activeSnapshot.data.transcript).includes("SMOKE_CANCEL"),
    "Active-run user turn must appear only in the live overlay",
  );
  viewer.ws.close();
  console.log(
    "PASS: a fresh browser recovers the active run's user message and unpersisted text without duplicate durable events",
  );
  assert.equal((await rpc.request("agent/cancel", { sessionId: cancelSession })).ok, true);
  assert.equal((await cancelledRun).reason, "aborted_streaming");
  console.log("PASS: stop interrupts an active model stream");

  const sessionPatch = async (body) => {
    const response = await fetch(`${server.url}/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { cookie, origin: server.url, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await sessionPatch({ title: "Smoke deployment conversation" });
  const exported = await fetch(`${server.url}/api/v1/sessions/${sessionId}/export`, {
    headers: { cookie },
  });
  assert.equal(exported.status, 200);
  assert.ok((await exported.text()).includes(firstReply));
  await sessionPatch({ archived: true });
  const hidden = await rpc.request("agent/query", { type: "sessions" });
  assert.ok(!hidden.data.some((session) => session.sessionId === sessionId));
  await sessionPatch({ archived: false });
  console.log("PASS: rename, Markdown export, archive and restore operate on real saved sessions");

  rpc.ws.close();
  await stop(server.child);
  server = await boot();
  assert.doesNotMatch(server.logs(), /#setup=/, "Restart must retain the initialized account");
  const savedStatus = await fetch(`${server.url}/api/v1/auth/status`, { headers: { cookie } });
  assert.equal((await savedStatus.json()).authenticated, true);
  const loginCookie = await auth(server, "login", { username: "smoke-admin", password });
  rpc = await connect(server, loginCookie);
  const sessions = await rpc.request("agent/query", { type: "sessions" });
  assert.ok(sessions.data.some((session) => session.sessionId === sessionId));
  const restored = await rpc.request("agent/query", { type: "session_detail", sessionId });
  assert.ok(JSON.stringify(restored.data.transcript).includes(firstReply));
  assert.equal(
    (
      await rpc.request("agent/run", {
        sessionId,
        task: "SMOKE_RESUME: continue the saved conversation.",
      })
    ).reason,
    "completed",
  );
  assert.equal(rpc.text(sessionId), resumedReply);
  const resumeRequest = modelRequests.findLast((body) =>
    JSON.stringify(body.messages).includes("SMOKE_RESUME"),
  );
  assert.ok(
    JSON.stringify(resumeRequest.messages).includes(firstReply),
    "Resumed model request must include saved history",
  );
  console.log(
    "PASS: restart preserves administrator, login sessions and conversation history; real Worker resumes it",
  );
  console.log("Native Hub deployment smoke passed. No external model service was used.");
} catch (error) {
  console.error(`Native Hub deployment smoke failed: ${error.stack ?? error}`);
  console.error(JSON.stringify(lastRpc?.messages.slice(-12)).slice(-10_000));
  console.error(lastLogs.replace(/#setup=[A-Za-z0-9_-]+/g, "#setup=[redacted]"));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  await Promise.all([...processes].map(stop));
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
