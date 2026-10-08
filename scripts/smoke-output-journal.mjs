import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";
import {
  confinedWorkerEnvironment,
  installLocalNetworkGuard,
} from "./runtime-cost-smoke-isolation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(repo, "packages/core/dist/cli/agent-server-stdio.js");
const preload = new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href;

async function measureJournal(core, root, sessionId, expectedHash) {
  const fs = (await import("node:fs")).default;
  const original = fs.readSync;
  let readBytes = 0,
    pages = 0;
  fs.readSync = (...args) => {
    const bytes = original(...args);
    readBytes += bytes;
    return bytes;
  };
  syncBuiltinESMExports();
  const began = performance.now(),
    outputHash = createHash("sha256");
  const recovery = { incomplete: false };
  try {
    let page = core.readOutputJournal(root, sessionId);
    const coldFirstPageMs = performance.now() - began,
      coldReadBytes = readBytes;
    while (true) {
      pages++;
      const complete = core.applyOutputJournalPage(recovery, page, (event) => {
        if (event.type === "text_delta") outputHash.update(event.text);
      });
      assert.equal(recovery.incomplete, false);
      if (complete) break;
      page = core.readOutputJournal(root, sessionId, {
        after: recovery.cursor,
        through: recovery.through,
      });
    }
    assert.equal(outputHash.digest("hex"), expectedHash);
    return {
      journalBytes: statSync(join(root, sessionId, "output-journal.jsonl")).size,
      coldFirstPageMs: Math.round(coldFirstPageMs),
      coldReadBytes,
      allPagesMs: Math.round(performance.now() - began),
      allPagesReadBytes: readBytes,
      pages,
    };
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
}

// An ordinary HTTP upgrade keeps the exact-origin guard active. The ws client
// injects its own createConnection callback, which that guard correctly rejects.
async function fixtureWebSocket(origin, cookie) {
  const key = randomBytes(16).toString("base64");
  const request = httpRequest(origin + "/ws", {
    headers: {
      origin,
      cookie,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": key,
      "sec-websocket-version": "13",
    },
  });
  request.end();
  const [response, socket, head] = await once(request, "upgrade");
  assert.equal(
    response.headers["sec-websocket-accept"],
    createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64"),
  );
  const pending = new Map();
  let serial = 0,
    buffered = head;
  const send = (payload, opcode = 1) => {
    const body = Buffer.from(payload),
      mask = randomBytes(4);
    assert.ok(body.length < 65536);
    const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    if (body.length < 126) header[1] = 0x80 | body.length;
    else {
      header[1] = 0xfe;
      header.writeUInt16BE(body.length, 2);
    }
    const masked = Buffer.from(body);
    for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    assert.ok(buffered.length < 4 * 1024 * 1024);
    while (buffered.length >= 2) {
      const opcode = buffered[0] & 15,
        small = buffered[1] & 127;
      assert.equal(buffered[0] & 0xf0, 0x80, "Fixture expects uncompressed whole Hub messages");
      let start = 2,
        size = small;
      if (small === 126) {
        if (buffered.length < 4) return;
        size = buffered.readUInt16BE(2);
        start = 4;
      }
      if (small === 127) {
        if (buffered.length < 10) return;
        size = Number(buffered.readBigUInt64BE(2));
        start = 10;
      }
      assert.ok(size <= 2 * 1024 * 1024);
      assert.equal(buffered[1] & 128, 0);
      if (buffered.length < start + size) return;
      const body = buffered.subarray(start, start + size);
      buffered = buffered.subarray(start + size);
      if (opcode === 9) {
        send(body, 10);
        continue;
      }
      if (opcode === 8) {
        socket.destroy();
        continue;
      }
      assert.equal(opcode, 1);
      const message = JSON.parse(body.toString("utf8")),
        item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    }
  });
  return {
    query: (params) =>
      new Promise((resolveQuery, reject) => {
        const id = ++serial,
          timer = setTimeout(() => reject(new Error("Hub output query timed out")), 60_000);
        pending.set(id, { resolve: resolveQuery, reject, timer });
        send(JSON.stringify({ jsonrpc: "2.0", id, method: "agent/query", params }));
      }),
    close: () => {
      for (const item of pending.values()) clearTimeout(item.timer);
      socket.destroy();
    },
  };
}

