import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  confinedWorkerEnvironment,
  installLocalNetworkGuard,
} from "./runtime-cost-smoke-isolation.mjs";

const self = fileURLToPath(import.meta.url);
const isolation = new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href;
const children = new Set();
const readLines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
async function guardReceipt(child, env, origin, expectedParent = process.pid) {
  for (let index = 0; index < 150; index++) {
    const receipt = readLines(env.CODESHELL_COST_SMOKE_GUARD_LOG).find(
      (entry) => entry.pid === child.pid,
    );
    if (receipt) {
      assert.equal(receipt.ppid, expectedParent);
      assert.equal(receipt.origin, origin);
      assert.equal(receipt.homeId, createHash("sha256").update(env.HOME).digest("hex"));
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Missing actual worker guard/HOME receipt; stopped before model run");
}
async function stopChildren() {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }),
  );
}

if (process.argv[2] !== "--consume") {
  const root = mkdtempSync(join(tmpdir(), "codeshell-request-proof-"));
  const requestsFile = join(root, "requests.jsonl");
  let requests = 0,
    sdkRetry = false;
  let fixtureFailure;
  const server = createServer((req, res) => {
    void respond(req, res).catch((error) => {
      fixtureFailure = error;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic fixture failed" } }));
    });
  });
  async function respond(req, res) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    appendFileSync(requestsFile, JSON.stringify({ sequence: requests, body }) + "\n", {
      mode: 0o600,
    });
    if (body.model.startsWith("claude")) {
      const message = {
        id: "fixture",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "request proof ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(message));
        return;
      }
      const events = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              ...message,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "request proof ok" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 20 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      res.setHeader("content-type", "text/event-stream");
      res.end(
        events
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          .join(""),
      );
      return;
    }
    if (body.stream && JSON.stringify(body.messages).includes("proof-sdk") && !sdkRetry) {
      sdkRetry = true;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic retry fixture" } }));
      return;
    }
    const response = {
      id: "fixture",
      object: body.stream ? "chat.completion.chunk" : "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          ...(body.stream
            ? { delta: { content: "request proof ok" } }
            : { message: { role: "assistant", content: "request proof ok" } }),
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    if (
      body.stream &&
      JSON.stringify(body.messages).includes("proof-rich") &&
      !body.messages.some((message) => message.role === "tool")
    ) {
      assert.ok(body.tools.some((tool) => tool.function.name === "ListSources"));
      response.choices[0].delta = {
        content: "request proof ok",
        tool_calls: [
          {
            index: 0,
            id: "synthetic-tool-call",
            type: "function",
            function: { name: "ListSources", arguments: "{}" },
          },
          {
            index: 1,
            id: "synthetic-tool-call-two",
            type: "function",
            function: { name: "ListSources", arguments: "{}" },
          },
        ],
      };
      response.choices[0].finish_reason = "tool_calls";
    }
    res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
    res.end(
      body.stream
        ? `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`
        : JSON.stringify(response),
    );
  }
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const origin = new URL(endpoint).origin;
  installLocalNetworkGuard(origin);
  const home = join(root, "empty-home");
  assert.equal(existsSync(home), false);
  mkdirSync(join(home, ".code-shell"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, ".code-shell", "settings.json"),
    JSON.stringify({
      credentials: [
        {
          id: "fixture-key",
          catalogId: "openai",
          apiKey: "synthetic-local-key",
          baseUrl: endpoint,
        },
      ],
      modelConnections: [
        {
          id: "fixture",
          catalogId: "openai",
          tag: "text",
          model: "gpt-4o",
          credentialId: "fixture-key",
        },
      ],
      defaults: { text: "fixture" },
      agent: { preset: "general", maxTurns: 1 },
      session: { storageDir: join(root, "tui-sessions") },
    }),
    { mode: 0o600 },
  );
  const env = {
    ...confinedWorkerEnvironment(process.env, home, origin, isolation),
    CODESHELL_COST_SMOKE_GUARD_LOG: join(root, "guard.jsonl"),
    CODE_SHELL_DATA_ROOT: join(root, "data"),
    AGENT_CWD: root,
    CODE_SHELL_CAPABILITY_MODULES: "",
    CODE_SHELL_DEV: "0",
    CODESHELL_SELF_UPDATE_CHECK: "0",
  };
  let succeeded = false;
  try {
    const child = spawn(process.execPath, [self, "--consume", root, endpoint], {
      cwd: resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "",
      errors = "";
    child.stdout.on("data", (part) => (output += part));
    child.stderr.on("data", (part) => (errors += part));
    await guardReceipt(child, env, origin);
    const [code] = await once(child, "exit");
    children.delete(child);
    if (fixtureFailure) throw fixtureFailure;
    assert.equal(code, 0, errors.slice(-3000));
    const report = JSON.parse(output.trim());
    assert.ok(requests >= 5);
    console.log(JSON.stringify({ ...report, actualFixtureRequests: requests }));
    succeeded = true;
  } finally {
    await stopChildren();
    await new Promise((done) => server.close(done));
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error(`Request proof private fixture retained: ${root}`);
  }
} else {
  const [root, endpoint] = process.argv.slice(3),
    origin = new URL(endpoint).origin;
  const env = process.env;
  assert.equal(env.CODESHELL_COST_SMOKE_ORIGIN, origin);
  // The preload already installed the exact-origin guard and verified HOME.
  await guardReceipt(
    { pid: process.pid, exitCode: null, signalCode: null },
    env,
    origin,
    process.ppid,
  );
  const core = await import("@cjhyy/code-shell-core");
  const host = await import("@cjhyy/code-shell-core/internal");
  const profiles = [
    {
      id: "proof",
      disableSessionTitle: true,
      disableHooks: true,
      disableInstructions: true,
      disableMemoryContext: true,
      disableCapabilityContext: true,
      disableSourcesContext: true,
      disableMcp: true,
    },
  ];
  const engineConfig = {
    llm: { provider: "openai", model: "gpt-4o", apiKey: "synthetic-local-key", baseUrl: endpoint },
    cwd: root,
    sessionStorageDir: join(root, "sdk-sessions"),
    settingsScope: "isolated",
    maxTurns: 4,
    headless: true,
    isSubAgent: true,
    behaviorProfiles: profiles,
  };
  const transcriptEvents = (storage, sid) => readLines(join(storage, sid, "transcript.jsonl"));
  const subject = (storage, sid) => {
    const state = JSON.parse(readFileSync(join(storage, sid, "state.json"), "utf8"));
    return {
      sessionId: sid,
      storageScopeId: state.costState.sessionScopeId,
      sessionInstanceId: state.costState.accountingSessionId,
    };
  };
  const ownerKeys = new host.ModelRequestKeyStore({
    directory: join(env.HOME, ".code-shell", "request-keys", "owner-only-plaintext"),
    cipher: new core.PlaintextCipher(),
    custodyMode: "owner-only-plaintext",
  });
  async function verifyAttempts(storage, sid, signer, marker) {
    const events = transcriptEvents(storage, sid);
    const boundaries = events.filter((event) => event.type === "model_request_boundary");
    const attempts = events.filter((event) => event.type === "model_request_attempt");
    assert.ok(boundaries.length > 0);
    assert.ok(attempts.length >= boundaries.length);
    const bodies = readLines(join(root, "requests.jsonl"))
      .filter((entry) => entry.body.stream && JSON.stringify(entry.body.messages).includes(marker))
      .map((entry) => entry.body);
    assert.equal(bodies.length, attempts.length);
    const expected = [];
    for (const body of bodies) {
      const signatures = await signer.sign({
        subject: subject(storage, sid),
        prehashes: {
          wire: digest(body),
          messages: digest(
            body.model.startsWith("claude")
              ? body.messages
              : body.messages.filter((message) => !["system", "developer"].includes(message.role)),
          ),
          system: digest(
            body.model.startsWith("claude")
              ? (body.system ?? [])
              : body.messages.filter((message) => ["system", "developer"].includes(message.role)),
          ),
        },
      });
      expected.push({
        wire: signatures.digests.wire,
        messages: signatures.digests.messages,
        system: signatures.digests.system,
        tools: digest(body.tools ?? []),
      });
    }
    assert.deepEqual(
      attempts.map((event) => event.data.wireDigest).sort(),
      expected.map((entry) => entry.wire).sort(),
    );
    for (const event of attempts) {
      const actual = expected.find((entry) => entry.wire === event.data.wireDigest);
      assert.equal(event.data.messageDigest, actual.messages);
      assert.equal(event.data.systemPromptDigest, actual.system);
      assert.equal(event.data.toolCatalogDigest, actual.tools);
      const index = events.indexOf(event);
      const boundary = events.findIndex((item) => item.id === event.data.boundaryEventId);
      assert.ok(boundary >= 0 && boundary < index);
      assert.equal(event.data.persistence, "durable");
      assert.equal(event.data.compositionDigest, events[boundary].data.compositionDigest);
    }
    assert.doesNotMatch(
      JSON.stringify([...boundaries, ...attempts]),
      /synthetic-local-key|synthetic-private-hook|proof-(sdk|worker|rich|anthropic|rejected|tui)|request proof ok|data:image/,
    );
    return { boundaries, attempts };
  }
  let sdk = new core.Engine(engineConfig);
  sdk.getHookRegistry().clear();
  const first = await sdk.run("proof-sdk: Return one confirmation", {
    sessionId: "proof-sdk",
    clientMessageId: "sdk-one",
    behaviorMode: "proof",
  });
  assert.equal(first.reason, "completed");
  await sdk.dispose();
  const firstProof = await verifyAttempts(
    engineConfig.sessionStorageDir,
    "proof-sdk",
    ownerKeys,
    "proof-sdk",
  );
  assert.equal(firstProof.boundaries.length, 1);
  assert.equal(firstProof.attempts.length, 2);
  assert.equal(
    firstProof.attempts[0].data.logicalCallId,
    firstProof.attempts[1].data.logicalCallId,
  );
  assert.notEqual(
    firstProof.attempts[0].data.physicalAttemptId,
    firstProof.attempts[1].data.physicalAttemptId,
  );
  sdk = new core.Engine(engineConfig);
  sdk.getHookRegistry().clear();
  sdk.refreshRuntimeConfig({ responseLanguage: "Japanese" }, 8);
  await sdk.run("proof-sdk: Follow up", {
    sessionId: "proof-sdk",
    clientMessageId: "sdk-two",
    behaviorMode: "proof",
    archiveBeforeCurrentTurn: { segmentId: "proof-archive", summary: "synthetic archived history" },
  });
  await sdk.dispose();
  const secondProof = await verifyAttempts(
    engineConfig.sessionStorageDir,
    "proof-sdk",
    ownerKeys,
    "proof-sdk",
  );
  assert.equal(secondProof.boundaries.at(-1).data.keyId, firstProof.boundaries[0].data.keyId);
  assert.equal(secondProof.boundaries.at(-1).data.configVersion, 8);
  assert.notEqual(
    secondProof.boundaries.at(-1).data.systemPromptDigest,
    firstProof.boundaries[0].data.systemPromptDigest,
  );
  // A real Engine preflight failure must not reach the fixture or fallback.
  const beforeReject = readLines(join(root, "requests.jsonl")).length;
  sdk = new core.Engine({
    ...engineConfig,
    modelRequestSigner: {
      sign: async () => {
        throw new Error("synthetic Host unavailable");
      },
    },
  });
  sdk.getHookRegistry().clear();
  const rejected = await sdk.run("proof-rejected", {
    sessionId: "proof-rejected",
    behaviorMode: "proof",
  });
  assert.equal(rejected.reason, "model_error");
  assert.equal(readLines(join(root, "requests.jsonl")).length, beforeReject);
  assert.equal(sdk.getUsageSummary().notSentRequests, 1);
  await sdk.dispose();

  for (const phase of ["boundary", "attempt"]) {
    const sid = `proof-write-${phase}`;
    const file = join(engineConfig.sessionStorageDir, sid, "transcript.jsonl");
    const original = core.Transcript.prototype.appendModelRequestEvent;
    let faulted = false;
    // Fault the actual production writer at exactly the before-send append.
    core.Transcript.prototype.appendModelRequestEvent = function (type, data) {
      if (type === `model_request_${phase}` && this.filePath === file) {
        renameSync(file, `${file}.before-fault`);
        mkdirSync(file);
        faulted = true;
      }
      return original.call(this, type, data);
    };
    const before = readLines(join(root, "requests.jsonl")).length;
    sdk = new core.Engine(engineConfig);
    sdk.getHookRegistry().clear();
    try {
      const denied = await sdk.run(`proof-write-${phase}`, {
        sessionId: sid,
        behaviorMode: "proof",
      });
      assert.equal(denied.reason, "model_error");
      assert.equal(faulted, true);
      assert.equal(readLines(join(root, "requests.jsonl")).length, before);
      assert.equal(sdk.getUsageSummary().notSentRequests, 1);
    } finally {
      core.Transcript.prototype.appendModelRequestEvent = original;
      if (faulted) {
        rmSync(file, { recursive: true });
        renameSync(`${file}.before-fault`, file);
      }
      await sdk.dispose();
    }
  }

  sdk = new core.Engine({ ...engineConfig, preset: "general", maxTurns: 6, isSubAgent: false });
  sdk.getHookRegistry().clear();
  let steered = false,
    steerAccepted = false;
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jc8kAAAAASUVORK5CYII=";
  const rich = await sdk.run(
    `proof-rich: Inspect the synthetic source catalog and image. <codeshell-image mime="image/png" name="fixture.png">data:image/png;base64,${pixel}</codeshell-image>`,
    {
      sessionId: "proof-rich",
      behaviorMode: "proof",
      toolAllowlist: ["ListSources"],
      onStream(event) {
        if (!steered && event.type === "text_delta") {
          steered = true;
          steerAccepted = sdk.enqueueSteer(
            "proof-rich",
            "proof-rich steer: finish concisely",
            "synthetic-steer",
            "steer-message",
          ).accepted;
        }
      },
    },
  );
  assert.equal(rich.reason, "completed");
  await sdk.dispose();
  const richProof = await verifyAttempts(
    engineConfig.sessionStorageDir,
    "proof-rich",
    ownerKeys,
    "proof-rich",
  );
  assert.ok(richProof.boundaries.length >= 2);
  assert.equal(steered, true);
  assert.equal(steerAccepted, true);
  assert.notEqual(
    richProof.boundaries[0].data.messageDigest,
    richProof.boundaries.at(-1).data.messageDigest,
  );
  const richEvents = transcriptEvents(engineConfig.sessionStorageDir, "proof-rich");
  assert.equal(richEvents.filter((event) => event.type === "tool_result").length, 2);
  assert.ok(
    richEvents.some(
      (event) => event.type === "message" && event.data.steerId === "synthetic-steer",
    ),
  );
  assert.ok(
    readLines(join(root, "requests.jsonl")).some((entry) =>
      JSON.stringify(entry.body.messages).includes("data:image/png;base64,"),
    ),
  );

  sdk = new core.Engine({
    ...engineConfig,
    preset: "general",
    behaviorProfiles: [{ ...profiles[0], disableHooks: false }],
    modules: [
      {
        id: "proof-hook",
        engine: {
          hooks: [
            {
              event: "user_prompt_submit",
              name: "synthetic-hook",
              handler: () => ({ messages: ["synthetic-private-hook"] }),
            },
          ],
        },
      },
    ],
  });
  const hooked = await sdk.run("proof-rich: Follow up with the private runtime hook", {
    sessionId: "proof-rich",
    behaviorMode: "proof",
    toolAllowlist: [],
  });
  assert.equal(hooked.reason, "completed");
  await sdk.dispose();
  const hookedProof = await verifyAttempts(
    engineConfig.sessionStorageDir,
    "proof-rich",
    ownerKeys,
    "proof-rich",
  );
  assert.notEqual(
    hookedProof.boundaries.at(-1).data.compositionDigest,
    richProof.boundaries[0].data.compositionDigest,
  );
  assert.notEqual(
    hookedProof.boundaries.at(-1).data.toolCatalogDigest,
    richProof.boundaries[0].data.toolCatalogDigest,
  );
  assert.notEqual(
    hookedProof.boundaries.at(-1).data.messageDigest,
    richProof.boundaries.at(-1).data.messageDigest,
  );
  assert.ok(
    readLines(join(root, "requests.jsonl")).some((entry) =>
      JSON.stringify(entry.body.messages).includes("synthetic-private-hook"),
    ),
  );

  sdk = new core.Engine({
    ...engineConfig,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "synthetic-local-key",
      baseUrl: endpoint,
    },
  });
  sdk.getHookRegistry().clear();
  const anthropic = await sdk.run("proof-anthropic: Return one confirmation", {
    sessionId: "proof-anthropic",
    behaviorMode: "proof",
  });
  assert.equal(anthropic.reason, "completed");
  await sdk.dispose();
  const anthropicProof = await verifyAttempts(
    engineConfig.sessionStorageDir,
    "proof-anthropic",
    ownerKeys,
    "proof-anthropic",
  );
  assert.equal(anthropicProof.attempts[0].data.projection, "anthropic-messages");

  const master = randomBytes(32);
  const cipher = {
    encrypt(value) {
      const iv = randomBytes(12),
        encryption = createCipheriv("aes-256-gcm", master, iv);
      const body = Buffer.concat([encryption.update(value), encryption.final()]);
      return `enc:fixture:${Buffer.concat([iv, encryption.getAuthTag(), body]).toString("base64")}`;
    },
    decrypt(value) {
      const body = Buffer.from(value.slice("enc:fixture:".length), "base64"),
        decryption = createDecipheriv("aes-256-gcm", master, body.subarray(0, 12));
      decryption.setAuthTag(body.subarray(12, 28));
      return Buffer.concat([decryption.update(body.subarray(28)), decryption.final()]).toString();
    },
  };
  const encryptedKeys = new host.ModelRequestKeyStore({
    directory: join(root, "host-custody"),
    cipher,
    custodyMode: "host-encrypted",
  });
  const workerStorage = join(root, "data", "sessions");
  function worker() {
    const childEnv = {
      ...env,
      CODE_SHELL_CREDENTIAL_ACCESS: "local",
      CODE_SHELL_MODEL_REQUEST_SIGNING: "host",
    };
    const child = spawn(
      process.execPath,
      [resolve("packages/core/dist/cli/agent-server-stdio.js")],
      { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    let serial = 0,
      buffer = "",
      errors = "";
    const pending = new Map();
    child.stderr.on("data", (part) => (errors += part));
    child.stdout.on("data", (part) => {
      buffer += part;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === "desktop/modelRequestSign") {
          void (async () => {
            try {
              host.assertDurableRequestOwner(message.params.subject, workerStorage);
              const result = await encryptedKeys.sign(message.params);
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
            } catch {
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: "synthetic Host signing rejected" },
                }) + "\n",
              );
            }
          })();
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    });
    child.on("exit", () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(errors.slice(-1200)));
      }
    });
    return {
      async request(method, params) {
        await guardReceipt(child, env, origin);
        const id = ++serial;
        return new Promise((resolveRequest, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`worker timeout ${method}: ${errors.slice(-1200)}`)),
            20_000,
          );
          pending.set(id, { timer, resolve: resolveRequest, reject });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      },
      async close() {
        const exited = once(child, "exit");
        child.stdin.end();
        const [code] = await exited;
        children.delete(child);
        assert.equal(code, 0, errors.slice(-1200));
      },
    };
  }
  try {
    let current = worker();
    const result = await current.request("agent/run", {
      sessionId: "proof-worker",
      clientMessageId: "worker-one",
      task: "proof-worker: Return one confirmation",
      cwd: root,
    });
    assert.ok(["completed", "max_turns"].includes(result.reason));
    await current.close();
    const beforeRestart = await verifyAttempts(
      workerStorage,
      "proof-worker",
      encryptedKeys,
      "proof-worker",
    );
    current = worker();
    const replay = await current.request("agent/run", {
      sessionId: "proof-worker",
      clientMessageId: "worker-one",
      task: "proof-worker: Return one confirmation",
      cwd: root,
    });
    assert.equal(replay.runId, result.runId);
    await current.request("agent/run", {
      sessionId: "proof-worker",
      clientMessageId: "worker-two",
      task: "proof-worker: Follow up",
      cwd: root,
    });
    await current.close();
    const afterRestart = await verifyAttempts(
      workerStorage,
      "proof-worker",
      encryptedKeys,
      "proof-worker",
    );
    assert.equal(afterRestart.boundaries.at(-1).data.keyId, beforeRestart.boundaries[0].data.keyId);
    assert.equal(afterRestart.boundaries.at(-1).data.custodyMode, "host-encrypted");
    const tuiEnv = { ...env, CODE_SHELL_CREDENTIAL_ACCESS: "local" };
    const tui = spawn(
      process.execPath,
      [
        resolve("packages/tui/dist/cli/main.js"),
        "run",
        "proof-tui: Return one confirmation",
        "--preset",
        "general",
        "--max-turns",
        "1",
        "--output",
        "json",
        "--no-wait-background-agents",
      ],
      { cwd: root, env: tuiEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(tui);
    let output = "",
      errors = "";
    tui.stdout.on("data", (part) => (output += part));
    tui.stderr.on("data", (part) => (errors += part));
    await guardReceipt(tui, tuiEnv, origin);
    const [code] = await once(tui, "exit");
    children.delete(tui);
    const tuiResult = JSON.parse(output);
    assert.equal(code, tuiResult.reason === "completed" ? 0 : 1, errors.slice(-1200));
    const tuiProof = await verifyAttempts(
      join(root, "tui-sessions"),
      tuiResult.sessionId,
      ownerKeys,
      "proof-tui",
    );
    console.log(
      JSON.stringify({
        sdk: "compiled SDK + transparent retry + resume/config/archive",
        rich: "actual image/tool/steer/hook/catalog and composition change; Anthropic projection",
        rejected: "real Engine custody and boundary/attempt writer failures zero fetch/fallback",
        desktopWorker: "actual stdio + private Host encrypted signing + restart/replay",
        tui: "compiled CLI + durable evidence",
        sdkAttempts: secondProof.attempts.length,
        workerAttempts: afterRestart.attempts.length,
        tuiAttempts: tuiProof.attempts.length,
      }),
    );
  } finally {
    await stopChildren();
    encryptedKeys.dispose();
    ownerKeys.dispose();
  }
}
