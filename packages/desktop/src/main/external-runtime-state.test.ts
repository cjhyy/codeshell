import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutputJournal } from "@cjhyy/code-shell-core/internal";
import { SessionManager } from "@cjhyy/code-shell-core";
import {
  ExternalRuntimeSessionRecorder,
  readExternalRuntimeBinding,
  removeExternalRuntimeBinding,
  writeExternalRuntimeBinding,
} from "./external-runtime-state.js";

let testHome = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  testHome = mkdtempSync(join(tmpdir(), "codeshell-external-state-"));
  process.env.CODE_SHELL_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("external runtime durable state", () => {
  test("records one canonical turn with attachments, tools, usage, and completion", () => {
    const recorder = new ExternalRuntimeSessionRecorder(
      "external-state-test",
      "/tmp/project",
      "codex/gpt-test",
      "codex",
    );
    recorder.beginTurn({
      text: "inspect this",
      displayText: "【Panel】 Inspect resume",
      clientMessageId: "client-1",
      attachments: [{ path: "/tmp/project/resume.pdf", kind: "file" }],
    });
    recorder.onEvent({ type: "text_delta", text: "Looking." });
    recorder.onEvent({
      type: "tool_use_start",
      toolCall: { id: "tool-1", toolName: "DriveAgent", args: { prompt: "inspect" } },
    });
    recorder.onEvent({
      type: "tool_result",
      result: { id: "tool-1", toolName: "DriveAgent", result: "done" },
    });
    recorder.onEvent({ type: "text_delta", text: " Finished." });
    recorder.onEvent({
      type: "usage_update",
      promptTokens: 3,
      completionTokens: 2,
      cumulativePromptTokens: 10,
      cumulativeCompletionTokens: 4,
      promptTokensSource: "provider_usage",
    });
    recorder.onEvent({ type: "turn_complete", reason: "completed" });

    expect(recorder.finishIfMissing()).toMatchObject({
      ok: true,
      reason: "completed",
      text: "Looking. Finished.",
      streamed: true,
    });
    const manager = new SessionManager();
    const persistedState = manager.readSessionState("external-state-test");
    const bundle = manager.resume("external-state-test");
    const events = bundle.transcript.getEvents();
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "message" &&
          event.data.role === "assistant" &&
          Array.isArray(event.data.content) &&
          event.data.content.some((block) => block.type === "tool_use"),
      ),
    ).toHaveLength(1);
    const user = events.find((event) => event.type === "message" && event.data.role === "user");
    expect(JSON.stringify(user?.data.content)).toContain("/tmp/project/resume.pdf");
    expect(user?.data.displayText).toBe("【Panel】 Inspect resume");
    expect(persistedState).toMatchObject({
      status: "completed",
      turnCount: 1,
      turnSeq: 1,
      completedSnapshotVersion: 1,
      tokenUsage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
  });

  test("marks an injected continuation so replay does not present it as user input", () => {
    const recorder = new ExternalRuntimeSessionRecorder(
      "external-injected-turn-test",
      "/tmp/project",
      "codex/gpt-test",
      "codex",
    );
    recorder.beginTurn({
      text: "<system-reminder>background review complete</system-reminder>",
      injected: true,
    });
    recorder.onEvent({ type: "turn_complete", reason: "completed" });

    const events = new SessionManager()
      .resume("external-injected-turn-test")
      .transcript.getEvents();
    expect(
      events.find((event) => event.type === "message" && event.data.role === "user"),
    ).toMatchObject({ data: { injected: true } });
  });

  test("writes, reads, and removes the runtime thread binding", () => {
    new ExternalRuntimeSessionRecorder(
      "external-binding-test",
      "/tmp/project",
      "codex/gpt-test",
      "codex",
    );
    writeExternalRuntimeBinding("external-binding-test", {
      kind: "codex",
      cwd: "/tmp/project",
      model: "gpt-test",
      runtimeSessionId: "thread-123",
    });
    expect(readExternalRuntimeBinding("external-binding-test")).toMatchObject({
      version: 1,
      runtimeSessionId: "thread-123",
    });
    removeExternalRuntimeBinding("external-binding-test");
    expect(readExternalRuntimeBinding("external-binding-test")).toBeUndefined();
  });

  test("refuses to retarget an existing business session to another project", () => {
    new ExternalRuntimeSessionRecorder(
      "external-project-fence-test",
      "/tmp/project-a",
      "codex/gpt-test",
      "codex",
    );
    expect(
      () =>
        new ExternalRuntimeSessionRecorder(
          "external-project-fence-test",
          "/tmp/project-b",
          "codex/gpt-test",
          "codex",
        ),
    ).toThrow(/project mismatch/);
  });

  test("persists stable project authority for a new external runtime session", () => {
    const project = { projectId: "project-1", mainRootId: "root-1" };
    new ExternalRuntimeSessionRecorder(
      "external-project-binding-test",
      "/tmp/project",
      "codex/gpt-test",
      "codex",
      project,
    );

    expect(new SessionManager().readSessionState("external-project-binding-test")?.project).toEqual(
      project,
    );
  });

  test("safely upgrades a matching cwd-only external runtime session", () => {
    const sessionId = "external-project-upgrade-test";
    const project = { projectId: "project-1", mainRootId: "root-1" };
    new SessionManager().create("/tmp/project", "codex/gpt-test", "codex", sessionId);

    new ExternalRuntimeSessionRecorder(
      sessionId,
      "/tmp/project",
      "codex/gpt-test",
      "codex",
      project,
    );

    expect(new SessionManager().readSessionState(sessionId)).toMatchObject({
      cwd: "/tmp/project",
      workspace: { root: "/tmp/project", kind: "main" },
      project,
    });
  });

  test("refuses to replace an existing stable project binding", () => {
    const sessionId = "external-project-binding-fence-test";
    new ExternalRuntimeSessionRecorder(sessionId, "/tmp/project", "codex/gpt-test", "codex", {
      projectId: "project-1",
      mainRootId: "root-1",
    });

    expect(
      () =>
        new ExternalRuntimeSessionRecorder(sessionId, "/tmp/project", "codex/gpt-test", "codex", {
          projectId: "project-2",
          mainRootId: "root-2",
        }),
    ).toThrow(/project binding mismatch/);
  });

  test("cleans up the atomic-write temp file when binding replacement fails", () => {
    const sessionId = "external-binding-failure-test";
    new ExternalRuntimeSessionRecorder(sessionId, "/tmp/project", "codex/gpt-test", "codex");
    const sessionDir = join(testHome, "sessions", sessionId);
    mkdirSync(join(sessionDir, "external-runtime.json"));

    expect(() =>
      writeExternalRuntimeBinding(sessionId, {
        kind: "codex",
        cwd: "/tmp/project",
        model: "gpt-test",
        runtimeSessionId: "thread-123",
      }),
    ).toThrow();
    expect(readdirSync(sessionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects dot-segment session ids and oversized or malformed bindings", () => {
    expect(readExternalRuntimeBinding(".")).toBeUndefined();
    expect(readExternalRuntimeBinding("..")).toBeUndefined();

    const sessionId = "external-invalid-binding";
    new ExternalRuntimeSessionRecorder(sessionId, "/tmp/project", "codex/gpt-test", "codex");
    const file = join(testHome, "sessions", sessionId, "external-runtime.json");
    writeFileSync(file, "x".repeat(65 * 1024));
    expect(readExternalRuntimeBinding(sessionId)).toBeUndefined();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        kind: "codex",
        cwd: "/tmp/project",
        runtimeSessionId: { forged: true },
        updatedAt: 1,
      }),
    );
    expect(readExternalRuntimeBinding(sessionId)).toBeUndefined();
  });

  test("does not follow a symlinked session directory", () => {
    if (process.platform === "win32") return;
    const root = join(testHome, "sessions");
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "codeshell-external-outside-"));
    try {
      writeFileSync(
        join(outside, "external-runtime.json"),
        JSON.stringify({
          version: 1,
          kind: "codex",
          cwd: "/tmp/project",
          runtimeSessionId: "secret-thread",
          updatedAt: 1,
        }),
      );
      symlinkSync(outside, join(root, "linked-session"));
      expect(readExternalRuntimeBinding("linked-session")).toBeUndefined();
      expect(() =>
        writeExternalRuntimeBinding("linked-session", {
          kind: "codex",
          cwd: "/tmp/project",
          runtimeSessionId: "replacement",
        }),
      ).toThrow(/session directory/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accumulates providers that report per-turn rather than cumulative usage", () => {
    const recorder = new ExternalRuntimeSessionRecorder(
      "external-usage-test",
      "/tmp/project",
      "claude-code/default",
      "claude-code",
    );
    recorder.beginTurn({ text: "first" });
    recorder.onEvent({
      type: "usage_update",
      promptTokens: 5,
      completionTokens: 2,
      promptTokensSource: "provider_usage",
    });
    recorder.onEvent({ type: "turn_complete", reason: "completed" });
    recorder.beginTurn({ text: "second" });
    recorder.onEvent({
      type: "usage_update",
      promptTokens: 7,
      completionTokens: 3,
      promptTokensSource: "provider_usage",
    });
    recorder.onEvent({ type: "turn_complete", reason: "completed" });

    expect(new SessionManager().readSessionState("external-usage-test")?.tokenUsage).toMatchObject({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
    });
  });

  test("resets the model accounting window without decreasing whole-session usage", () => {
    const first = new ExternalRuntimeSessionRecorder(
      "external-model-switch-test",
      "/tmp/project",
      "codex/model-a",
      "codex",
    );
    first.beginTurn({ text: "first" });
    first.onEvent({
      type: "usage_update",
      promptTokens: 100,
      cumulativePromptTokens: 100,
      promptTokensSource: "provider_usage",
    });
    first.onEvent({ type: "turn_complete", reason: "completed" });

    const second = new ExternalRuntimeSessionRecorder(
      "external-model-switch-test",
      "/tmp/project",
      "codex/model-b",
      "codex",
    );
    second.beginTurn({ text: "second" });
    second.onEvent({
      type: "usage_update",
      promptTokens: 5,
      cumulativePromptTokens: 5,
      promptTokensSource: "provider_usage",
    });
    second.onEvent({ type: "turn_complete", reason: "completed" });

    expect(new SessionManager().readSessionState("external-model-switch-test")).toMatchObject({
      model: "codex/model-b",
      provider: "codex",
      tokenUsage: { promptTokens: 5 },
      cumulativePromptTokens: 105,
    });
  });
});

