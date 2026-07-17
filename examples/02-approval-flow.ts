/**
 * 02 — Approval flow: gate tool calls through your own ApprovalBackend.
 *
 * Run with a real LLM:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/02-approval-flow.ts
 *
 * Run without credentials (scripted mock LLM issues one approved Write and
 * one denied Bash call, so you can watch the policy fire):
 *   bun run examples/02-approval-flow.ts --dry-run
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  LLMClientBase,
  registerProvider,
  type ApprovalBackend,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";

// Request/result shapes derived from the stable ApprovalBackend interface, so
// this file depends only on the public surface.
type ApprovalRequest = Parameters<ApprovalBackend["requestApproval"]>[0];
type ApprovalResult = Awaited<ReturnType<ApprovalBackend["requestApproval"]>>;

/**
 * Example policy: file edits (Write/Edit) are approved, everything else that
 * reaches the backend is denied. In production this is where you put your own
 * auth / audit / human-in-the-loop prompt.
 */
class PolicyApprovalBackend implements ApprovalBackend {
  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const allow = req.toolName === "Write" || req.toolName === "Edit";
    console.log(
      `[approval] ${req.toolName} (risk=${req.riskLevel}) → ${allow ? "APPROVED" : "DENIED"} — ${req.description}`,
    );
    return allow
      ? { approved: true }
      : { approved: false, reason: "example policy: only Write/Edit are approved" };
  }
}

const dryRun = process.argv.includes("--dry-run");

if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "No ANTHROPIC_API_KEY in the environment — nothing was run.",
      "",
      "Either export a key:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "or run the credential-free mock demo:",
      "  bun run examples/02-approval-flow.ts --dry-run",
    ].join("\n"),
  );
  process.exit(1);
}

// The demo works in a scratch directory so the approved Write never touches
// your working tree.
const workDir = mkdtempSync(join(tmpdir(), "codeshell-example-02-"));

if (dryRun) {
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-example-02-home-"));

  let mainCall = 0;
  class MockLLMClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      this.recordUsage(usage, options);
      if ((options.tools?.length ?? 0) === 0) {
        return { text: "mock summary", toolCalls: [], stopReason: "stop", usage };
      }
      mainCall += 1;
      if (mainCall === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-write-1",
              toolName: "Write",
              args: {
                file_path: join(workDir, "approval-demo.txt"),
                content: "hello from the approval-flow example\n",
              },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      if (mainCall === 2) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-bash-1",
              toolName: "Bash",
              args: { command: `rm -rf ${workDir}` },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      const text = "(mock) Write was approved by the policy; the rm command was denied. Done.";
      // Push the text through the streaming channel so onStream sees a
      // text_delta, exactly like a real provider would.
      options.onChunk?.({ type: "text", text });
      return { text, toolCalls: [], stopReason: "stop", usage };
    }
  }
  registerProvider("example-mock-approval", MockLLMClient);
}

const engine = new Engine({
  llm: dryRun
    ? { provider: "example-mock-approval", model: "example-mock-approval-1", apiKey: "unused" }
    : {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
  cwd: workDir,
  // "default" (NOT the engine's acceptEdits default) so file edits actually
  // route through the approval backend instead of being auto-accepted.
  permissionMode: "default",
  approvalBackend: new PolicyApprovalBackend(),
  headless: true,
});

const result = await engine.run(
  "Create a file named approval-demo.txt containing one greeting line, then try to delete this whole directory with rm. Report what was allowed and what was denied.",
  {
    onStream(event) {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  },
);

console.log("\n---");
console.log(`reason: ${result.reason} | turns: ${result.turnCount}`);
console.log(`scratch dir (inspect the approved write): ${workDir}`);
