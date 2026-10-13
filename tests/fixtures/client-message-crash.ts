import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../scripts/runtime-cost-smoke-isolation.mjs";
installLocalNetworkGuard("http://127.0.0.1:9");
const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider } = await import("../../packages/core/src/llm/client-factory.js");
const [directory, model] = process.argv.slice(2);
class InterruptedClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage() {
    writeFileSync(join(directory, "crash-ready.json"), JSON.stringify({ pid: process.pid }));
    // Keep the actual process alive at the accepted, no-result prefix until
    // the parent kills it. No backup/copy substitutes a different storage scope.
    await new Promise(() => setInterval(() => {}, 1000));
    throw new Error("unreachable");
  }
}
registerProvider("fake-client-message-id", InterruptedClient);
const engine = new Engine({
  llm: { provider: "fake-client-message-id", model, apiKey: "synthetic" } as never,
  cwd: directory,
  sessionStorageDir: join(directory, "sessions"),
  headless: true,
});
engine.getHookRegistry().clear();
await engine.run("do recoverable work", {
  sessionId: "s-incomplete",
  cwd: directory,
  clientMessageId: "accepted-input",
});
