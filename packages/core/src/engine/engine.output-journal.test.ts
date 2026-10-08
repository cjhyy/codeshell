import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { StreamEvent } from "../types.js";
import { readOutputJournal } from "../session/output-journal.js";

const scenarios = new Map<string, () => void>();
class JournalFailureClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    if (options.stream) {
      scenarios.get(this.model)?.();
      // Deliberately model a third-party provider/observer that swallows a
      // streaming callback error and returns a superficially successful body.
      try {
        options.onChunk?.({ type: "text", text: "unpublished" });
      } catch {
        /* fixture */
      }
    }
    return {
      text: "superficially successful",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider("output-journal-fault-fixture", JournalFailureClient);

test("actual Engine rejects a swallowed journal write failure and never reports completed", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-engine-"));
  const model = `journal-${Date.now()}-${Math.random()}`;
  const file = join(root, "sessions", "fault", "output-journal.jsonl");
  const engine = new Engine({
    llm: { provider: "output-journal-fault-fixture", model, apiKey: "synthetic" } as never,
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    maxTurns: 1,
    behaviorProfiles: [
      {
        id: "journal-fixture",
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();
  let requests = 0;
  scenarios.set(model, () => {
    requests++;
    chmodSync(file, 0o400);
  });
  const events: StreamEvent[] = [];
  try {
    const result = await engine.run("Return a fixture confirmation", {
      sessionId: "fault",
      clientMessageId: "fault-submit",
      behaviorMode: "journal-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(result.reason).toBe("model_error");
    expect(
      events.some((event) => event.type === "turn_complete" && event.reason === "completed"),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "text_delta" && event.text === "unpublished"),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "turn_complete",
      reason: "model_error",
      outputRecovery: "incomplete",
    });
    const state = JSON.parse(readFileSync(join(root, "sessions", "fault", "state.json"), "utf8"));
    expect(state.status).toBe("model_error");
    expect(state.outputRecoveryIncomplete).toBe(true);
    expect(readOutputJournal(join(root, "sessions"), "fault").status).toBe("incomplete");
    chmodSync(file, 0o600);
    const next = await engine.run("A fresh intent cannot bypass a damaged output journal", {
      sessionId: "fault",
      clientMessageId: "second-intent",
      behaviorMode: "journal-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(next.reason).toBe("model_error");
    expect(requests).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_complete",
      reason: "model_error",
      outputRecovery: "incomplete",
    });
  } finally {
    scenarios.delete(model);
    chmodSync(file, 0o600);
    await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
