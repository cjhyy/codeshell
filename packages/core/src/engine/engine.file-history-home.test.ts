import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { sessionsRoot } from "../session/session-manager.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-file-history-home";
const scenarios = new Map<string, { calls: number; filePath: string }>();

class FileHistoryHomeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing scenario ${this.model}`);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    if ((options.tools ?? []).length === 0 || scenario.calls++ > 0) {
      return { text: "done", toolCalls: [], stopReason: "stop", usage };
    }
    return {
      text: "",
      toolCalls: [
        {
          id: "write-file-history-home",
          toolName: "Write",
          args: { file_path: scenario.filePath, content: "after" },
        },
      ],
      stopReason: "tool_use",
      usage,
    };
  }
}

registerProvider(provider, FileHistoryHomeClient);

describe("Engine FileHistory CODE_SHELL_HOME routing", () => {
  const roots: string[] = [];
  let previousCodeShellHome: string | undefined;
  let previousHome: string | undefined;

  afterEach(() => {
    if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousCodeShellHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    scenarios.clear();
  });

  test("the run-scoped FileHistory hook uses the same default root as SessionManager", async () => {
    previousCodeShellHome = process.env.CODE_SHELL_HOME;
    previousHome = process.env.HOME;
    const codeShellHome = mkdtempSync(join(tmpdir(), "engine-file-history-csh-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "engine-file-history-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "engine-file-history-cwd-"));
    roots.push(codeShellHome, fakeHome, cwd);
    process.env.CODE_SHELL_HOME = codeShellHome;
    process.env.HOME = fakeHome;
    const sessionId = "file-history-custom-home";
    const filePath = join(cwd, "existing.txt");
    writeFileSync(filePath, "before");
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    scenarios.set(model, { calls: 0, filePath });
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      enabledBuiltinTools: ["Write"],
      maxTurns: 2,
      headless: true,
      permissionMode: "bypassPermissions",
    });

    await engine.run("update the existing file", { sessionId, cwd });

    expect(existsSync(join(sessionsRoot(), sessionId, "file-history", "index.json"))).toBe(true);
    expect(existsSync(join(fakeHome, ".code-shell", "sessions", sessionId, "file-history"))).toBe(
      false,
    );
  });
});
