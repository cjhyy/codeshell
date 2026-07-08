import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-todo-resume";

class TodoResumeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(provider, TodoResumeClient);

function uniqueModel(name: string): string {
  return `${provider}-${name}-${Date.now()}-${Math.random()}`;
}

function makeEngine(dir: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}

function taskUpdates(events: StreamEvent[]): Extract<StreamEvent, { type: "task_update" }>[] {
  return events.filter(
    (event): event is Extract<StreamEvent, { type: "task_update" }> =>
      event.type === "task_update",
  );
}

describe("Engine TodoWrite resume replay", () => {
  it("emits task_update for a non-empty latest TodoWrite snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-todo-resume-"));
    const model = uniqueModel("pending");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, model);
      const session = engine
        .getSessionManager()
        .create(dir, model, provider, "todo-resume-pending");
      session.transcript.appendToolUse("TodoWrite", "todo-1", {
        todos: [
          { content: "plan", status: "completed", activeForm: "planning" },
          { content: "implement", status: "in_progress", activeForm: "implementing" },
          { content: "test", status: "pending", activeForm: "testing" },
        ],
      });

      await engine.run("continue", {
        sessionId: "todo-resume-pending",
        cwd: dir,
        onStream: (event) => { events.push(event); },
      });

      const updates = taskUpdates(events);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.tasks).toEqual([
        { id: "1", subject: "plan", activeForm: "planning", status: "completed" },
        { id: "2", subject: "implement", activeForm: "implementing", status: "in_progress" },
        { id: "3", subject: "test", activeForm: "testing", status: "pending" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit task_update when the latest TodoWrite snapshot is all completed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-todo-resume-"));
    const model = uniqueModel("completed");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, model);
      const session = engine
        .getSessionManager()
        .create(dir, model, provider, "todo-resume-completed");
      session.transcript.appendToolUse("TodoWrite", "todo-1", {
        todos: [{ content: "finish", status: "completed", activeForm: "finishing" }],
      });

      await engine.run("continue", {
        sessionId: "todo-resume-completed",
        cwd: dir,
        onStream: (event) => { events.push(event); },
      });

      expect(taskUpdates(events)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the latest TodoWrite snapshot when multiple exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-todo-resume-"));
    const model = uniqueModel("latest");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, model);
      const session = engine.getSessionManager().create(dir, model, provider, "todo-resume-latest");
      session.transcript.appendToolUse("TodoWrite", "todo-1", {
        todos: [{ content: "old", status: "pending", activeForm: "olding" }],
      });
      session.transcript.appendToolUse("TodoWrite", "todo-2", {
        todos: [{ content: "new", status: "in_progress", activeForm: "newing" }],
      });

      await engine.run("continue", {
        sessionId: "todo-resume-latest",
        cwd: dir,
        onStream: (event) => { events.push(event); },
      });

      const updates = taskUpdates(events);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.tasks).toEqual([
        { id: "1", subject: "new", activeForm: "newing", status: "in_progress" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
