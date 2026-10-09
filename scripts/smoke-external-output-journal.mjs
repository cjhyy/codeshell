// Real Node + synthetic stdio CLIs, compiled Core/coding and the actual Main adapters.
// Run only in a fresh private HOME with external-output-smoke-isolation preloaded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

assert(
  globalThis[Symbol.for("codeshell.external-output.fixture-guard")],
  "pre-Core guard required",
);
const root = process.env.CODESHELL_OUTPUT_ROOT;
assert(root && resolve(root) === root && root.includes("/codeshell-external-output-native-"));
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = () => ({
  pid: process.pid,
  ppid: process.ppid,
  uid: process.getuid?.(),
  homeHash: process.env.CODESHELL_OUTPUT_HOME_HASH,
  nodeVersion: process.versions.node,
  execPath: process.execPath,
  nodeBinaryHash: hash(readFileSync(process.execPath)),
});
const adapters = process.env.CODESHELL_OUTPUT_ADAPTERS;
assert(adapters);
const core = await import("@cjhyy/code-shell-core");
const coding = await import(
  pathToFileURL(join(repo, "packages/coding/dist/external-runtimes/index.js"))
);
const { compareOutputCursors } = await import(
  pathToFileURL(join(repo, "packages/web/dist/index.js"))
);
const { listDiskSessions } = await import(
  pathToFileURL(join(repo, "packages/server/dist/index.storage.js"))
);
const {
  ExternalRuntimeService,
  ExternalRuntimeSessionRecorder,
  SessionSnapshotStore,
  publishOwnedExternalStream,
  registerSessionTranscriptIpc,
  recoverDesktopOutputJournal,
  createTaskInboxSources,
} = await import(pathToFileURL(adapters));
const handlers = new Map();
registerSessionTranscriptIpc({ handle: (name, callback) => handlers.set(name, callback) });
const recover = (sessionId, snapshots) =>
  recoverDesktopOutputJournal({
    read: (options) => handlers.get("sessions:outputJournal")({}, sessionId, options),
    snapshot: async () => snapshots.get(sessionId),
    canContinue: () => true,
    latestObservedCursor: () => undefined,
  });
const assistantText = (recovery) =>
  recovery.state.messages
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text)
    .join("");
if (process.argv[2] === "cold") {
  const recovery = await recover(process.argv[3], new SessionSnapshotStore());
  assert(recovery);
  console.log(
    JSON.stringify({
      ...identity(),
      epoch: recovery.snapshot.epoch,
      cursor: recovery.outputCursor,
      bytes: Buffer.byteLength(assistantText(recovery)),
      textHash: hash(assistantText(recovery)),
    }),
  );
  process.exit(0);
}

const bin = join(root, "bin");
const workspace = join(root, "workspace");
mkdirSync(bin, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const requests = () => {
  try {
    return readFileSync(process.env.CODESHELL_OUTPUT_REQUEST_LOG, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
const turns = () => requests().filter((event) => event.event === "physical-turn").length;
const part = (index) => `${index.toString().padStart(4, "0")}-汉🙂${"x".repeat(48 * 1024)}\n`;
const owner = { isDestroyed: () => false, webContents: { id: 77 } };
function createService(onEvent = () => {}) {
  const snapshots = new SessionSnapshotStore();
  const live = [];
  const wrongOwner = [];
  const windows = [
    {
      isDestroyed: () => false,
      webContents: { id: 77, send: (channel, payload) => live.push({ channel, ...payload }) },
    },
    {
      isDestroyed: () => false,
      webContents: { id: 88, send: (channel, payload) => wrongOwner.push({ channel, ...payload }) },
    },
  ];
  const service = new ExternalRuntimeService({
    featureFlags: () => ({ external_agent_runtime: true, external_host_tools: true }),
    projectTrust: () => "trusted",
    registerSession: () => {},
    releaseSession: () => {},
    resolveProjectBinding: () => undefined,
    prepareCodexLaunch: async () => ({ command: join(bin, "codex"), env: process.env }),
    emit: (sessionId, event) => {
      publishOwnedExternalStream(snapshots, windows, 77, sessionId, event);
      onEvent(sessionId, event);
    },
  });
  return { service, snapshots, live, wrongOwner };
}
const start = (service, sessionId, kind = "codex") =>
  service.start({ sessionId, kind, cwd: workspace, model: "synthetic", ownerWindow: owner });
const output = { ...identity(), compiledCore: true, syntheticCliOnly: true, cases: [] };
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture wait bound exceeded");
    await new Promise((done) => setTimeout(done, 10));
  }
};
const cold = async (sessionId) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "cold", sessionId], {
    cwd: repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((done) => child.once("exit", done));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout.trim());
};

