import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../session/memory.js";
import { recordSession } from "./auto-dream.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { loadSessionMemory, saveSessionMemory } from "./session-memory.js";

let baseDir: string;
let projectDir: string;
let current: boolean;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "memory-custody-"));
  projectDir = join(baseDir, "project");
  current = true;
});
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

function assertCurrent(): void {
  if (!current) throw new Error("Session custody was revoked");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const messages = [
  { role: "user", content: "original intent" },
  { role: "assistant", content: "initial answer" },
  { role: "user", content: "latest correction" },
];
const summary = {
  sessionId: "guarded-session",
  summary: "prior verified summary",
  keyTopics: ["verified"],
  decisions: ["retain the prior outcome"],
  createdAt: "2026-10-01T00:00:00.000Z",
};
const candidate = {
  type: "project",
  scope: "project",
  name: "shared-topic",
  description: "same durable topic",
  content: "new replacement body",
};

function seedMemory() {
  const manager = new MemoryManager({ baseDir, projectDir, scope: "dream" });
  manager.save({
    type: "project",
    name: candidate.name,
    description: candidate.description,
    content: "original verified body",
    origin: "auto",
  });
  return manager;
}

describe("MemoryOrchestrator background custody", () => {
  test("pre-revoked custody issues no request and creates no bookkeeping", async () => {
    current = false;
    let calls = 0;
    const orchestrator = new MemoryOrchestrator({
      baseDir,
      projectDir,
      assertCurrent,
      callLLM: async () => {
        calls++;
        return "[]";
      },
    });

    await expect(orchestrator.run(messages, summary.sessionId)).rejects.toThrow(
      "no longer current",
    );
    expect(calls).toBe(0);
    expect(existsSync(join(baseDir, "auto-dream-state.json"))).toBe(false);
    expect(loadSessionMemory(summary.sessionId, baseDir)).toBeNull();
  });

  test("a late valid extraction cannot persist facts, replace a summary, or advance dream state", async () => {
    const manager = seedMemory();
    const before = manager.loadAll();
    saveSessionMemory(summary, baseDir);
    const entered = deferred<void>();
    const response = deferred<string>();
    let calls = 0;
    const orchestrator = new MemoryOrchestrator({
      baseDir,
      projectDir,
      assertCurrent,
      callLLM: async () => {
        calls++;
        entered.resolve();
        return response.promise;
      },
    });
    const pending = orchestrator.run(messages, summary.sessionId);
    await entered.promise;
    current = false;
    response.resolve(JSON.stringify([candidate]));

    await expect(pending).rejects.toThrow("no longer current");
    expect(calls).toBe(1);
    expect(manager.loadAll()).toEqual(before);
    expect(loadSessionMemory(summary.sessionId, baseDir)).toEqual(summary);
    expect(existsSync(join(baseDir, "auto-dream-state.json"))).toBe(false);
  });

  test.each(["ADD", "UPDATE", "DELETE"])(
    "a late %s decision cannot fall back to a write after revocation",
    async (action) => {
      const manager = seedMemory();
      const before = manager.loadAll();
      saveSessionMemory(summary, baseDir);
      const entered = deferred<void>();
      const decision = deferred<string>();
      let calls = 0;
      const orchestrator = new MemoryOrchestrator({
        baseDir,
        projectDir,
        assertCurrent,
        callLLM: async (system) => {
          calls++;
          if (system.includes("write decision")) {
            entered.resolve();
            return decision.promise;
          }
          return JSON.stringify([candidate]);
        },
      });
      const pending = orchestrator.run(messages, summary.sessionId);
      await entered.promise;
      current = false;
      decision.resolve(
        JSON.stringify({
          action,
          target: { id: before[0]!.id, location: "project", scope: "dream" },
        }),
      );

      await expect(pending).rejects.toThrow("no longer current");
      expect(calls).toBe(2);
      expect(manager.loadAll()).toEqual(before);
      expect(loadSessionMemory(summary.sessionId, baseDir)).toEqual(summary);
      expect(existsSync(join(baseDir, "auto-dream-state.json"))).toBe(false);
    },
  );

  test.each([false, true])(
    "a late session-summary outcome cannot replace prior data (request rejects: %s)",
    async (rejects) => {
      saveSessionMemory(summary, baseDir);
      const entered = deferred<void>();
      const response = deferred<string>();
      let calls = 0;
      const orchestrator = new MemoryOrchestrator({
        baseDir,
        projectDir,
        assertCurrent,
        autoExtract: false,
        callLLM: async () => {
          calls++;
          entered.resolve();
          return response.promise;
        },
      });
      const pending = orchestrator.run(messages, summary.sessionId);
      await entered.promise;
      current = false;
      if (rejects) response.reject(new Error("Model request was aborted"));
      else response.resolve(JSON.stringify({ ...summary, summary: "late replacement" }));

      await expect(pending).rejects.toThrow("no longer current");
      expect(calls).toBe(1);
      expect(loadSessionMemory(summary.sessionId, baseDir)).toEqual(summary);
      expect(existsSync(join(baseDir, "auto-dream-state.json"))).toBe(false);
    },
  );

  test("a late dream completion cannot reset cadence or continue into TTL mutations", async () => {
    const manager = seedMemory();
    const beforeMemory = manager.loadAll();
    for (let index = 0; index < 5; index++) recordSession(baseDir);
    const entered = deferred<void>();
    const response = deferred<boolean>();
    const orchestrator = new MemoryOrchestrator({
      baseDir,
      projectDir,
      memoryManager: manager,
      assertCurrent,
      autoExtract: false,
      recallTtlDays: 1,
      callLLM: async () => {
        throw new Error("No auxiliary model request expected");
      },
      runDream: async () => {
        entered.resolve();
        return response.promise;
      },
    });
    const pending = orchestrator.run(messages.slice(0, 1), summary.sessionId);
    await entered.promise;
    const beforeCadence = readFileSync(join(baseDir, "auto-dream-state.json"), "utf8");
    current = false;
    response.resolve(true);

    await expect(pending).rejects.toThrow("no longer current");
    expect(manager.loadAll()).toEqual(beforeMemory);
    expect(readFileSync(join(baseDir, "auto-dream-state.json"), "utf8")).toBe(beforeCadence);
  });
});
