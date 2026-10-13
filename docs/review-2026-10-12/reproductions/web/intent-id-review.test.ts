import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Reject all fetch origins before importing Engine/worker-facing code.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("Network forbidden in review fixture");
}) as typeof fetch;
const { Engine } = await import("../../../../packages/core/src/engine/engine.ts");
const { LLMClientBase } = await import("../../../../packages/core/src/llm/client-base.ts");
const { registerProvider } = await import("../../../../packages/core/src/llm/client-factory.ts");
let calls = 0;
class FixtureProvider extends LLMClientBase {
  protected initClient() {}
  async createMessage(options: any) {
    if ((options.tools?.length ?? 0) > 0) calls++;
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: `fixture execution ${calls}`,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as any;
  }
}
registerProvider("review-fixture", FixtureProvider);
test("confirmed: completed native task replay is idempotent only when the original intent ID is retained", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-review-20261012-web-intent-"));
  const engine = new Engine({
    llm: { provider: "review-fixture", model: "fixture", apiKey: "fixture" } as any,
    cwd: directory,
    sessionStorageDir: join(directory, "sessions"),
    headless: true,
  });
  (engine as any).hooks.clear();
  try {
    const first = await engine.run("execute task once", {
      sessionId: "native",
      cwd: directory,
      clientMessageId: "first-uuid",
    });
    const same = await engine.run("execute task once", {
      sessionId: "native",
      cwd: directory,
      clientMessageId: "first-uuid",
    });
    expect(same).toEqual(first);
    expect(calls).toBe(1);
    const retry = await engine.run("execute task once", {
      sessionId: "native",
      cwd: directory,
      clientMessageId: "retry-uuid",
    });
    expect(retry.reason).toBe("completed");
    expect(calls).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
});