describe("external runtime tool argument recording", () => {
  test("records the arguments that arrive after tool_use_start", () => {
    // Codex/Claude Code open a tool item BEFORE its arguments are known: the
    // codex translator sees `query: ""` on item/started, and the claude-code
    // translator opens with `args: {}` and streams the real input later as a
    // tool_use_args_delta. The recorder used to persist only the opening
    // snapshot, so transcripts showed `webSearch {"query": ""}` and
    // `Bash {}` — the runtime's actual commands were unauditable.
    const recorder = new ExternalRuntimeSessionRecorder(
      "external-args-test",
      "/tmp/project",
      "codex/gpt-test",
      "codex",
    );
    recorder.beginTurn({ text: "search it", clientMessageId: "client-args" });
    recorder.onEvent({
      type: "tool_use_start",
      toolCall: { id: "tool-1", toolName: "webSearch", args: { query: "" } },
    });
    recorder.onEvent({
      type: "tool_use_args_delta",
      toolCallId: "tool-1",
      args: { query: "紫金矿业 2026 半年报" },
    });
    recorder.onEvent({
      type: "tool_result",
      result: { id: "tool-1", toolName: "webSearch", result: "ok" },
    });
    recorder.onEvent({ type: "turn_complete", reason: "completed" });
    recorder.finishIfMissing();

    const events = new SessionManager().resume("external-args-test").transcript.getEvents();
    const toolUses = events.filter((event) => event.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]?.data.args).toEqual({ query: "紫金矿业 2026 半年报" });
    // The assistant message block must carry the real input too — that block is
    // what a resumed turn replays back to the model.
    const block = events
      .flatMap((event) =>
        event.type === "message" && Array.isArray(event.data.content) ? event.data.content : [],
      )
      .find((b) => b.type === "tool_use");
    expect(block?.input).toEqual({ query: "紫金矿业 2026 半年报" });
  });
});

