import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import type { AgentModule } from "../composition/types.js";

const provider = "fake-quick-chat-restricted";

interface CapturedCall {
  systemPrompt: string;
  toolNames: string[];
  messageText: string;
}

const callsByModel = new Map<string, CapturedCall[]>();
const tempDirs: string[] = [];

class QuickChatRestrictedClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (options.systemPrompt.includes("Working directory:")) {
      callsByModel.get(this.model)?.push({
        systemPrompt: options.systemPrompt,
        toolNames: (options.tools ?? []).map((tool) => tool.name),
        messageText: JSON.stringify(options.messages),
      });
    }
    const response: LLMResponse = {
      text: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, QuickChatRestrictedClient);

afterEach(() => {
  callsByModel.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine quick-chat prompt guidance", () => {
  it("keeps preset-required capability sections in isolated tasks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "isolated-capability-section-"));
    tempDirs.push(cwd);
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    const calls: CapturedCall[] = [];
    callsByModel.set(model, calls);
    const capability: AgentModule = {
      id: "test-capability",
      engine: {
        presets: [
          {
            name: "isolated-with-capability-section",
            label: "Isolated capability test",
            description: "Exercises a preset-owned prompt section.",
            promptSections: ["base", "test-capability-section"],
            builtinTools: [],
            defaultPermissionRules: [],
          },
        ],
        defaultPreset: "isolated-with-capability-section",
        promptSections: {
          "test-capability-section": "# Required Capability Guidance\n\nKeep this static guidance.",
        },
        dynamicContextProviders: [async () => "# Ambient Capability Context"],
      },
    };
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
      modules: [capability],
    });
    (engine as any).hooks.clear();

    await engine.run("Run the isolated task", {
      sessionId: "isolated-capability-section",
      behaviorMode: "isolatedTask",
    });

    const isolated = calls.at(-1);
    expect(isolated?.systemPrompt).toContain("# Required Capability Guidance");
    expect(isolated?.systemPrompt).toContain("# Isolated Task Boundary");
    expect(isolated?.messageText).not.toContain("# Ambient Capability Context");
  });

  it("injects the side boundary guidance and hard-disables sub-agents", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "quick-chat-restricted-"));
    tempDirs.push(cwd);
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    const calls: CapturedCall[] = [];
    callsByModel.set(model, calls);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
    });
    (engine as any).hooks.clear();

    await engine.run("What does this module do?", {
      sessionId: "qchat-restricted",
      behaviorMode: "quickChatRestricted",
    } as any);

    const restricted = calls.at(-1);
    expect(restricted?.systemPrompt).toContain("# Side Conversation Boundary");
    expect(restricted?.systemPrompt).toContain("not the main-thread task execution environment");
    expect(restricted?.systemPrompt).toContain("lightweight read-only exploration");
    expect(restricted?.systemPrompt).toContain(
      "Do not modify files, git state, configuration, or permissions unless the user explicitly asks",
    );
    expect(restricted?.systemPrompt).toContain("Allow you to modify files, please help me");
    expect(restricted?.systemPrompt).toContain("Do not create or invoke sub-agents");
    expect(restricted?.systemPrompt).toContain("before this boundary");
    expect(restricted?.toolNames).toEqual(
      expect.arrayContaining(["Read", "Write", "Edit", "Bash"]),
    );
    expect(restricted?.toolNames).not.toContain("Agent");
  });

  it("keeps guidance and normal tools when the user explicitly requests an edit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "quick-chat-elevated-"));
    tempDirs.push(cwd);
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    const calls: CapturedCall[] = [];
    callsByModel.set(model, calls);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
    });
    (engine as any).hooks.clear();

    await engine.run("Please directly edit the requested file", {
      sessionId: "qchat-elevated",
      permissionMode: "bypassPermissions",
      behaviorMode: "quickChatRestricted",
    });

    const elevated = calls.at(-1);
    expect(elevated?.systemPrompt).toContain("# Side Conversation Boundary");
    expect(elevated?.toolNames).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(elevated?.toolNames).not.toContain("Agent");
  });

  it("fails closed for unknown behavior profiles and unowned session kinds", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "unknown-behavior-profile-"));
    tempDirs.push(cwd);
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    callsByModel.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
    });
    (engine as any).hooks.clear();

    await expect(
      engine.run("must not run unrestricted", { behaviorMode: "missing-profile" }),
    ).rejects.toThrow("unknown behavior profile: missing-profile");
    await expect(engine.run("must not run unrestricted", { kind: "pet" })).rejects.toThrow(
      "session kind has no registered behavior profile: pet",
    );
    expect(callsByModel.get(model)).toEqual([]);
  });
});
