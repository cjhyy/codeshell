import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-quick-chat-restricted";

interface CapturedCall {
  systemPrompt: string;
  toolNames: string[];
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
  it("injects the side boundary guidance without trimming the normal tool set", async () => {
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
      expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Agent"]),
    );
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
    expect(elevated?.toolNames).toEqual(expect.arrayContaining(["Agent", "Write", "Edit", "Bash"]));
  });
});