test("one logical Goal run keeps its actual first user anchor and one terminal", () => {
  const recorder = new ExternalRuntimeSessionRecorder(
    "goal-journal",
    "/tmp/project",
    "fixture",
    "codex",
  );
  recorder.beginTurn({ text: "original", displayText: "short", clientMessageId: "logical-client" });
  const manager = new SessionManager();
  const firstRun = manager.readSessionState("goal-journal")!.runId;
  recorder.onEvent({ type: "text_delta", text: "first" });
  recorder.onEvent({ type: "turn_complete", reason: "completed" }, true);
  expect(manager.readSessionState("goal-journal")!.status).toBe("active");
  recorder.beginTurn({ text: "continue", injected: true }, true);
  recorder.onEvent({ type: "text_delta", text: "second" });
  recorder.onEvent({ type: "turn_complete", reason: "completed" }, true);
  recorder.completeRun("completed");
  expect(recorder.completeRun("completed")).toBeUndefined();
  const state = manager.readSessionState("goal-journal")!;
  const events = manager.resume("goal-journal").transcript.getEvents();
  expect(state.runId).toBe(firstRun);
  expect(firstRun).toBe(
    events.find((event) => event.type === "message" && event.data.role === "user")!.id,
  );
  expect(state).toMatchObject({
    clientMessageId: "logical-client",
    turnSeq: 1,
    turnCount: 2,
    status: "completed",
  });
  const page = readOutputJournal(manager.getStorageDir(), "goal-journal");
  expect(page.status).toBe("ok");
  const raw = readFileSync(
    join(manager.getStorageDir(), "goal-journal", "output-journal.jsonl"),
    "utf8",
  );
  expect(raw.match(/"type":"turn_complete"/g)).toHaveLength(1);
  expect(raw).toContain('"injected":true');
});

