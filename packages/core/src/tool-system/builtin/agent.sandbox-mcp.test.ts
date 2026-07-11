import { describe, expect, it } from "bun:test";
import type { EngineConfig } from "../../engine/types.js";
import { createSubAgentSpawner } from "../../engine/subagent-spawner.js";
import { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";
import type { ToolContext } from "../context.js";
import { agentTool } from "./agent.js";

describe("Agent role sandbox and MCP spawn integration", () => {
  it("spawns a child that keeps only the role's MCP allowlist", async () => {
    const parentConfig = {
      llm: { provider: "openai", model: "parent", apiKey: "test" },
      cwd: "/repo",
      permissionMode: "acceptEdits",
      sandbox: {
        mode: "off",
        writableRoots: ["${workspace}", "/tmp/custom"],
        deniedReads: ["~/.ssh"],
        network: "deny",
      },
      mcpServers: {
        github: { name: "github", command: "github-mcp" },
        browser: { name: "browser", command: "browser-mcp" },
      },
    } as EngineConfig;
    let childConfig: EngineConfig | undefined;
    const spawner = createSubAgentSpawner({
      parentConfig,
      parentSandbox: parentConfig.sandbox!,
      presetName: "general",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        async runChild(config, _task, options) {
          childConfig = config;
          return { text: "done", sessionId: options.sessionId! };
        },
      },
    });
    const registry = new AgentDefinitionRegistry();
    // @ts-expect-error — test inserts a role without filesystem scanning
    registry.defs.set("restricted", {
      name: "restricted",
      description: "restricted role",
      systemPrompt: "stay scoped",
      sandbox: "auto",
      mcp: ["github"],
    });

    const result = await agentTool(
      { description: "inspect", prompt: "inspect repository", agent_type: "restricted" },
      { subAgentSpawner: spawner, agentDefinitions: registry } as ToolContext,
    );

    expect(result).toBe("done");
    expect(Object.keys(childConfig?.mcpServers ?? {})).toEqual(["github"]);
    expect(childConfig?.sandbox).toEqual({
      mode: "auto",
      writableRoots: ["${workspace}", "/tmp/custom"],
      deniedReads: ["~/.ssh"],
      network: "deny",
    });
  });
});
