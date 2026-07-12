import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { MemoryManager } from "../session/memory.js";
import type { LLMResponse, PermissionMode } from "../types.js";

const provider = "fake-quick-chat-ephemeral-memory";
const memoryPromptsByModel = new Map<string, string[]>();
const tempDirs: string[] = [];
const previousCodeShellHome = process.env.CODE_SHELL_HOME;
const previousHome = process.env.HOME;

class QuickChatEphemeralMemoryClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    let text = "done";
    if (options.systemPrompt.includes("memory extraction assistant")) {
      memoryPromptsByModel.get(this.model)?.push("extraction");
      text = JSON.stringify([
        {
          type: "project",
          scope: "project",
          name: "quick-chat-private-memory",
          description: "private side-chat detail",
          content: "must not survive the ephemeral session",
        },
      ]);
    } else if (options.systemPrompt.includes("session summariser")) {
      memoryPromptsByModel.get(this.model)?.push("session-summary");
      text = JSON.stringify({
        summary: "private quick-chat summary",
        keyTopics: ["private"],
        decisions: [],
      });
    }

    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text, toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(provider, QuickChatEphemeralMemoryClient);

afterEach(() => {
  memoryPromptsByModel.clear();
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine ephemeral quick-chat memory isolation", () => {
  test.each([
    {
      name: "restricted turn",
      runOptions: { behaviorMode: "quickChatRestricted" },
    },
    {
      name: "explicitly elevated turn",
      runOptions: { permissionMode: "bypassPermissions" as PermissionMode },
    },
  ])("does not persist memory after a $name", async ({ name, runOptions }) => {
    const root = mkdtempSync(join(tmpdir(), "quick-chat-ephemeral-memory-"));
    tempDirs.push(root);
    const codeShellHome = join(root, "code-shell-home");
    const userHome = join(root, "user-home");
    const cwd = join(root, "project");
    process.env.CODE_SHELL_HOME = codeShellHome;
    process.env.HOME = userHome;

    const model = `${provider}-${name}-${Date.now()}-${Math.random()}`;
    const memoryPrompts: string[] = [];
    memoryPromptsByModel.set(model, memoryPrompts);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(root, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 1,
    });
    (engine as any).hooks.clear();

    const manager = engine.getSessionManager();
    const nameSlug = name.replaceAll(" ", "-");
    const parent = manager.create(cwd, model, provider, `parent-${nameSlug}`);
    for (let index = 0; index < 4; index++) {
      parent.transcript.appendMessage("user", `parent question ${index}`);
      parent.transcript.appendMessage("assistant", `parent answer ${index}`);
    }
    const sessionId = `qchat-memory-${nameSlug}`;
    const forked = manager.fork(parent.state.sessionId, {
      targetSessionId: sessionId,
      ephemeral: true,
    });
    expect(forked.bundle.state.ephemeral).toBe(true);

    // Engine intentionally launches this pipeline in the background. Capture
    // the returned promise so the persistence assertions are deterministic.
    const pendingPipelines: Promise<void>[] = [];
    const originalRunMemoryPipeline = (engine as any).runMemoryPipeline.bind(engine);
    (engine as any).runMemoryPipeline = (...args: unknown[]) => {
      const pending = originalRunMemoryPipeline(...args);
      pendingPipelines.push(pending);
      return pending;
    };

    await engine.run("keep this quick-chat detail private", {
      sessionId,
      ...runOptions,
    } as any);
    await Promise.all(pendingPipelines);

    expect({
      memoryPrompts,
      dreamMemories: new MemoryManager({
        baseDir: codeShellHome,
        projectDir: cwd,
        scope: "dream",
      }).loadAll(),
      sessionSummaryPersisted: existsSync(
        join(userHome, ".code-shell", "session-memories", `${sessionId}.json`),
      ),
      autoDreamStateUpdated: existsSync(join(codeShellHome, "auto-dream-state.json")),
    }).toEqual({
      memoryPrompts: [],
      dreamMemories: [],
      sessionSummaryPersisted: false,
      autoDreamStateUpdated: false,
    });
  });
});