test("superseded and closed recorders cannot append canonical output or replace metadata", () => {
  const recorder = new ExternalRuntimeSessionRecorder(
    "owner-fence",
    "/tmp/project",
    "fixture",
    "codex",
  );
  recorder.beginTurn({ text: "first" });
  const manager = new SessionManager();
  const bundle = manager.resume("owner-fence");
  manager.startSessionRun(bundle.state, "new-owner");
  manager.updateSessionState(
    "owner-fence",
    {
      title: "new title",
      tokenUsage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
    },
    "new-owner",
  );
  const path = join(manager.getStorageDir(), "owner-fence", "transcript.jsonl");
  const before = readFileSync(path);
  expect(() => recorder.onEvent({ type: "text_delta", text: "late old" })).toThrow(/owner/);
  recorder.failOutput();
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(manager.readSessionState("owner-fence")).toMatchObject({
    runId: "new-owner",
    title: "new title",
    status: "active",
    tokenUsage: { promptTokens: 200 },
  });
  const closed = new ExternalRuntimeSessionRecorder(
    "close-fence",
    "/tmp/project",
    "fixture",
    "codex",
  );
  closed.beginTurn({ text: "first" });
  manager.incrementSessionGeneration("close-fence");
  expect(() => closed.onEvent({ type: "turn_complete", reason: "completed" })).toThrow(/closed/);
});

