import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(persistedState).toMatchObject({
      status: "completed",
      turnCount: 1,
      turnSeq: 1,
      completedSnapshotVersion: 1,
      tokenUsage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
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