// >8MiB forces the actual Main snapshot to evict a prefix. A second Node Main
// reads through actual IPC + renderer recovery, not a test-only file parser.
for (const kind of ["codex", "claude-code"]) {
  process.env.CODESHELL_OUTPUT_PARTS = "192";
  const id = `long-${kind}`;
  const { service, snapshots, live, wrongOwner } = createService();
  try {
    await start(service, id, kind);
    const before = turns();
    await assert.rejects(service.send(id, "wrong window", 88), /another window/);
    assert.equal(turns(), before);
    const outcome = await service.send(
      id,
      {
        text: "synthetic input",
        displayText: "【Fixture】 synthetic input",
        clientMessageId: `input-${kind}`,
      },
      77,
    );
    assert.equal(outcome.ok, true);
    const expected = Array.from({ length: 192 }, (_, index) => part(index)).join("");
    assert(Buffer.byteLength(expected) > 8 * 1024 * 1024);
    assert.equal(hash(outcome.text), hash(expected));
    assert.equal(wrongOwner.length, 0);
    assert(
      live.every(
        (frame) =>
          frame.channel === "agent:streamEvent" &&
          frame.event.outputCursor &&
          frame.epoch === snapshots.epoch,
      ),
    );
    for (let index = 1; index < live.length; index++)
      assert.equal(
        compareOutputCursors(live[index].event.outputCursor, live[index - 1].event.outputCursor),
        1,
      );
    assert.notEqual(snapshots.get(id).outputUnpaired, true);
    assert(snapshots.get(id).events[0].seq > 1);
    const recovered = await recover(id, snapshots);
    assert.equal(hash(assistantText(recovered)), hash(expected));
    const restarted = await cold(id);
    assert.notEqual(restarted.pid, process.pid);
    assert.notEqual(restarted.epoch, snapshots.epoch);
    assert.equal(restarted.cursor, recovered.outputCursor);
    assert.equal(restarted.textHash, hash(expected));
    const originalJournal = readFileSync(join(core.sessionsRoot(), id, "output-journal.jsonl"));
    await assert.rejects(
      service.send(id, { text: "synthetic input", clientMessageId: `input-${kind}` }, 77),
      /already recorded/,
    );
    await assert.rejects(
      service.send(id, { text: "conflicting input", clientMessageId: `input-${kind}` }, 77),
      /already recorded/,
    );
    assert(
      readFileSync(join(core.sessionsRoot(), id, "output-journal.jsonl")).equals(originalJournal),
    );
    process.env.CODESHELL_OUTPUT_PARTS = "1";
    // Codex's fake emits a tombstoned previous-turn delta and terminal here.
    assert.equal(
      (await service.send(id, { text: "next", clientMessageId: `next-${kind}` }, 77)).ok,
      true,
    );
    assert(
      !readFileSync(join(core.sessionsRoot(), id, "output-journal.jsonl"), "utf8").includes(
        "STALE-OLD-TURN",
      ),
    );
    output.cases.push({
      kind,
      case: "large-hot-cold-recovery-owner-duplicate-stale",
      bytes: Buffer.byteLength(expected),
      textHash: hash(expected),
      cold: restarted,
      physicalTurns: turns() - before,
      ownerFrames: live.length,
      otherOwnerFrames: wrongOwner.length,
    });
  } finally {
    await service.stopAll();
  }
}

