import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";

const provider = "fake-child-host-run";
const scenarios = new Map<string, { spawn: boolean; parentCalls: number }>();
let nextModel = 0;
class ChildHostRunClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model)!;
    if (options.tools?.some((tool) => tool.name === "RootProbe") && !scenario.parentCalls++) {
      const probe: LLMResponse = {
        text: "",
        toolCalls: [{ id: "root-probe", toolName: "RootProbe", args: {} }],
        stopReason: "tool_use",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
      this.recordUsage(probe.usage!, options);
      return probe;
    }
    const parentCall = options.tools?.some((tool) => tool.name === "SpawnHostProbe");
    const spawn = parentCall && scenario.spawn && scenario.parentCalls++ === 0;
    const result: LLMResponse = {
      text: spawn ? "" : "completed normally",
      toolCalls: spawn ? [{ id: "spawn-child", toolName: "SpawnHostProbe", args: {} }] : [],
      stopReason: spawn ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    this.recordUsage(result.usage!, options);
    return result;
  }
}
registerProvider(provider, ChildHostRunClient);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  scenarios.clear();
});

describe("Engine child host session initialization", () => {
  for (const spawn of [false, true]) {
    test(
      spawn
        ? "resolves the parent identity only when a real child is spawned"
        : "starts an ordinary real Engine run without accessing the uninitialized session",
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), "child-host-engine-run-"));
        const model = `${provider}-${nextModel++}`;
        scenarios.set(model, { spawn, parentCalls: 0 });
        const bound: Array<{ parentSessionId: string; sessionId: string }> = [];
        const lifecycle: string[] = [];
        const engine = new Engine({
          llm: { provider, model, apiKey: "test" } as never,
          modules: [initialToolsFixtureModule(["SpawnHostProbe"])],
          cwd,
          sessionStorageDir: join(cwd, "sessions"),
          settingsScope: "isolated",
          customSystemPrompt: "Finish the fixture task.",
          headless: true,
          maxTurns: 3,
          permissionMode: "bypassPermissions",
          createChildHostBindings(input) {
            bound.push({ parentSessionId: input.parentSessionId, sessionId: input.sessionId });
            return {
              activate() {
                lifecycle.push("activate");
              },
              dispose() {
                lifecycle.push("dispose");
              },
            };
          },
          behaviorProfiles: [
            {
              id: "host-probe",
              disableSessionTitle: true,
              disableHooks: true,
              disableInstructions: true,
              disableMemoryContext: true,
              disableMcp: true,
            },
          ],
        });
        cleanup.push(async () => {
          await engine.dispose();
          rmSync(cwd, { recursive: true, force: true });
        });
        engine.registerCustomTool(
          {
            name: "SpawnHostProbe",
            description: "Run a child to verify host binding initialization.",
            inputSchema: { type: "object", properties: {} },
            source: "builtin",
            permissionDefault: "allow",
          },
          async (_args, ctx) => {
            const child = await ctx!.subAgentSpawner!.spawn({
              agentId: "actual-child",
              description: "fixture child",
              prompt: "finish child",
              maxTurns: 1,
              signal: ctx!.signal ?? new AbortController().signal,
              toolAllowlist: [],
            });
            expect(child.sessionId).toBe("actual-child");
            return child.text;
          },
        );
        const result = await engine.run("Finish this normal request", {
          sessionId: "actual-parent",
          behaviorMode: "host-probe",
        });
        expect(result.reason).toBe("completed");
        expect(result.text).toBe("completed normally");
        expect(result.sessionId).toBe("actual-parent");
        expect(bound).toEqual(
          spawn ? [{ parentSessionId: "actual-parent", sessionId: "actual-child" }] : [],
        );
        expect(lifecycle).toEqual(spawn ? ["activate", "dispose"] : []);
      },
    );
  }
});

describe("Engine rootSessionId on the tool context", () => {
  for (const subAgent of [false, true]) {
    test(
      subAgent
        ? "a sub-agent reports the spawner-provided parent as root"
        : "a top-level session is its own root",
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), "root-session-id-"));
        const model = `${provider}-${nextModel++}`;
        scenarios.set(model, { spawn: false, parentCalls: 0 });
        const seen: Array<{ sessionId?: string; rootSessionId?: string }> = [];
        const engine = new Engine({
          llm: { provider, model, apiKey: "test" } as never,
          modules: [initialToolsFixtureModule(["RootProbe"])],
          cwd,
          sessionStorageDir: join(cwd, "sessions"),
          settingsScope: "isolated",
          customSystemPrompt: "Finish the fixture task.",
          headless: true,
          maxTurns: 3,
          permissionMode: "bypassPermissions",
          ...(subAgent ? { isSubAgent: true, parentSessionId: "root-parent" } : {}),
          behaviorProfiles: [
            {
              id: "host-probe",
              disableSessionTitle: true,
              disableHooks: true,
              disableInstructions: true,
              disableMemoryContext: true,
              disableMcp: true,
            },
          ],
        });
        cleanup.push(async () => {
          await engine.dispose();
          rmSync(cwd, { recursive: true, force: true });
        });
        engine.registerCustomTool(
          {
            name: "RootProbe",
            description: "Record the tool context identity.",
            inputSchema: { type: "object", properties: {} },
            source: "builtin",
            permissionDefault: "allow",
          },
          async (_args, ctx) => {
            seen.push({ sessionId: ctx?.sessionId, rootSessionId: ctx?.rootSessionId });
            return "ok";
          },
        );
        await engine.run("probe", { sessionId: "own-session", behaviorMode: "host-probe" });
        expect(seen).toEqual([
          { sessionId: "own-session", rootSessionId: subAgent ? "root-parent" : "own-session" },
        ]);
      },
    );
  }
});
