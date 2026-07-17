import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-session-kind";

class SessionKindClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, SessionKindClient);

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

describe("runExclusive session-kind pinning (run-workspace behavior snapshot)", () => {
  it("rejects a resume whose requested kind differs from the persisted kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-kind-"));
    try {
      const engine = makeEngine(dir);
      await engine.run("first turn", { sessionId: "s-kind-pin", cwd: dir });
      await expect(
        engine.run("second turn", {
          sessionId: "s-kind-pin",
          cwd: dir,
          kind: "quick-chat" as never,
        }),
      ).rejects.toThrow(/session kind mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the persisted kind when a resume omits options.kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-session-kind-"));
    try {
      const engine = makeEngine(dir);
      const first = await engine.run("first turn", { sessionId: "s-kind-reuse", cwd: dir });
      expect(first.reason).toBe("completed");
      const second = await engine.run("second turn", { sessionId: "s-kind-reuse", cwd: dir });
      expect(second.reason).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
