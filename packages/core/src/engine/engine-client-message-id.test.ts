import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message } from "../types.js";

const fakeProvider = "fake-client-message-id";
interface Scenario {
  calls: Message[][];
  beforeReply?: (options: CreateMessageOptions) => Promise<void>;
}
const scenarios = new Map<string, Scenario>();

class FakeClientMessageIdClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    if ((options.tools?.length ?? 0) > 0) {
      scenario.calls.push(options.messages.map((message) => ({ ...message })));
      await scenario.beforeReply?.(options);
    }
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: `ok ${scenario.calls.length}`,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(fakeProvider, FakeClientMessageIdClient);

function makeEngine(): {
  engine: Engine;
  dir: string;
  scenario: Scenario;
  model: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "engine-client-message-id-"));
  const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
  const scenario: Scenario = { calls: [] };
  scenarios.set(model, scenario);
  const engine = new Engine({
    llm: { provider: fakeProvider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    headless: true,
  });
  (engine as any).hooks.clear();
  return { engine, dir, scenario, model };
}

function countExactText(messages: Message[], text: string): number {
  return messages.filter((message) => message.role === "user" && message.content === text).length;
}

describe("Engine clientMessageId submit idempotency", () => {
  it("reports an accepted input without a saved result as incomplete and permits a fresh intent", async () => {
    const { engine, dir, scenario, model } = makeEngine();
    await engine.dispose();
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../../../../tests/fixtures/client-message-crash.ts", import.meta.url).pathname,
        dir,
        model,
      ],
      { env: process.env, stdout: "ignore", stderr: "pipe" },
    );
    let restarted: Engine | undefined;
    try {
      const ready = join(dir, "crash-ready.json"),
        deadline = Date.now() + 15000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline || child.exitCode !== null) {
          child.kill("SIGKILL");
          await child.exited;
          throw new Error(
            "Crash fixture did not enter provider: " + (await new Response(child.stderr).text()),
          );
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(JSON.parse(readFileSync(ready, "utf8")).pid).toBe(child.pid);
      const transcriptPath = join(dir, "sessions", "s-incomplete", "transcript.jsonl");
      const interruptedTranscript = readFileSync(transcriptPath, "utf8");
      expect(interruptedTranscript).toContain("accepted-input");
      expect(interruptedTranscript).not.toContain('"type":"run_result"');
      child.kill("SIGKILL");
      await child.exited;
      restarted = new Engine({
        llm: { provider: fakeProvider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        headless: true,
      });
      restarted.getHookRegistry().clear();
      const replayed = await restarted.run("do recoverable work", {
        sessionId: "s-incomplete",
        cwd: dir,
        clientMessageId: "accepted-input",
      });
      expect(replayed.reason).toBe("replay_incomplete");
      expect(replayed.text).toContain("no final result was saved");
      expect(scenario.calls).toHaveLength(0);
      expect(readFileSync(transcriptPath, "utf8")).toBe(interruptedTranscript);
      const recovered = await restarted.run("do recoverable work", {
        sessionId: "s-incomplete",
        cwd: dir,
        clientMessageId: "fresh-attempt",
      });
      expect(recovered.reason).toBe("completed");
      expect(recovered.text).toBe("ok 1");
      expect(scenario.calls).toHaveLength(1);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await restarted?.dispose();
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a duplicate submit result after an engine restart", async () => {
    const { engine, dir, scenario, model } = makeEngine();
    try {
      const first = await engine.run("do once", {
        sessionId: "s-submit-id",
        cwd: dir,
        clientMessageId: "client-submit-1",
      });
      const restarted = new Engine({
        llm: { provider: fakeProvider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        headless: true,
      });
      (restarted as any).hooks.clear();
      const replayed = await restarted.run("do once retry", {
        sessionId: "s-submit-id",
        cwd: dir,
        clientMessageId: "client-submit-1",
      });

      expect(scenario.calls).toHaveLength(1);
      expect(countExactText(scenario.calls[0]!, "do once")).toBe(1);
      expect(countExactText(scenario.calls[0]!, "do once retry")).toBe(0);
      expect(replayed).toEqual(first);
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps distinct submits that do not provide a clientMessageId", async () => {
    const { engine, dir, scenario, model } = makeEngine();
    try {
      await engine.run("first without id", { sessionId: "s-submit-no-id", cwd: dir });
      await engine.run("second without id", { sessionId: "s-submit-no-id", cwd: dir });

      expect(scenario.calls).toHaveLength(2);
      expect(countExactText(scenario.calls[1]!, "first without id")).toBe(1);
      expect(countExactText(scenario.calls[1]!, "second without id")).toBe(1);
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
