import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-pet-behavior";
const calls = new Map<
  string,
  Array<{ tools: string[]; systemPrompt: string; messages: Message[] }>
>();
const tempDirs: string[] = [];

class PetBehaviorClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const modelCalls = calls.get(this.model)!;
    modelCalls.push({
      tools: (options.tools ?? []).map((tool) => tool.name),
      systemPrompt: options.systemPrompt,
      messages: structuredClone(options.messages),
    });
    const response: LLMResponse =
      modelCalls.length === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "forbidden-write",
                toolName: "Write",
                args: { file_path: "should-not-exist.txt", content: "blocked" },
              },
            ],
            stopReason: "tool_use",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        : {
            text: "safe answer",
            toolCalls: [],
            stopReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, PetBehaviorClient);

afterEach(() => {
  calls.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine pet behavior", () => {
  test("persists pet identity and hides plus gates mutation, Agent and permission tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-"));
    tempDirs.push(cwd);
    const model = `pet-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();

    await engine.run("global status", {
      sessionId: "local-pet",
      kind: "pet",
      behaviorMode: "pet",
      permissionMode: "bypassPermissions",
      petRuntimeContext: '{"pending":[{"title":"runtime-only-hunter2"}]}',
    });

    const first = calls.get(model)![0]!;
    expect(first.systemPrompt).toContain("# Local Pet Phase 1 Boundary");
    expect(first.systemPrompt).toContain("runtime-only-hunter2");
    expect(JSON.stringify(first.messages)).not.toContain("runtime-only-hunter2");
    expect(first.tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    for (const forbidden of [
      "Write",
      "Edit",
      "ApplyPatch",
      "Bash",
      "Agent",
      "AgentCancel",
      "Config",
      "EnterPlanMode",
      "ExitPlanMode",
    ]) {
      expect(first.tools).not.toContain(forbidden);
    }
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
    expect(JSON.stringify(calls.get(model)![1]!.messages)).toContain(
      "not allowed by this run profile",
    );
    expect(engine.getSessionManager().readSessionKind("local-pet")).toBe("pet");
    const transcript = readFileSync(join(cwd, "sessions", "local-pet", "transcript.jsonl"), "utf8");
    expect(transcript).not.toContain("runtime-only-hunter2");
  });

  test("restored pet identity keeps the safe profile and rejects kind rewrites", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-pet-resume-"));
    tempDirs.push(cwd);
    const model = `pet-resume-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 3,
    });
    (engine as any).hooks.clear();
    await engine.run("first", { sessionId: "pet", kind: "pet" });

    calls.set(model, []);
    await engine.run("second", { sessionId: "pet" });
    expect(calls.get(model)![0]!.tools).not.toContain("Write");

    await expect(engine.run("rewrite", { sessionId: "pet", kind: "work" })).rejects.toThrow(
      "session kind mismatch",
    );
  });
});
