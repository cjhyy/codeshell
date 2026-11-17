import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
} from "@cjhyy/code-shell-core";
import { createCodingModule } from "@cjhyy/code-shell-capability-coding";

const provider = "coding-cross-session-head";
const requests: CreateMessageOptions[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    if (options.tools?.length) {
      const { signal: _signal, onChunk: _onChunk, ...captured } = options;
      requests.push(structuredClone(captured));
    }
    return { text: "done", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, Client);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  requests.length = 0;
});

test("terminal-coding Sessions with different task text share one head", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-cross-session-head-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "CODESHELL.md"), "# Project\nUse bun.\n");
  const engine = new Engine({
    llm: { provider, providerKind: "openai", model: "gpt-6-sol", apiKey: "fixture" } as never,
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    modules: [createCodingModule()],
    preset: "terminal-coding",
    headless: true,
    permissionMode: "bypassPermissions",
    maxTurns: 3,
  });
  cleanups.push(() => engine.dispose());
  const tasks = [
    "hello",
    "Fix the failing test and refactor the parser", // coding route
    "Create a worktree branch for this", // worktree route
    "Research the website docs", // research route
  ];
  for (const [index, task] of tasks.entries()) {
    expect((await engine.run(task, { sessionId: `coding-${index}` })).reason).toBe("completed");
  }
  expect(requests).toHaveLength(tasks.length);
  const head = (request: CreateMessageOptions) => ({
    tools: JSON.stringify(request.tools),
    systemPrompt: request.systemPrompt,
    userContext: JSON.stringify(request.messages[0]),
    headId: request.promptCache?.headId,
  });
  const [baseline, ...others] = requests.map(head);
  expect(baseline!.headId).toMatch(/^[0-9a-f]{64}$/u);
  for (const other of others) expect(other).toEqual(baseline!);
  expect(JSON.stringify(requests[1]!.messages)).toContain("### LSP");
}, 30_000);
