import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import { getCurrentSid, logger, setLogsDir } from "../logging/logger.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const fakeProvider = "fake-sid-isolation";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Scenario = {
  sidAtModelCall: string[];
  enteredBoth: Deferred;
  release: Deferred;
};

const scenarios = new Map<string, Scenario>();

class SidIsolationClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);

    scenario.sidAtModelCall.push(getCurrentSid());
    if (scenario.sidAtModelCall.length === 2) scenario.enteredBoth.resolve();
    await scenario.release.promise;

    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: `ok ${getCurrentSid()}`,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(fakeProvider, SidIsolationClient);

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label)), ms);
  });
}

function makeEngine(cwd: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider: fakeProvider, model, apiKey: "test" } as never,
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}

describe("Engine.run sid isolation", () => {
  it("does not let concurrent runs overwrite the module fallback sid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-sid-isolation-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const scenario: Scenario = {
      sidAtModelCall: [],
      enteredBoth: deferred(),
      release: deferred(),
    };
    const previousSid = getCurrentSid();
    const savedHome = process.env.HOME;
    scenarios.set(model, scenario);

    try {
      process.env.HOME = dir;
      setLogsDir(join(dir, "logs"));
      logger.setSid("outside-fallback");

      const engineA = makeEngine(dir, model);
      const engineB = makeEngine(dir, model);
      const runA = engineA.run("run A", { sessionId: "sid-a", cwd: dir });
      const runB = engineB.run("run B", { sessionId: "sid-b", cwd: dir });

      await Promise.race([
        scenario.enteredBoth.promise,
        timeout(5_000, "timed out waiting for both model calls"),
      ]);

      expect([...scenario.sidAtModelCall].sort()).toEqual(["sid-a", "sid-b"]);
      expect(getCurrentSid()).toBe("outside-fallback");

      scenario.release.resolve();
      const [resultA, resultB] = await Promise.all([runA, runB]);
      expect(resultA.sessionId).toBe("sid-a");
      expect(resultB.sessionId).toBe("sid-b");
    } finally {
      scenario.release.resolve();
      scenarios.delete(model);
      logger.setSid(previousSid);
      setLogsDir(null);
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
