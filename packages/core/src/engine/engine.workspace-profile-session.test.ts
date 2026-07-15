import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "../profile/store.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";

const provider = "workspace-profile-session-test";
const prompts: string[] = [];
const dirs: string[] = [];

class ProfileSessionClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    prompts.push(options.systemPrompt);
    const response: LLMResponse = {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, ProfileSessionClient);

afterEach(() => {
  prompts.length = 0;
  delete process.env.CODE_SHELL_HOME;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session-bound workspace profile", () => {
  test("persists the digital human and reuses its instruction on later turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-session-profile-"));
    dirs.push(root);
    process.env.CODE_SHELL_HOME = join(root, "home");
    saveWorkspaceProfile({
      name: "researcher",
      label: "研究员",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      mainInstruction: "SESSION_PROFILE_MARKER",
      portableMemory: false,
    });
    const engine = new Engine({
      llm: { provider, model: `profile-${Date.now()}`, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      permissionMode: "bypassPermissions",
      maxTurns: 3,
    });
    (engine as any).hooks.clear();

    await engine.run("first", { sessionId: "profile-work", workspaceProfile: "researcher" });
    await engine.run("second", { sessionId: "profile-work" });

    expect(prompts.filter((prompt) => prompt.includes("SESSION_PROFILE_MARKER"))).toHaveLength(2);
    expect(engine.getSessionManager().resume("profile-work").state.workspaceProfile).toBe(
      "researcher",
    );
  }, 15_000);
});