process.env.CODESHELL_OUTPUT_PARTS = "1";
// A cold recorder sees aggregate main+aux usage, while Codex reports only its
// own thread total. Those domains must never become each other's baseline.
{
  const id = "cold-aux-accounting";
  const manager = new core.SessionManager();
  manager.create(workspace, "codex/synthetic", "codex", id);
  manager.updateSessionState(id, {
    tokenUsage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    cumulativePromptTokens: 100,
    title: "retained title",
    workspaceProfile: "fixture-profile",
  });
  manager.recordAuxiliaryUsage(
    id,
    { promptTokens: 30, completionTokens: 3, totalTokens: 33 },
    { marker: "preserved" },
  );
  const { service } = createService();
  try {
    await start(service, id);
    assert.equal(
      (await service.send(id, { text: "cold accounting", clientMessageId: "cold-accounting" }, 77))
        .ok,
      true,
    );
    const state = manager.readSessionState(id);
    assert.deepEqual(
      {
        prompt: state.tokenUsage.promptTokens,
        completion: state.tokenUsage.completionTokens,
        total: state.tokenUsage.totalTokens,
        cumulative: state.cumulativePromptTokens,
      },
      { prompt: 150, completion: 15, total: 165, cumulative: 150 },
    );
    assert.equal(state.title, "retained title");
    assert.equal(state.workspaceProfile, "fixture-profile");
    assert.equal(state.costState.marker, "preserved");
    output.cases.push({
      case: "cold-aux-provider-accounting",
      prompt: 150,
      completion: 15,
      total: 165,
      metadataRetained: true,
    });
  } finally {
    await service.stopAll();
  }
}
// Repeated actual translator partial reports have no request identity.
{
  process.env.CODESHELL_OUTPUT_PARTIAL_USAGE = "1";
  const { service } = createService();
  const id = "partial-usage";
  try {
    await start(service, id);
    assert.equal((await service.send(id, "synthetic partial usage", 77)).ok, true);
    const state = new core.SessionManager().readSessionState(id);
    assert.deepEqual(
      {
        prompt: state.tokenUsage.promptTokens,
        completion: state.tokenUsage.completionTokens,
        total: state.tokenUsage.totalTokens,
      },
      { prompt: 10, completion: 2, total: 12 },
    );
    output.cases.push({
      case: "actual-repeated-partial-usage",
      prompt: 10,
      completion: 2,
      total: 12,
    });
  } finally {
    delete process.env.CODESHELL_OUTPUT_PARTIAL_USAGE;
    await service.stopAll();
  }
}
// Finalization happens after a provider succeeded. A failed logical terminal
// must override that success, including the result returned to Panel submit.
{
  const id = "goal-finalization-fault";
  let injected = false;
  const { service, live } = createService((_id, event) => {
    if (!injected && event.type === "goal_progress" && event.gaps?.includes("目标已暂停")) {
      const path = join(core.sessionsRoot(), id, "output-journal.jsonl");
      renameSync(path, `${path}.retained`);
      mkdirSync(path);
      injected = true;
    }
  });
  try {
    await start(service, id);
    const before = turns();
    const outcome = await service.send(
      id,
      { text: "finalization must fail", goal: { objective: "synthetic", maxTurns: 1 } },
      77,
    );
    assert(injected);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "model_error");
    assert.equal(turns() - before, 1);
    assert.equal(
      live.filter(({ event }) => event.type === "turn_complete" && event.reason === "completed")
        .length,
      0,
    );
    assert.equal(new core.SessionManager().readSessionState(id).status, "model_error");
    output.cases.push({
      case: "goal-finalization-failure-overrides-success",
      physicalTurns: 1,
      noCompleted: true,
    });
  } finally {
    await service.stopAll();
  }
}
// Actual filesystem failures; no mocks and no chmod/root assumptions. The old
// file is retained, and a directory occupies precisely the next writer's path.
for (const stage of ["input", "delta", "terminal"]) {
  const id = `fault-${stage}`;
  let injected = false;
  const inject = () => {
    const path = join(
      core.sessionsRoot(),
      id,
      stage === "delta" ? "output-journal.jsonl" : "transcript.jsonl",
    );
    renameSync(path, `${path}.retained`);
    mkdirSync(path);
    injected = true;
  };
  const { service, live } = createService((_id, event) => {
    if (
      !injected &&
      ((stage === "delta" && event.type === "stream_request_start") ||
        (stage === "terminal" && event.type === "text_delta"))
    )
      inject();
  });
  try {
    await start(service, id);
    const before = turns();
    if (stage === "input") inject();
    const first = service.send(id, { text: "disk failure", clientMessageId: `fault-${stage}` }, 77);
    const queued = service.send(
      id,
      { text: "must never physically send", clientMessageId: `blocked-${stage}` },
      77,
    );
    assert.equal((await first).ok, false);
    assert.equal((await queued).ok, false);
    assert(injected);
    assert.equal(turns() - before, stage === "input" ? 0 : 1);
    assert.equal(
      live.filter(({ event }) => event.type === "turn_complete" && event.reason === "completed")
        .length,
      0,
    );
    assert.equal(
      live.filter(({ event }) => event.type === "error" && event.outputRecovery === "incomplete")
        .length,
      1,
    );
    const state = new core.SessionManager().readSessionState(id);
    assert.equal(state.outputRecoveryIncomplete, true);
    assert.equal(state.status, "model_error");
    assert.equal(service.isSessionRunning(id), false);
    const sources = createTaskInboxSources({
      diskSessions: async () => (await listDiskSessions({ limit: 100 })).sessions,
      native: {
        hasLiveWorker: () => false,
        isSessionRunning: () => false,
        cancel: async () => false,
      },
      external: {
        hasSession: (id) => service.hasSession(id),
        isSessionRunning: (id) => service.isSessionRunning(id),
        kind: () => "codex",
        interrupt: (id) => service.interrupt(id),
      },
    });
    const row = (
      await sources.readers.find((reader) => reader.source === "external-runtime").read()
    ).find((row) => row.sessionId === id);
    assert.equal(row.status, "failed");
    assert.equal(row.runId, state.runId);
    assert(!row.capabilities.includes("cancel"));
    output.cases.push({
      case: "actual-disk-failure",
      stage,
      physicalTurns: turns() - before,
      taskStatus: row.status,
      noCompleted: true,
      stickyQueuedFence: true,
    });
  } finally {
    await service.stopAll();
  }
}