test("provider usage merges with latest auxiliary accounting and preserves domain metadata", () => {
  const recorder = new ExternalRuntimeSessionRecorder(
    "accounting-journal",
    "/tmp/project",
    "fixture",
    "codex",
  );
  recorder.beginTurn({ text: "first" });
  recorder.onEvent({ type: "usage_update", promptTokens: 10, completionTokens: 2 });
  const manager = new SessionManager();
  manager.recordAuxiliaryUsage(
    "accounting-journal",
    { promptTokens: 30, completionTokens: 4, totalTokens: 34 },
    { marker: "latest" },
  );
  manager.updateSessionState("accounting-journal", {
    title: "retained",
    summary: "latest summary",
  });
  recorder.onEvent({ type: "turn_complete", reason: "completed" });
  expect(manager.readSessionState("accounting-journal")).toMatchObject({
    title: "retained",
    summary: "latest summary",
    costState: { marker: "latest" },
    tokenUsage: { promptTokens: 40, completionTokens: 6, totalTokens: 46 },
    cumulativePromptTokens: 40,
  });
});

test("owned run CAS recomputes its delta after an actual competing durable update", () => {
  const manager = new SessionManager();
  const other = new SessionManager();
  const bundle = manager.create("/tmp/project", "fixture", "fixture", "run-cas");
  manager.startSessionRun(bundle.state, "actual-run");
  let reads = 0;
  manager.updateSessionRunState("run-cas", "actual-run", (state) => {
    if (++reads === 1)
      other.recordAuxiliaryUsage("run-cas", {
        promptTokens: 30,
        completionTokens: 2,
        totalTokens: 32,
      });
    return { cumulativePromptTokens: (state.cumulativePromptTokens ?? 0) + 10 };
  });
  expect(reads).toBe(2);
  expect(manager.readSessionState("run-cas")?.cumulativePromptTokens).toBe(40);
  expect(() =>
    manager.updateSessionRunState("run-cas", "old-run", () => ({ title: "stale" })),
  ).toThrow(/identity conflict/);
});

test("deleting and reusing a Session id never grants its old recorder the new directory", () => {
  const recorder = new ExternalRuntimeSessionRecorder(
    "reuse-output",
    "/tmp/project",
    "fixture",
    "codex",
  );
  recorder.beginTurn({ text: "old" });
  const manager = new SessionManager();
  const directory = join(manager.getStorageDir(), "reuse-output");
  rmSync(directory, { recursive: true });
  const replacement = manager.create("/tmp/project", "fixture", "fixture", "reuse-output");
  manager.startSessionRun(replacement.state, "replacement");
  const before = readFileSync(join(directory, "transcript.jsonl"));
  expect(() =>
    recorder.onEvent({
      type: "tool_result",
      result: { id: "old-tool", toolName: "Read", result: "late" },
    }),
  ).toThrow(/owner/);
  recorder.failOutput();
  expect(readFileSync(join(directory, "transcript.jsonl")).equals(before)).toBe(true);
  expect(manager.readSessionState("reuse-output")?.runId).toBe("replacement");
  expect(manager.readSessionState("reuse-output")?.outputRecoveryIncomplete).not.toBe(true);
});

test("first input refuses a replaced state incarnation before canonical append", () => {
  const recorder = new ExternalRuntimeSessionRecorder(
    "first-input-incarnation",
    "/tmp/project",
    "fixture",
    "codex",
  );
  const manager = new SessionManager();
  const directory = join(manager.getStorageDir(), "first-input-incarnation");
  const statePath = join(directory, "state.json");
  const replacement = JSON.parse(readFileSync(statePath, "utf8"));
  replacement.startedAt += 1;
  replacement.title = "replacement metadata";
  writeFileSync(statePath, JSON.stringify(replacement));
  const transcript = readFileSync(join(directory, "transcript.jsonl"));
  const state = readFileSync(statePath);
  expect(() =>
    recorder.beginTurn({ text: "stale first input", clientMessageId: "old-input" }),
  ).toThrow(/owner/);
  recorder.failOutput();
  expect(readFileSync(join(directory, "transcript.jsonl")).equals(transcript)).toBe(true);
  expect(readFileSync(statePath).equals(state)).toBe(true);
});
