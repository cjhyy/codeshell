import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile, workspaceProfileDir } from "../profile/store.js";
import { MemoryManager } from "../session/memory.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";

const provider = "workspace-profile-session-test";
const prompts: string[] = [];
const dirs: string[] = [];
const memoryToolScenarios = new Map<string, number>();

class ProfileSessionClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    prompts.push(options.systemPrompt);
    if ((options.tools?.length ?? 0) > 0 && memoryToolScenarios.has(this.model)) {
      const call = memoryToolScenarios.get(this.model) ?? 0;
      memoryToolScenarios.set(this.model, call + 1);
      if (call === 0) {
        const response: LLMResponse = {
          text: "",
          toolCalls: [
            {
              id: "save-profile-memory",
              toolName: "MemorySave",
              args: {
                scope: "user",
                location: "profile",
                name: "profile-tool-wiring",
                description: "Profile memory ToolContext wiring",
                type: "project",
                content: "This memory belongs to the active digital human.",
              },
            },
          ],
          stopReason: "tool_use",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
        this.recordUsage(response.usage!, options);
        return response;
      }
    }
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
  memoryToolScenarios.clear();
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

  test("passes portable profile memory into the run ToolContext", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-session-profile-memory-"));
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
      portableMemory: true,
    });
    const model = `profile-memory-${Date.now()}`;
    memoryToolScenarios.set(model, 0);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      permissionMode: "bypassPermissions",
      maxTurns: 3,
    });
    (engine as any).hooks.clear();

    await engine.run("remember this for the active digital human", {
      sessionId: "profile-memory-work",
      workspaceProfile: "researcher",
    });

    expect(
      new MemoryManager({ baseDir: workspaceProfileDir("researcher") }).find("profile-tool-wiring")
        ?.content,
    ).toContain("active digital human");
  }, 15_000);
});