// A failed turn/start must never allow an already queued request to reuse the
// process and acquire delayed, untombstoned output from the failed start.
{
  process.env.CODESHELL_OUTPUT_START_ERROR = "1";
  const { service, live } = createService();
  const id = "failed-start-queue";
  try {
    await start(service, id);
    const before = turns();
    const first = service.send(id, { text: "failed start", clientMessageId: "failed-start" }, 77);
    const queued = service.send(id, { text: "do not reuse", clientMessageId: "after-failure" }, 77);
    assert.equal((await first).ok, false);
    assert.equal((await queued).ok, false);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(turns() - before, 1);
    assert.equal(live.filter(({ event }) => event.type === "turn_complete").length, 1);
    assert.notEqual(new core.SessionManager().readSessionState(id).outputRecoveryIncomplete, true);
    delete process.env.CODESHELL_OUTPUT_START_ERROR;
    await start(service, id);
    assert.equal(
      (
        await service.send(
          id,
          { text: "replacement works", clientMessageId: "replacement-input" },
          77,
        )
      ).ok,
      true,
    );
    output.cases.push({
      case: "failed-start-queue-replacement",
      failedProcessRequests: 1,
      replacementAccepted: true,
      storageNotPoisoned: true,
    });
  } finally {
    delete process.env.CODESHELL_OUTPUT_START_ERROR;
    await service.stopAll();
  }
}

// Actual close and same-id replacement while a provider turn is live.
for (const mode of ["stop", "replace"]) {
  process.env.CODESHELL_OUTPUT_HOLD = "1";
  const { service, live } = createService();
  const id = `live-${mode}`;
  try {
    await start(service, id);
    const before = turns();
    const pending = service.send(id, { text: "hold", clientMessageId: `held-${mode}` }, 77);
    await waitUntil(() => live.some(({ event }) => event.type === "text_delta"));
    if (mode === "stop") await service.stop(id, 77);
    else {
      delete process.env.CODESHELL_OUTPUT_HOLD;
      await start(service, id);
    }
    assert.equal((await pending).reason, "aborted_streaming");
    assert.equal(
      live.filter(
        ({ event }) => event.type === "turn_complete" && event.reason === "aborted_streaming",
      ).length,
      1,
    );
    assert.equal(turns() - before, 1);
    if (mode === "replace")
      assert.equal(
        (await service.send(id, { text: "replacement", clientMessageId: "after-replace" }, 77)).ok,
        true,
      );
    output.cases.push({
      case: `actual-live-${mode}`,
      oldTerminal: "aborted_streaming",
      replacementAccepted: mode === "replace",
    });
  } finally {
    delete process.env.CODESHELL_OUTPUT_HOLD;
    await service.stopAll();
  }
}