async function workerGuard(child, env) {
  for (let index = 0; index < 200; index++) {
    const records = existsSync(env.CODESHELL_COST_SMOKE_GUARD_LOG)
      ? readFileSync(env.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
    const record = records.find((item) => item.pid === child.pid);
    if (record) {
      assert.equal(record.ppid, process.pid);
      assert.equal(record.origin, env.CODESHELL_COST_SMOKE_ORIGIN);
      assert.equal(record.homeId, hash(env.HOME));
      return;
    }
    if (child.exitCode !== null) break;
    await wait(10);
  }
  throw new Error("Output smoke stopped before RPC: missing actual worker isolation receipt");
}
async function stdioQuery(root, storage, cwd, origin, sessionId) {
  const environmentRoot = mkdtempSync(join(root, "worker-"));
  const clean = createBunTestEnvironment(process.env, environmentRoot);
  const env = {
    ...confinedWorkerEnvironment(clean, clean.HOME, origin, preload),
    CODE_SHELL_HOME: clean.CODE_SHELL_HOME,
    CODE_SHELL_TEST_HOME: clean.CODE_SHELL_TEST_HOME,
    CODE_SHELL_DATA_ROOT: storage,
    AGENT_CWD: cwd,
    CODE_SHELL_CAPABILITY_MODULES: "",
    CODE_SHELL_CREDENTIAL_ACCESS: "local",
    CODESHELL_SELF_UPDATE_CHECK: "0",
    CODESHELL_COST_SMOKE_GUARD_LOG: join(environmentRoot, "guard.jsonl"),
  };
  writeFileSync(
    join(clean.CODE_SHELL_HOME, "settings.json"),
    JSON.stringify({
      credentials: [
        { id: "fixture-key", catalogId: "openai", apiKey: "synthetic", baseUrl: origin + "/v1" },
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
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    stderr = "";
  child.stderr.on("data", (value) => {
    stderr = (stderr + value).slice(-4000);
  });
  let serial = 0;
  const pending = new Map();
  child.stdout.on("data", (value) => {
    output += value;
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const raw = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!raw.trim()) continue;
      const message = JSON.parse(raw),
        item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    }
  });
  const request = (params) =>
    new Promise((resolveRequest, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => reject(new Error("Output RPC timed out: " + stderr)), 60_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method: "agent/query", params }) + "\n",
      );
    });
  try {
    await workerGuard(child, env);
    const page = (await request({ type: "output_journal", sessionId, maxFrames: 1 })).data;
    assert.equal(page.status, "ok");
    assert.equal(page.frames.length, 1);
    return { through: page.through, pid: child.pid, homeHash: hash(env.HOME) };
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    const exited = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code] = await exited;
      assert.equal(code, 0, stderr);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function hubChild(args) {
  const [storage, cwd, expectedHash, adapters] = args;
  // Reserve a concrete loopback port before importing Core/Hub. The guard is
  // installed first; this fixture never opens a model endpoint.
  const reservation = createTcpServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  installLocalNetworkGuard(origin);
  const { startHeadlessServer } = await import(
    pathToFileURL(join(repo, "packages/server/dist/index.serve.js"))
  );
  const { chatFromOutputJournal } = await import(pathToFileURL(adapters));
  const dataDir = join(process.env.HOME, "hub-fixture");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const boot = () =>
    startHeadlessServer({
      cwd,
      dataDir,
      workerDataRoot: storage,
      workerEntryPath: entry,
      authMode: "hub",
      host: "127.0.0.1",
      port,
      workerCapabilityModules: "",
    });
  let host;
  const queryBoot = async (first) => {
    host = await boot();
    const login = await fetch(origin + `/api/v1/auth/${first ? "setup" : "login"}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        token: host.bootstrapToken,
        username: "fixture",
        password: "synthetic-output-journal-password",
        deviceName: "fixture",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const socket = await fixtureWebSocket(origin, cookie);
    const query = socket.query;
    try {
      const detail = (
        await query({ type: "session_detail", sessionId: "long-output", outputRecovery: true })
      ).data;
      assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 2 * 1024 * 1024);
      const restored = await chatFromOutputJournal(
        detail,
        async (options) =>
          (await query({ type: "output_journal", sessionId: "long-output", ...options })).data,
        [],
      );
      const text = restored.chat.items
        .filter((item) => item.kind === "assistant")
        .map((item) => item.text)
        .join("");
      assert.equal(hash(text), expectedHash);
      await assert.rejects(
        query({ type: "output_journal", sessionId: "../escape" }),
        /Session|会话/,
      );
      return {
        through: restored.outputCursor,
        epoch: detail.streamCursor.epoch,
        bytes: Buffer.byteLength(text),
      };
    } finally {
      socket.close();
    }
  };
  try {
    const before = await queryBoot(true);
    await host.close();
    host = undefined;
    const after = await queryBoot(false);
    assert.equal(before.through, after.through);
    assert.notEqual(before.epoch, after.epoch);
    console.log(
      JSON.stringify({
        hubRecovery: true,
        hubRestartCursorStable: true,
        hubTransportEpochChanged: true,
        recoveredBytes: after.bytes,
      }),
    );
  } finally {
    await host?.close();
  }
}

if (process.argv[2] === "--hub") {
  await hubChild(process.argv.slice(3));
} else {
  assert.equal(process.env.HOME, realpathSync(process.env.HOME));
  assert.ok(process.env.CODE_SHELL_HOME && process.env.CODE_SHELL_TEST_HOME);
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-consumers-"));
  const adapters = resolve(
    repo,
    "packages/desktop/node_modules/.cache/output-journal-adapters.fixture.mjs",
  );
  mkdirSync(dirname(adapters), { recursive: true });
  const built = spawnSync(
    "bun",
    [
      "build",
      "scripts/fixtures/output-journal-adapters.ts",
      "--target=node",
      "--packages=external",
      "--outfile",
      adapters,
    ],
    { cwd: repo, env: process.env, encoding: "utf8" },
  );
  assert.equal(built.status, 0, String(built.stderr).slice(-1000));
  const parts = Array.from(
    { length: 2205 },
    (_, index) => `${String(index).padStart(4, "0")}-汉🙂${"x".repeat(4096)}\n`,
  );
  const expected = parts.join(""),
    expectedHash = hash(expected);
  assert.ok(Buffer.byteLength(expected) > 8 * 1024 * 1024);
  let requests = 0;
  const http = createHttpServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    assert.equal(body.stream, true);
    response.setHeader("content-type", "text/event-stream");
    for (const text of parts) {
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      if (!response.write(`data: ${JSON.stringify(chunk)}\n\n`)) await once(response, "drain");
    }
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2205, total_tokens: 2215 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  installLocalNetworkGuard(origin);
  const core = await import("@cjhyy/code-shell-core");
  const journalCore = await import("@cjhyy/code-shell-core/internal");
  const journalWeb = await import(pathToFileURL(join(repo, "packages/web/dist/index.js")));
  const { registerSessionTranscriptIpc, SessionSnapshotStore, recoverDesktopOutputJournal } =
    await import(pathToFileURL(adapters));
  const storage = dirname(core.sessionsRoot());
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const snapshots = new SessionSnapshotStore();
  let frames = 0;
  const engine = new core.Engine({
    llm: { provider: "openai", model: "gpt-4o", apiKey: "synthetic", baseUrl: origin + "/v1" },
    cwd,
    sessionStorageDir: core.sessionsRoot(),
    settingsScope: "isolated",
    headless: true,
    maxTurns: 2,
    behaviorProfiles: [
      {
        id: "output-fixture",
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();
  let succeeded = false;
  try {
    const result = await engine.run("Return the local fixture response", {
      sessionId: "long-output",
      clientMessageId: "local-submit",
      behaviorMode: "output-fixture",
      onStream: (event) => {
        frames++;
        snapshots.append("long-output", event);
      },
    });
    assert.equal(result.reason, "completed");
    assert.equal(hash(result.text), expectedHash);
    assert.ok(frames > 2000);
    const journalApi = {
      ...journalCore,
      applyOutputJournalPage: journalWeb.applyOutputJournalPage,
    };
    const modelJournalTiming = await measureJournal(
      journalApi,
      core.sessionsRoot(),
      "long-output",
      expectedHash,
    );
    const budgetRoot = join(root, "budget-sessions"),
      manager = new core.SessionManager(budgetRoot);
    const budgetSession = manager.create(cwd, "fixture", "fixture", "near-budget");
    manager.startSessionRun(budgetSession.state, "budget-run");
    const writer = new journalCore.SessionOutputJournal(
      budgetRoot,
      "near-budget",
      "budget-run",
      budgetSession.transcript.getEvents()[0].id,
    );
    const budgetText = "x".repeat(15 * 1024 * 1024),
      budgetHash = createHash("sha256");
    for (let index = 0; index < 6; index++) {
      writer.append({ type: "text_delta", text: budgetText });
      budgetHash.update(budgetText);
    }
    assert.throws(() => writer.append({ type: "text_delta", text: budgetText }), /storage budget/);
    const nearBudgetTiming = await measureJournal(
      journalApi,
      budgetRoot,
      "near-budget",
      budgetHash.digest("hex"),
    );
    assert.ok(nearBudgetTiming.journalBytes > 120 * 1024 * 1024);
    // A static log must not reread its complete prefix on every page. Includes
    // Session metadata, header and both sparse seek checks, not only body bytes.
    assert.ok(nearBudgetTiming.allPagesReadBytes < nearBudgetTiming.journalBytes * 8);
    console.log(JSON.stringify({ modelJournalTiming, nearBudgetTiming }));
    const handlers = new Map();
    registerSessionTranscriptIpc({ handle: (name, listener) => handlers.set(name, listener) });
    const recover = (store) =>
      recoverDesktopOutputJournal({
        read: (options) => handlers.get("sessions:outputJournal")({}, "long-output", options),
        snapshot: async () => store.get("long-output"),
        canContinue: () => true,
        latestObservedCursor: () => undefined,
      });
    const before = await recover(snapshots);
    const desktopText = before.state.messages
      .filter((item) => item.kind === "assistant")
      .map((item) => item.text)
      .join("");
    assert.equal(hash(desktopText), expectedHash);
    const after = await recover(new SessionSnapshotStore());
    assert.equal(before.outputCursor, after.outputCursor);
    assert.notEqual(before.snapshot.epoch, after.snapshot.epoch);
    const workerOne = await stdioQuery(root, storage, cwd, origin, "long-output");
    const workerTwo = await stdioQuery(root, storage, cwd, origin, "long-output");
    assert.equal(workerOne.through, workerTwo.through);
    assert.equal(workerOne.through, before.outputCursor);
    assert.notEqual(workerOne.pid, workerTwo.pid);
    const hubEnvironment = createBunTestEnvironment(process.env, join(root, "hub-environment"));
    const hub = spawn(
      process.execPath,
      [
        resolve(repo, "scripts/smoke-output-journal.mjs"),
        "--hub",
        storage,
        cwd,
        expectedHash,
        adapters,
      ],
      { cwd: repo, env: hubEnvironment, stdio: "inherit" },
    );
    const [hubCode] = await once(hub, "exit");
    assert.equal(hubCode, 0);
    assert.equal(requests, 1);
    console.log(
      JSON.stringify({
        sdkRequests: requests,
        liveFrames: frames,
        outputBytes: Buffer.byteLength(expected),
        recoveredHash: expectedHash,
        desktopRecovery: true,
        desktopRestartCursorStable: true,
        desktopTransportEpochChanged: true,
        stdioRestartCursorStable: true,
        actualWorkerReceipts: 2,
        noExternalNetwork: true,
      }),
    );
    succeeded = true;
  } finally {
    await engine.dispose();
    await new Promise((done) => http.close(done));
    rmSync(adapters, { force: true });
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error("Private synthetic fixture evidence retained at " + root);
  }
}
