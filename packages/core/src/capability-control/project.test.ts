import { describe, test, expect } from "bun:test";
import {
  projectBuiltin,
  projectMcp,
  projectSkills,
  projectPlugins,
  projectAgents,
} from "./project.js";
import type { RegisteredTool } from "../types.js";
import type { SkillDefinition } from "../skills/scanner.js";
import type { AgentDefinition } from "../agent/agent-definition.js";

const tool = (
  name: string,
  extra: Partial<RegisteredTool> = {},
): RegisteredTool => ({
  name,
  description: `${name} desc`,
  inputSchema: {},
  source: "builtin",
  permissionDefault: "allow" as never,
  ...extra,
});

describe("projectBuiltin", () => {
  test("marks preset-default tools enabled, with denylist control", () => {
    const out = projectBuiltin({
      tools: [tool("Read")],
      presetDefaults: ["Read", "Bash"],
      effective: ["Read", "Bash"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "builtin:Read",
      kind: "builtin",
      name: "Read",
      enabled: true,
      control: {
        settingsKey: "agent.disabledBuiltinTools",
        mode: "denylist",
        token: "Read",
      },
    });
  });

  test("keeps a disabled (preset-default) tool in the list, enabled:false", () => {
    const out = projectBuiltin({
      tools: [tool("Read")],
      presetDefaults: ["Read"],
      effective: [],
    });
    expect(out[0]).toMatchObject({ id: "builtin:Read", enabled: false });
    expect(out[0]!.control.settingsKey).toBe("agent.disabledBuiltinTools");
  });

  test("uses allowlist control for non-preset-default tools", () => {
    const out = projectBuiltin({
      tools: [tool("REPL")],
      presetDefaults: ["Read"],
      effective: ["Read", "REPL"],
    });
    expect(out[0]).toMatchObject({ enabled: true });
    expect(out[0]!.control).toMatchObject({
      settingsKey: "agent.enabledBuiltinTools",
      mode: "allowlist",
      token: "REPL",
    });
  });

  test("carries isReadOnly into origin", () => {
    const out = projectBuiltin({
      tools: [tool("Read", { isReadOnly: true })],
      presetDefaults: ["Read"],
      effective: ["Read"],
    });
    expect(out[0]!.origin?.isReadOnly).toBe(true);
  });
});

describe("projectMcp", () => {
  test("projects per-server, counts tools, enabled by default", () => {
    const out = projectMcp({
      mcpServers: { github: { name: "github" } },
      mcpTools: [
        tool("mcp_github_x", { source: "mcp", serverName: "github" }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "mcp:github",
      kind: "mcp",
      name: "github",
      enabled: true,
      control: {
        settingsKey: "mcpServers",
        mode: "record-flag",
        token: "github",
      },
    });
    expect(out[0]!.origin?.toolCount).toBe(1);
  });

  test("treats enabled:false as disabled, still lists it", () => {
    const out = projectMcp({
      mcpServers: { gh: { name: "gh", enabled: false } },
      mcpTools: [],
    });
    expect(out[0]).toMatchObject({ id: "mcp:gh", enabled: false });
    expect(out[0]!.origin?.toolCount).toBe(0);
  });
});

const skill = (
  name: string,
  source: SkillDefinition["source"],
): SkillDefinition => ({
  name,
  description: `${name} desc`,
  content: "",
  filePath: `/x/${name}/SKILL.md`,
  source,
});

describe("projectSkills", () => {
  test("lists project/user skills, denylist control, enabled unless disabled", () => {
    const out = projectSkills({
      skills: [skill("a", "project"), skill("b", "user"), skill("p:c", "plugin")],
      disabledSkills: ["b"],
    });
    expect(out.map((d) => d.id).sort()).toEqual(["skill:a", "skill:b"]);
    const b = out.find((d) => d.id === "skill:b")!;
    expect(b.enabled).toBe(false);
    expect(b.control).toMatchObject({
      settingsKey: "disabledSkills",
      mode: "denylist",
      token: "b",
    });
    expect(out.find((d) => d.id === "skill:a")!.origin?.filePath).toBe(
      "/x/a/SKILL.md",
    );
  });
});

const agent = (
  name: string,
  source: AgentDefinition["source"],
): AgentDefinition => ({
  name,
  description: `${name} desc`,
  systemPrompt: "",
  source,
  filePath: `/x/${name}.md`,
});

describe("projectAgents", () => {
  test("lists project/user agents, denylist control, enabled unless disabled", () => {
    const out = projectAgents({
      agents: [agent("researcher", "project"), agent("planner", "user")],
      disabledAgents: ["planner"],
    });
    expect(out.map((d) => d.id).sort()).toEqual(["agent:planner", "agent:researcher"]);
    const planner = out.find((d) => d.id === "agent:planner")!;
    expect(planner).toMatchObject({
      kind: "agent",
      name: "planner",
      enabled: false,
    });
    expect(planner.control).toMatchObject({
      settingsKey: "disabledAgents",
      mode: "denylist",
      token: "planner",
    });
    expect(out.find((d) => d.id === "agent:researcher")!.origin?.filePath).toBe(
      "/x/researcher.md",
    );
  });

  test("excludes plugin-sourced agents (they ride their plugin)", () => {
    const out = projectAgents({
      agents: [agent("p-agent", "plugin"), agent("mine", "user")],
      disabledAgents: [],
    });
    expect(out.map((d) => d.id)).toEqual(["agent:mine"]);
  });
});

describe("projectPlugins", () => {
  test("lists installed plugins by bare name, denylist control", () => {
    const out = projectPlugins({
      installed: { "myplug@market": [], "other@m2": [] },
      disabledPlugins: ["other"],
    });
    expect(out.map((d) => d.id).sort()).toEqual([
      "plugin:myplug",
      "plugin:other",
    ]);
    const other = out.find((d) => d.id === "plugin:other")!;
    expect(other).toMatchObject({
      kind: "plugin",
      name: "other",
      enabled: false,
    });
    expect(other.control).toMatchObject({
      settingsKey: "disabledPlugins",
      mode: "denylist",
      token: "other",
    });
  });
});