// One journal owner for two physical Goal turns; output metadata is captured
// within this logical submission, never an unrelated later active turn.
{
  const { service, snapshots, live } = createService();
  const id = "goal-two-rounds";
  try {
    await start(service, id);
    const before = turns();
    const outcome = await service.send(
      id,
      {
        text: "Goal input",
        clientMessageId: "goal-input",
        goal: { objective: "synthetic unfinished goal", maxTurns: 2 },
      },
      77,
    );
    assert.equal(outcome.ok, true);
    assert.equal(turns() - before, 2);
    const state = new core.SessionManager().readSessionState(id);
    assert.equal(state.turnSeq, 1);
    assert.equal(state.turnCount, 2);
    assert.equal(live.filter(({ event }) => event.type === "turn_complete").length, 1);
    assert(live.every(({ event }) => typeof event.outputCursor === "string"));
    const recovered = await recover(id, snapshots);
    assert.equal(hash(assistantText(recovered)), hash(part(0) + part(0)));
    assert.equal(recovered.state.messages.filter((item) => item.kind === "user").length, 1);
    output.cases.push({
      case: "goal-logical-owner",
      physicalTurns: 2,
      turnSeq: state.turnSeq,
      turnCount: state.turnCount,
      terminalCount: 1,
      recoverable: true,
    });
  } finally {
    await service.stopAll();
  }
}

// Claude can print its provider result before the process exits. Goal Stop
// in that gap still owns an open logical run and must abort it exactly once.
for (const mode of ["interrupt", "stop", "replace"]) {
  process.env.CODESHELL_OUTPUT_DELAYED_EXIT = "1";
  const { service, live } = createService();
  const id = `goal-result-gap-${mode}`;
  try {
    await start(service, id, "claude-code");
    const pending = service.send(
      id,
      { text: "Goal gap", goal: { objective: "synthetic unfinished", maxTurns: 2 } },
      77,
    );
    await waitUntil(() => new core.SessionManager().readSessionState(id)?.turnCount === 1);
    assert.equal(live.filter(({ event }) => event.type === "turn_complete").length, 0);
    if (mode === "interrupt") await service.interrupt(id, 77);
    else if (mode === "stop") await service.stop(id, 77);
    else {
      delete process.env.CODESHELL_OUTPUT_DELAYED_EXIT;
      await start(service, id, "claude-code");
    }
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "aborted_streaming");
    assert.equal(live.filter(({ event }) => event.type === "turn_complete").length, 1);
    assert.equal(new core.SessionManager().readSessionState(id).status, "aborted_streaming");
    if (mode === "replace")
      assert.equal(
        (await service.send(id, { text: "next after Goal abort", disableGoal: true }, 77)).ok,
        true,
      );
    output.cases.push({
      case: `actual-claude-goal-result-gap-${mode}`,
      logicalTerminal: "aborted_streaming",
      falseSuccess: false,
    });
  } finally {
    delete process.env.CODESHELL_OUTPUT_DELAYED_EXIT;
    await service.stopAll();
  }
}

