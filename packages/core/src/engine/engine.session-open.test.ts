import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-session-open";

class SessionOpenClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, SessionOpenClient);

function makeEngine(dir: string): Engine {
  const engine = new Engine({
    llm: {
      provider,
      model: `${provider}-${Date.now()}-${Math.random()}`,
      apiKey: "test",
    } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    headless: true,
  });
  (engine as unknown as { hooks: { clear(): void } }).hooks.clear();
  return engine;
}

describe("runExclusive session open (run-session-open behavior snapshot)", () => {
  it("stamps the first 80 chars of the first user message as the session summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-open-"));
    try {
      const engine = makeEngine(dir);
      const task =
        "Summarize the repository layout for me please, including packages, scripts and docs directories in detail";
      const result = await engine.run(task, { sessionId: "s-open-summary", cwd: dir });
      expect(result.reason).toBe("completed");
      const state = JSON.parse(
        readFileSync(join(dir, "sessions", "s-open-summary", "state.json"), "utf8"),
      ) as { summary?: string; turnSeq?: number };
      expect(state.summary).toBe(task.slice(0, 80).replace(/\n/g, " "));
      expect(state.turnSeq).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("increments turnSeq on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-open-"));
    try {
      const engine = makeEngine(dir);
      await engine.run("first", { sessionId: "s-open-seq", cwd: dir });
      await engine.run("second", { sessionId: "s-open-seq", cwd: dir });
      const state = JSON.parse(
        readFileSync(join(dir, "sessions", "s-open-seq", "state.json"), "utf8"),
      ) as { turnSeq?: number };
      expect(state.turnSeq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
