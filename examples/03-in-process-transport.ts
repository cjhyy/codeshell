/**
 * 03 — Recommended public API (B3/§S7): createServer/createClient over an
 * in-process transport. This is the protocol-mediated construction path the
 * project tests, documents, and avoids breaking — prefer it over direct
 * `new Engine(...)` when embedding.
 *
 * Run with a real LLM:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/03-in-process-transport.ts
 *
 * Run without credentials:
 *   bun run examples/03-in-process-transport.ts --dry-run
 *
 * For an out-of-process worker, swap createInProcessTransport() for a
 * StdioTransport pair — the factories accept any Transport.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  createInProcessTransport,
  createServer,
  HeadlessApprovalBackend,
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "No ANTHROPIC_API_KEY in the environment — nothing was run.",
      "",
      "Either export a key:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "or run the credential-free mock demo:",
      "  bun run examples/03-in-process-transport.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

if (dryRun) {
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-03-"));

  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      const text = "(mock) README summary would stream here — run with a real key.";
      // Push the text through the streaming channel so onStreamEvent sees a
      // text_delta, exactly like a real provider would.
      options.onChunk?.({ type: "text", text });
      return { text, toolCalls: [], stopReason: "stop", usage };
    }
  }
  registerProvider("example-mock-transport", MockLLMClient);
}

const [serverTransport, clientTransport] = createInProcessTransport();

const handle = createServer({
  transport: serverTransport,
  cwd: process.cwd(),
  llm: dryRun
    ? { provider: "example-mock-transport", model: "example-mock-transport-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  permissionMode: "default",
  // Escape hatch for EngineConfig fields the flat options don't expose.
  engineOverrides: {
    headless: true,
    approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
  },
});

const client = createClient({ transport: clientTransport });

client.onStreamEvent(({ event }) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});

const result = await client.run({
  sessionId: "example-main",
  task: "Summarize README.md in three bullet points.",
});

console.log("\n---");
console.log(`reason: ${result.reason} | turns: ${result.turnCount}`);

handle.close();
client.close();