// A real MCP call starts without a turn, waits, and finishes during a new turn.
// Neither the lifetime fallback nor the new turn may receive its late output.
{
  process.env.CODESHELL_OUTPUT_DELAYED_TOOL = "1";
  let release, entered;
  const blocked = new Promise((done) => {
    release = done;
  });
  const ready = new Promise((done) => {
    entered = done;
  });
  const old = [],
    current = [];
  const registry = new core.ToolRegistry({
    toolCatalog: [
      {
        definition: {
          name: "DelayedRead",
          description: "synthetic",
          inputSchema: { type: "object", properties: {} },
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: true,
          isConcurrencySafe: true,
        },
        execute: async (_args, context) => {
          entered();
          await blocked;
          await context.streamCallback?.({ type: "text_delta", text: "UNOWNED-LATE-TOOL" });
          return "synthetic done";
        },
        exposure: {
          presetTags: ["general"],
          defaultPermissionRules: [{ tool: "DelayedRead", decision: "allow" }],
        },
      },
    ],
  });
  const session = await coding.startExternalRuntimeSession({
    kind: "codex",
    businessSessionId: "factory-bound",
    cwd: workspace,
    registry,
    permissionMode: "default",
    presetRules: [{ tool: "DelayedRead", decision: "allow" }],
    projectTrusted: true,
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["DelayedRead"]) },
    visibility: { cwd: workspace, hasGoal: false, host: "desktop", isSubAgent: false },
    contextOverrides: { streamCallback: (event) => old.push(event) },
    codexClient: { command: join(bin, "codex"), env: process.env },
    hooks: { onEvent: (event) => old.push(event) },
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("MCP fixture did not enter")), 10000).unref(),
      ),
    ]);
    const turn = await session.send({ text: "owned provider turn" }, (event) =>
      current.push(event),
    );
    release();
    await turn.done;
    await waitUntil(() => requests().some((entry) => entry.event === "old-tool-returned"));
    assert(
      ![...old, ...current].some(
        (event) =>
          (event.type === "text_delta" && event.text.includes("UNOWNED-LATE-TOOL")) ||
          event.type === "tool_use_start" ||
          event.type === "tool_result",
      ),
    );
    assert(current.some((event) => event.type === "text_delta"));
    output.cases.push({
      case: "real-mcp-unowned-delayed-tool",
      lateToolOutputFrames: 0,
      actualProviderOutput: true,
    });
  } finally {
    release();
    await session.close();
    delete process.env.CODESHELL_OUTPUT_DELAYED_TOOL;
  }
}

// In-place state replacement and delete/reuse are distinct from ordinary stop.
{
  const manager = new core.SessionManager();
  for (const mode of ["state-incarnation", "delete-reuse"]) {
    const id = `ownership-${mode}`;
    const recorder = new ExternalRuntimeSessionRecorder(id, workspace, "synthetic", "codex");
    const directory = join(core.sessionsRoot(), id);
    if (mode === "state-incarnation") {
      const state = manager.readSessionState(id);
      state.startedAt++;
      state.title = "replacement";
      writeFileSync(join(directory, "state.json"), JSON.stringify(state));
    } else {
      manager.incrementSessionGeneration(id);
      rmSync(directory, { recursive: true });
      manager.create(workspace, "synthetic", "codex", id);
    }
    const state = readFileSync(join(directory, "state.json"));
    const transcript = readFileSync(join(directory, "transcript.jsonl"));
    assert.throws(
      () => recorder.beginTurn({ text: "stale", clientMessageId: "stale-input" }),
      /owner/,
    );
    recorder.failOutput();
    assert(readFileSync(join(directory, "state.json")).equals(state));
    assert(readFileSync(join(directory, "transcript.jsonl")).equals(transcript));
    output.cases.push({ case: mode, zeroCanonicalWrites: true });
  }
}
output.requests = requests();
assert(
  output.requests
    .filter((entry) => entry.event === "physical-turn")
    .every(
      (entry) =>
        entry.homeHash === process.env.CODESHELL_OUTPUT_HOME_HASH && entry.ppid === process.pid,
    ),
);
const guard = readFileSync(process.env.CODESHELL_OUTPUT_GUARD_LOG, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const pids = new Set([
  process.pid,
  ...output.requests.map((entry) => entry.pid),
  ...output.cases.flatMap((entry) => (entry.cold ? [entry.cold.pid] : [])),
]);
assert(
  [...pids].every((pid) =>
    guard.some(
      (entry) =>
        entry.pid === pid &&
        entry.event === "pre-core" &&
        entry.negativeProbes === 4 &&
        entry.nodeVersion === process.versions.node &&
        entry.execPath === process.execPath &&
        entry.nodeBinaryHash === hash(readFileSync(process.execPath)) &&
        entry.homeHash === process.env.CODESHELL_OUTPUT_HOME_HASH,
    ),
  ),
);
output.guard = {
  observedPids: [...pids],
  negativeProbesPerProcess: 4,
  processLocalOnly: true,
  guardHash: hash(readFileSync(process.env.CODESHELL_OUTPUT_GUARD_LOG)),
};
writeFileSync(join(root, "native-receipt.json"), JSON.stringify(output, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify({ passed: true, cases: output.cases.length, ...identity() }));
