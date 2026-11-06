import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSessionToolHost, type SessionToolHost } from "./session-tool-host.js";
import { deriveExternalToolExposure } from "./external-tool-exposure.js";
import { BUILTIN_TOOLS } from "./builtin/index.js";
import { ToolRegistry } from "./registry.js";
import { HookRegistry } from "../hooks/registry.js";

describe("live reviewed external contracts", () => {
  const read = BUILTIN_TOOLS.find((tool) => tool.definition.name === "Read")!;
  const write = BUILTIN_TOOLS.find((tool) => tool.definition.name === "Write")!;
  let registry: ToolRegistry;
  let hosts: SessionToolHost[];
  let executed: string[];
  const input = { file_path: join(process.cwd(), "CODESHELL.md") };
  function host(options: Partial<Parameters<typeof createSessionToolHost>[0]> = {}) {
    const value = createSessionToolHost({
      businessSessionId: "reviewed-contract",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      settingsScope: "isolated",
      projectTrusted: true,
      planMode: false,
      hooks: new HookRegistry(),
      presetRules: [{ tool: "Read", decision: "allow" }],
      visibility: { cwd: process.cwd(), hasGoal: false },
      exposure: deriveExternalToolExposure(registry),
      getExposure: () => deriveExternalToolExposure(registry),
      ...options,
    });
    hosts.push(value);
    return value;
  }
  beforeEach(() => {
    registry = new ToolRegistry({ builtinTools: [] });
    hosts = [];
    executed = [];
    registry.registerTool(
      read.definition,
      async () => {
        executed.push("original");
        return "original";
      },
      read.exposure,
    );
  });
  afterEach(async () => {
    await Promise.all(hosts.map((value) => value.dispose()));
  });

  test.each(["missing declaration", "changed schema"] as const)(
    "%s after admission revokes discovery and direct invocation",
    async (change) => {
      const value = host();
      expect(value.listTools().map((tool) => tool.name)).toEqual(["Read"]);
      registry.registerTool(
        change === "changed schema"
          ? {
              ...read.definition,
              inputSchema: { ...read.definition.inputSchema, additionalProperties: true },
            }
          : read.definition,
        async () => {
          executed.push("replacement");
          return "replacement";
        },
        change === "changed schema" ? read.exposure : undefined,
      );
      expect(value.listTools()).toEqual([]);
      expect((await value.execute({ id: "replacement", name: "Read", input })).isError).toBe(true);
      expect(executed).toEqual([]);
    },
  );

  test("a replacement during approval fails the final review gate", async () => {
    const value = host({
      presetRules: [{ tool: "Read", decision: "ask" }],
      approvalBackend: {
        requestApproval: async () => {
          registry.registerTool(read.definition, async () => {
            executed.push("replacement");
            return "replacement";
          });
          return { approved: true };
        },
      },
    });
    const result = await value.execute({ id: "pending", name: "Read", input });
    expect(result.error).toContain("no longer available");
    expect(executed).toEqual([]);
  });

  test("new reviewed registrations cannot expand the session's originally admitted set", async () => {
    const value = host();
    registry.registerTool(
      write.definition,
      async () => {
        executed.push("write");
        return "write";
      },
      write.exposure,
    );
    expect(deriveExternalToolExposure(registry).toolNames.has("Write")).toBe(true);
    expect(value.listTools().map((tool) => tool.name)).toEqual(["Read"]);
    expect((await value.execute({ id: "new-tool", name: "Write", input: {} })).isError).toBe(true);
    expect(executed).toEqual([]);
  });
});
