import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../agent/agent-definition.js";
import type { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { runWithSid } from "../logging/logger.js";
import { SessionManager } from "../session/session-manager.js";
import { agentTool, agentSendInputTool } from "../tool-system/builtin/agent.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import type { ToolContext } from "../tool-system/context.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";
import type { LLMResponse, Message } from "../types.js";
import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { createSubAgentSpawner } from "./subagent-spawner.js";
import type { EngineConfig } from "./types.js";

const provider = "fake-subagent-reuse-integration";
const firstTask = "Remember the number 73 and inspect using the allowed tool.";
const firstReport = "First report: I remember the number 73.";
const followUpTask = "Use the number from your earlier work and check the fix.";
const followUpReport = "Follow-up report: the remembered number is 73.";

interface ModelRequest {
  messages: Message[];
  tools: string[];
}

let requests: ModelRequest[] = [];

class ReuseClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    // Engine may summarize tool output through a hidden auxiliary call. Keep
    // that offline too, without consuming the scripted foreground turns.
    if (options.requestVisible === false) {
      return { text: "Offline auxiliary summary.", toolCalls: [], stopReason: "stop" };
    }
    requests.push({
      messages: structuredClone(options.messages),
      tools: (options.tools ?? []).map((tool) => tool.name),
    });
    const call = requests.length;
    if (call === 1 || call === 3) {
      return {
        text: "Inspecting the task.",
        toolCalls: [
          { id: `forbidden-${call}`, toolName: "ForbiddenTool", args: {} },
          { id: `allowed-${call}`, toolName: "AllowedTool", args: {} },
        ],
        stopReason: "tool_use",
      };
    }
    if (call !== 2 && call !== 4) throw new Error(`Unexpected model request ${call}`);
    return {
      text: call === 2 ? firstReport : followUpReport,
      toolCalls: [],
      stopReason: "stop",
    };
  }
}

registerProvider(provider, ReuseClient);

