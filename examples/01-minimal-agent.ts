/**
 * 01 — Minimal agent: one Engine, one run, streamed output.
 *
 * Run with a real LLM (needs a key):
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/01-minimal-agent.ts
 *
 * Run without credentials (scripted mock LLM — demonstrates object assembly
 * and the streaming callback, no network):
 *   bun run examples/01-minimal-agent.ts --dry-run
 *
 * Inside this repo `bun install` is enough: the root tsconfig maps
 * @cjhyy/code-shell-core to packages/core/src, so no build step is needed.
 * Outside the repo, `npm install @cjhyy/code-shell-core` and the same code
 * works unchanged.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
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
      "  bun run examples/01-minimal-agent.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

if (dryRun) {
  // Keep example sessions/memory out of the user's real ~/.code-shell.
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-01-"));

  // registerProvider is the same public seam used to plug any custom or
  // OpenAI-protocol-compatible provider into the engine.
  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      // Auxiliary calls (summaries/titles) come in without tools — answer
      // them tersely so the demo output stays focused on the main turn.
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      const text =
        "(mock) I would list the files here — run me with a real API key to see it live.";
      // Push the text through the streaming channel so onStream sees a
      // text_delta, exactly like a real provider would.
      options.onChunk?.({ type: "text", text });
      return { text, toolCalls: [], stopReason: "stop", usage };
    }
  }
  registerProvider("example-mock", MockLLMClient);
}

const engine = new Engine({
  llm: dryRun
    ? { provider: "example-mock", model: "example-mock-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  cwd: process.cwd(),
  // Headless approval — "approve-read-only" keeps this demo safe: reads are
  // approved, writes and shell commands are denied. See
  // examples/02-approval-flow.ts for a custom ApprovalBackend.
  approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
  headless: true,
});

const result = await engine.run(
  "List the files in the current directory and summarise their purpose in two sentences.",
  {
    onStream(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
      if (event.type === "tool_use_start") console.log("\n→ tool:", event.toolCall.toolName);
    },
  },
);

console.log("\n---");
console.log(
  `reason: ${result.reason} | turns: ${result.turnCount} | tokens: ${result.usage.totalTokens}`,
);
