import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { candidateHash } from "../docker-candidate-guard.mjs";

const { config, guard, children, closed } =
  globalThis[Symbol.for("codeshell.connection-recovery.fixture")];
assert.deepEqual(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")], {
  role: "controller",
  negativeProbes: 6,
  dnsNegativeProbes: 4,
});
const home = config.home,
  repo = config.repo,
  workspace = config.worker.cwd;
const nativeWebSocket = guard.WebSocket;
const sockets = new Set(),
  peers = new Set(),
  listeners = new Set();
const results = {
  runFrames: 0,
  approvalFrames: 0,
  queryFrames: 0,
  modelRequests: 0,
  frontendConnections: 0,
  snapshotFrames: 0,
};
const notifications = [];
let interrupted = false;
const step = (name) => console.log(JSON.stringify({ connectionRecoveryStep: name }));
const wait = async (read, label, cleaning = false) => {
  const until = Date.now() + 15_000;
  while (!read()) {
    if (interrupted && !cleaning) throw new Error("Connection recovery fixture interrupted");
    if (Date.now() >= until) throw new Error(`Connection recovery fixture: ${label}`);
    await sleep(5);
  }
  return read();
};
function track(server) {
  listeners.add(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.once("close", () => listeners.delete(server));
  return server;
}
let heldResponse, releaseModel;
const modelReleased = new Promise((resolve) => {
  releaseModel = resolve;
});
const proofFile = join(workspace, "approved-once.txt");
const model = track(
  http.createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer synthetic-connection-recovery");
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.stream, true);
      results.modelRequests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      const afterWrite = body.messages.some(
        (m) => m.role === "tool" && m.tool_call_id === "connection-write",
      );
      if (!afterWrite) {
        const active = body.tools.some((t) => t.function.name === "Write");
        if (!active) assert.ok(body.tools.some((t) => t.function.name === "ToolSearch"));
        send(
          {
            role: "assistant",
            content: "durable before approval\n",
            tool_calls: [
              {
                index: 0,
                id: active ? "connection-write" : "connection-discover-write",
                type: "function",
                function: {
                  name: active ? "Write" : "ToolSearch",
                  arguments: JSON.stringify(
                    active
                      ? { file_path: proofFile, content: "one approved write\n" }
                      : { query: "select:Write" },
                  ),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        send({ role: "assistant", content: "durable while disconnected\n" });
        heldResponse = res;
        await modelReleased;
        send({ content: "durable after reconnect\n" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      res.destroy(error);
    });
  }),
);
let host, front, wss, client, hiddenApproval, recoveredApprovals, resumeFailure;
const interrupt = () => {
  interrupted = true;
  releaseModel();
  client?.close();
};
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
let primary,
  failed = false;
const cleanupErrors = [];
try {
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const modelOrigin = `http://127.0.0.1:${model.address().port}`;
  const workerPolicy = {
    ...config,
    role: "worker",
    origins: [modelOrigin],
    listeners: [],
    children: [],
  };
  writeFileSync(config.workerPolicy, JSON.stringify(workerPolicy), { mode: 0o600 });
  process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG = config.workerPolicy;
  process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH = candidateHash(
    readFileSync(config.workerPolicy),
  );
  mkdirSync(join(workspace, ".code-shell"), { mode: 0o700 });
  writeFileSync(
    join(workspace, ".code-shell/settings.local.json"),
    JSON.stringify({
      credentials: [
        {
          id: "local",
          catalogId: "openai",
          apiKey: "synthetic-connection-recovery",
          baseUrl: modelOrigin + "/v1",
        },
      ],
      modelConnections: [
        { id: "local", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "local" },
      ],
      defaults: { text: "local" },
      permissions: { rules: [{ tool: "Write", decision: "ask" }] },
      autoUpdates: false,
    }),
    { mode: 0o600 },
  );
  // The real Server, Core and worker enter only after the guard's 6+4 probes.
  const { startHeadlessServer } = await import(
    pathToFileURL(join(repo, "packages/server/dist/index.serve.js"))
  );
  const { applyOutputJournalPage, compareOutputCursors } = await import(
    pathToFileURL(join(repo, "packages/web/dist/index.js"))
  );
  host = await startHeadlessServer({
    cwd: workspace,
    dataDir: join(home, "data"),
    authMode: "hub",
    port: 0,
    workerEntryPath: config.worker.entry,
    execPath: config.worker.node,
    workerCapabilityModules: "",
  });
  const setup = await fetch(host.url + "/api/v1/auth/setup", {
    method: "POST",
    headers: { origin: host.url, "content-type": "application/json" },
    body: JSON.stringify({
      token: host.bootstrapToken,
      username: "fixture",
      password: "synthetic-password-12345",
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  front = track(
    http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    }),
  );
  wss = new nativeWebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
  front.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/ws");
    wss.handleUpgrade(req, socket, head, (peer) => {
      results.frontendConnections++;
      const ordinal = results.frontendConnections;
      peers.add(peer);
      peer.once("close", () => peers.delete(peer));
      const upstream = new nativeWebSocket(host.url.replace("http:", "ws:") + "/ws", {
        followRedirects: false,
        headers: { cookie, origin: host.url },
      });
      peers.add(upstream);
      upstream.once("close", () => peers.delete(upstream));
      let blackhole = false;
      const queue = [];
      upstream.on("open", () => {
        for (const raw of queue.splice(0)) upstream.send(raw);
      });
      upstream.on("message", (bytes) => {
        const message = JSON.parse(bytes);
        if (ordinal === 1 && message.method === "agent/approvalRequest") {
          hiddenApproval = message.params;
          return;
        }
        if (!blackhole && peer.readyState === peer.OPEN) peer.send(bytes.toString());
      });
      peer.on("message", (bytes) => {
        const raw = bytes.toString(),
          message = JSON.parse(raw);
        if (message.method === "agent/run") results.runFrames++;
        if (message.method === "agent/query") results.queryFrames++;
        if (message.method === "agent/approve") results.approvalFrames++;
        if (message.method === "serve/approval.snapshot") results.snapshotFrames++;
        if (blackhole) return;
        if (upstream.readyState === upstream.OPEN) upstream.send(raw);
        else {
          assert.ok(queue.length < 16);
          queue.push(raw);
        }
        // Forward the original approval once, then lose its ACK and all traffic
        // on this still-OPEN frontend. The real worker and Run keep executing.
        if (ordinal === 1 && message.method === "agent/approve") blackhole = true;
      });
      peer.on("close", () => upstream.close());
      upstream.on("error", () => peer.close());
      peer.on("error", () => upstream.close());
    });
  });
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  const origin = `http://127.0.0.1:${front.address().port}`;
  globalThis.WebSocket = nativeWebSocket;
  globalThis.window = new globalThis.EventTarget();
  // Transform actual unmodified browser source, without a bundler or mirror.
  const folder = join(home, "browser");
  mkdirSync(folder, { mode: 0o700 });
  mkdirSync(join(folder, "app"), { mode: 0o700 });
  mkdirSync(join(folder, "src"), { mode: 0o700 });
  mkdirSync(join(folder, "src/lib"), { mode: 0o700 });
  writeFileSync(join(folder, "package.json"), '{"type":"module"}', { mode: 0o600 });
  const sourceHashes = {};
  for (const relative of [
    "app/protocol.ts",
    "app/api-context.ts",
    "src/lib/connectionLiveness.ts",
  ]) {
    const source = readFileSync(join(repo, "packages/web", relative));
    sourceHashes[relative] = candidateHash(source);
    writeFileSync(
      join(folder, relative.replace(/\.ts$/, ".js")),
      stripTypeScriptTypes(source.toString(), { mode: "transform" }),
      { mode: 0o600 },
    );
  }
  const { ProtocolClient } = await import(pathToFileURL(join(folder, "app/protocol.js")));
  client = new ProtocolClient(origin.replace("http:", "ws:") + "/ws");
  const states = [];
  client.onStateChange((state) => states.push(state));
  client.onNotification((method, params) => {
    assert.ok(notifications.length < 1024);
    notifications.push({ method, params });
  });
  client.onResync(() => {
    void client.approvalSnapshot().then(
      (snapshot) => {
        recoveredApprovals = snapshot;
      },
      (error) => {
        resumeFailure = error;
      },
    );
  });
  client.connect();
  await wait(() => states.at(-1) === "open", "initial open");
  const sessionId = "connection-recovery-session";
  const run = client
    .run({
      sessionId,
      task: "SYNTHETIC_HALF_OPEN: write once after approval.",
      clientMessageId: "one-original-message",
    })
    .catch((error) => error);
  const approval = await wait(
    () => hiddenApproval,
    "real Core pending approval hidden in background",
  );
  assert.equal(existsSync(proofFile), false);
  assert.equal(
    notifications.some((m) => m.method === "agent/approvalRequest"),
    false,
  );
  const claimed = await client.request("serve/approval.claim", { requestId: approval.requestId });
  globalThis.window.dispatchEvent(new globalThis.Event("focus"));
  await wait(() => {
    if (resumeFailure) throw resumeFailure;
    return recoveredApprovals;
  }, "foreground read-only approval snapshot");
  assert.deepEqual(
    recoveredApprovals.approvals.map((item) => item.requestId),
    [approval.requestId],
  );
  assert.deepEqual(recoveredApprovals.leases, [claimed]);
  assert.equal(results.frontendConnections, 1);
  assert.equal(results.snapshotFrames, 1);
  results.pendingApprovalRecoveredOnSameSocket = true;
  step("same-OPEN-foreground-restores-pending-approval-and-lease");
  const cursor = await wait(
    () =>
      notifications.find((m) => m.method === "agent/streamEvent" && m.params.event.outputCursor)
        ?.params.event.outputCursor,
    "published durable cursor",
  );
  const decision = client.approve(recoveredApprovals.approvals[0], true).catch((error) => error);
  await wait(() => heldResponse && existsSync(proofFile), "approved Write and active model stream");
  assert.equal(readFileSync(proofFile, "utf8"), "one approved write\n");
  globalThis.window.dispatchEvent(new globalThis.Event("focus"));
  await wait(() => states.includes("closed"), "half-open detection");
  assert.equal((await run).kind, "transport");
  assert.equal((await decision).kind, "transport");
  await wait(() => results.frontendConnections === 2 && states.at(-1) === "open", "one redial");
  step("actual-Run-and-submitted-approval-survive-half-open");
  const snapshot = await client.sessionDetail(sessionId, true);
  assert.equal(snapshot.data.running, true);
  assert.equal(snapshot.data.outputCoverage.unpaired, false);
  assert.equal(compareOutputCursors(snapshot.data.outputCoverage.outputCursor, cursor) >= 0, true);
  const page = await client.outputJournal(sessionId, { after: cursor });
  const recovery = { cursor, appliedCursor: cursor, incomplete: false };
  const recovered = [];
  assert.equal(
    applyOutputJournalPage(recovery, page.data, (event) => recovered.push(event)),
    true,
  );
  assert.ok(
    recovered.some(
      (event) => event.type === "text_delta" && event.text.includes("durable while disconnected"),
    ),
  );
  assert.ok(
    notifications.some(
      (m) => m.method === "serve/approvalSnapshot" && m.params.approvals.length === 0,
    ),
  );
  const oldClaim = await client
    .request("serve/approval.claim", { requestId: approval.requestId })
    .catch((e) => e);
  assert.equal(oldClaim.kind, "response");
  assert.equal(results.runFrames, 1);
  assert.equal(results.approvalFrames, 1);
  releaseModel();
  await wait(
    () =>
      notifications.some(
        (m) =>
          m.method === "serve/sessionStatus" &&
          m.params.sessionId === sessionId &&
          m.params.running === false,
      ),
    "original Run completed",
  );
  const final = await client.sessionDetail(sessionId, true);
  assert.equal(final.data.running, false);
  assert.equal(final.data.outputCoverage.unpaired, false);
  // Coverage inputIds tracks unpublished inputs, rather than all durable user
  // messages. The actual journal below proves the original input exactly once.
  const full = { incomplete: false },
    events = [];
  assert.equal(
    applyOutputJournalPage(full, final.data.outputJournal, (event) => events.push(event)),
    true,
  );
  assert.ok(
    events.some(
      (event) => event.type === "text_delta" && event.text.includes("durable after reconnect"),
    ),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "session_user_message" && event.clientMessageId === "one-original-message",
    ).length,
    1,
  );
  assert.equal(readFileSync(proofFile, "utf8"), "one approved write\n");
  results.sourceHashes = sourceHashes;
  results.cursorIdentityPreserved = true;
  results.originalRunCompleted = true;
  results.originalSubmittedApprovalExecutedOnce = true;
  step("same-input-and-journal-cursor-recovered-without-repeating-writes");
} catch (error) {
  failed = true;
  primary = error;
} finally {
  releaseModel();
  try {
    client?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const peer of peers)
    try {
      peer.terminate();
    } catch (error) {
      cleanupErrors.push(error);
    }
  try {
    await host?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const socket of sockets)
    try {
      socket.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
  if (wss)
    try {
      await new Promise((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  for (const server of [...listeners])
    try {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  try {
    await wait(() => children.size === 0, "captured worker close", true);
    await wait(() => sockets.size === 0 && peers.size === 0, "captured socket close", true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const receipt = {
    passed: !failed && !interrupted && cleanupErrors.length === 0 && listeners.size === 0,
    ...results,
    cleanup: {
      children: children.size,
      sockets: sockets.size,
      peers: peers.size,
      listeners: listeners.size,
      errors: cleanupErrors.length,
      closed,
    },
    actualServerCore: true,
    physicalPhone: false,
    provider: "owned synthetic loopback SSE only",
  };
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
  try {
    writeFileSync(join(home, "result.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (cleanupErrors.length)
  throw new AggregateError(
    [...(failed ? [primary] : []), ...cleanupErrors],
    "Connection recovery cleanup failed",
    { cause: primary },
  );
if (failed) throw primary;
