import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