describe("sub-agent reuse through the native Engine spawner", () => {
  it("restores the conversation and enforces the original role scope after registry loss", async () => {
    // Install the network guard before importing Engine. The scripted provider
    // performs no fetch, and any unexpected auxiliary request must fail locally.
    const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected network request in offline sub-agent integration test");
    });
    const previousAutoBackground = process.env.CODE_SHELL_AGENT_BG_MS;
    process.env.CODE_SHELL_AGENT_BG_MS = "0";
    const dir = mkdtempSync(join(tmpdir(), "subagent-reuse-integration-"));
    const sessions = join(dir, "sessions");
    requests = [];
    asyncAgentRegistry.reset();
    notificationQueue.reset();
    let allowedCalls = 0;
    let forbiddenCalls = 0;
    const childConfigs: EngineConfig[] = [];

    try {
      const { Engine } = await import("./engine.js");
      const parent: EngineConfig = {
        llm: { provider, model: "offline-reuse-model" },
        cwd: dir,
        sessionStorageDir: sessions,
        enabledBuiltinTools: [],
        headless: true,
        settingsScope: "isolated",
        permissionMode: "bypassPermissions",
        mcpServers: {},
      };
      const makeSpawner = (manager: SessionManager) =>
        createSubAgentSpawner({
          parentConfig: parent,
          parentSessionId: "parent",
          parentSandbox: defaultSandboxConfig("off"),
          presetName: "general",
          cwd: dir,
          permissionMode: "bypassPermissions",
          appendParentSubagent: () => {},
          sessionExists: (id) => manager.exists(id),
          getSessionParentId: (id) => manager.readParentSessionId(id),
          getSessionContinuation: (id) => manager.readSubAgentContinuation(id),
          childRunner: {
            createChild(config) {
              childConfigs.push(config);
              const engine = new Engine({
                ...config,
                // These are custom tools, not built-ins. Register both in the
                // fixture catalog so only the native run's hard allowlist can
                // exclude ForbiddenTool from advertising and execution.
                enabledBuiltinTools: [],
                preset: "initial-tools-fixture",
                modules: [initialToolsFixtureModule(["AllowedTool", "ForbiddenTool"])],
              });
              engine.registerCustomTool(
                {
                  name: "AllowedTool",
                  description: "Allowed role operation",
                  inputSchema: { type: "object", properties: {} },
                  source: "builtin",
                  permissionDefault: "allow",
                },
                async () => {
                  allowedCalls++;
                  return "Allowed operation completed.";
                },
              );
              engine.registerCustomTool(
                {
                  name: "ForbiddenTool",
                  description: "Operation outside the child role",
                  inputSchema: { type: "object", properties: {} },
                  source: "builtin",
                  permissionDefault: "allow",
                },
                async () => {
                  forbiddenCalls++;
                  return "Forbidden operation executed.";
                },
              );
              return engine;
            },
            async runChild() {
              throw new Error("Native live child runner was bypassed");
            },
          },
        });
      const role: AgentDefinition = {
        name: "limited-reviewer",
        description: "Review under a restricted tool scope",
        systemPrompt: "Use only AllowedTool.",
        tools: ["AllowedTool"],
        skills: [],
        mcp: [],
        maxTurns: 4,
      };
      const manager = new SessionManager(sessions);
      const context = {
        sessionId: "parent",
        subAgentSpawner: makeSpawner(manager),
        agentDefinitions: {
          list: () => [role],
          get: (name: string) => (name === role.name ? role : undefined),
        } as AgentDefinitionRegistry,
      } as ToolContext;

      const initial = await runWithSid("parent", () =>
        agentTool(
          { description: "remember and inspect", prompt: firstTask, agent_type: role.name },
          context,
        ),
      );
      const agentId = initial.match(/^agent_id: ([A-Za-z0-9_-]+)/m)?.[1];
      expect(agentId).toBeDefined();
      expect(initial).toContain(firstReport);
      expect(requests).toHaveLength(2);
      expect(allowedCalls).toBe(1);
      expect(forbiddenCalls).toBe(0);
      expect(JSON.stringify(requests[1].messages)).toContain(
        "Tool ForbiddenTool is not allowed by this run profile",
      );
      expect(manager.readSubAgentContinuation(agentId!)).toMatchObject({
        agentType: role.name,
        toolAllowlist: ["AllowedTool"],
        skillAllowlist: [],
        mcpAllowlist: [],
      });
      expect(asyncAgentRegistry.getWriterLease(agentId!)).toBeUndefined();

      // Lose all process-local state and the role definition. The new manager
      // and native spawner must recover both history and authority from disk.
      asyncAgentRegistry.reset();
      const restarted = new SessionManager(sessions);
      const resumed = await runWithSid("parent", () =>
        agentSendInputTool({ agent_id: agentId, prompt: followUpTask }, {
          sessionId: "parent",
          subAgentSpawner: makeSpawner(restarted),
        } as ToolContext),
      );

      expect(resumed).toContain(`agent_id: ${agentId}`);
      expect(resumed).toContain(followUpReport);
      expect(requests).toHaveLength(4);
      expect(childConfigs).toHaveLength(2);
      for (const request of requests) expect(request.tools).toEqual(["AllowedTool"]);
      const restoredMessages = JSON.stringify(requests[2].messages);
      expect(restoredMessages).toContain(firstTask);
      expect(restoredMessages).toContain(firstReport);
      expect(restoredMessages).toContain(followUpTask);
      expect(JSON.stringify(requests[3].messages)).toContain(
        "Tool ForbiddenTool is not allowed by this run profile",
      );
      expect(allowedCalls).toBe(2);
      expect(forbiddenCalls).toBe(0);
      expect(childConfigs[1].skillAllowlist).toEqual([]);
      expect(childConfigs[1].mcpServers).toEqual({});
      expect(restarted.readSessionState(agentId!)).toMatchObject({
        sessionId: agentId,
        parentSessionId: "parent",
        turnSeq: 2,
      });
      expect(asyncAgentRegistry.get(agentId!)?.status).toBe("completed");
      expect(asyncAgentRegistry.getWriterLease(agentId!)).toBeUndefined();
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally {
      asyncAgentRegistry.reset();
      notificationQueue.reset();
      rmSync(dir, { recursive: true, force: true });
      if (previousAutoBackground === undefined) delete process.env.CODE_SHELL_AGENT_BG_MS;
      else process.env.CODE_SHELL_AGENT_BG_MS = previousAutoBackground;
      fetchGuard.mockRestore();
    }
  });
});
