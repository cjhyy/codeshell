import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, type BuiltinTool } from "./builtin/index.js";
import { ToolRegistry } from "./registry.js";
import { createSessionToolHost } from "./session-tool-host.js";
import {
  assertExternalToolReviewSnapshot,
  createExternalToolReviewSnapshot,
  deriveExternalToolExposure,
  intersectExternalToolExposure,
  REVIEWED_EXTERNAL_TOOL_EXPOSURE,
} from "./external-tool-exposure.js";

const read = BUILTIN_TOOLS.find((tool) => tool.definition.name === "Read")!;
const panel = BUILTIN_TOOLS.find((tool) => tool.definition.name === "Panel")!;

function registryFor(tool: BuiltinTool) {
  return new ToolRegistry({ toolCatalog: [tool] });
}

describe("reviewed external tool declarations", () => {
  test("the core catalog exactly matches its checked-in review", () => {
    const names = new Set(BUILTIN_TOOLS.map((tool) => tool.definition.name));
    const expected = REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter(
      (entry) => names.has(entry.tool) && entry.requires !== "goal-controller",
    );
    expect(() =>
      assertExternalToolReviewSnapshot(createExternalToolReviewSnapshot(BUILTIN_TOOLS), expected),
    ).not.toThrow();
  });

  test("undeclared tools and unreviewed declarations default to excluded", () => {
    const undeclared = { ...read, exposure: { ...read.exposure, external: undefined } };
    expect(deriveExternalToolExposure(registryFor(undeclared)).toolNames.size).toBe(0);
    const unknown = { ...read, definition: { ...read.definition, name: "UnreviewedRead" } };
    expect(deriveExternalToolExposure(registryFor(unknown)).toolNames.size).toBe(0);
    expect(() =>
      assertExternalToolReviewSnapshot(createExternalToolReviewSnapshot([unknown]), []),
    ).toThrow(/reviewed/);
  });

  test("registration replacement cannot reuse a former tool's approved declaration", () => {
    const registry = registryFor(read);
    expect(deriveExternalToolExposure(registry).toolNames.has("Read")).toBe(true);
    registry.registerTool({ ...read.definition }, read.execute);
    expect(deriveExternalToolExposure(registry).toolNames.has("Read")).toBe(false);
  });

  test.each([
    [
      "schema",
      {
        ...read,
        definition: {
          ...read.definition,
          inputSchema: { ...read.definition.inputSchema, additionalProperties: true },
        },
      },
    ],
    [
      "permission hint",
      { ...read, definition: { ...read.definition, permissionDefault: "ask" as const } },
    ],
    ["path policy", { ...read, definition: { ...read.definition, pathPolicy: undefined } }],
    ["read-only metadata", { ...read, definition: { ...read.definition, isReadOnly: false } }],
    ["permission rules", { ...read, exposure: { ...read.exposure, defaultPermissionRules: [] } }],
    [
      "feature gate",
      { ...read, exposure: { ...read.exposure, featureFlag: "shell_tool" as const } },
    ],
  ] as const)("%s drift requires a new independent review", (_label, changed) => {
    expect(deriveExternalToolExposure(registryFor(changed)).toolNames.has("Read")).toBe(false);
    const expected = REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter((entry) => entry.tool === "Read");
    expect(() =>
      assertExternalToolReviewSnapshot(createExternalToolReviewSnapshot([changed]), expected),
    ).toThrow(/reviewed/);
  });

  test.each(["kind", "reason", "argsPatterns"] as const)(
    "Panel %s changes require review, independently of schema fingerprints",
    (field) => {
      const external = { ...panel.exposure.external! };
      if (field === "kind") external.kind = "self-contained";
      else if (field === "reason") external.reason = "A different compatibility justification.";
      else external.argsPatterns = [{ action: ".*" }];
      const changed = { ...panel, exposure: { ...panel.exposure, external } };
      expect(deriveExternalToolExposure(registryFor(changed)).toolNames.has("Panel")).toBe(false);
      expect(() =>
        assertExternalToolReviewSnapshot(
          createExternalToolReviewSnapshot([changed]),
          REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter((entry) => entry.tool === "Panel"),
        ),
      ).toThrow(/reviewed/);
    },
  );

  test("caller exposure cannot widen declarations or the reviewed Panel argument scope", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Panel", "Agent"] });
    const exposure = intersectExternalToolExposure(deriveExternalToolExposure(registry), {
      mode: "allowlist",
      toolNames: new Set(["Panel", "Agent"]),
      argsPatterns: new Map([["Panel", { action: "invoke", panel_id: ".*", tool_name: ".*" }]]),
    });
    const invoked: string[] = [];
    const host = createSessionToolHost({
      businessSessionId: "exposure-review",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: [{ tool: "Panel", decision: "allow" }],
      projectTrusted: true,
      planMode: false,
      exposure,
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      contextOverrides: {
        panels: {
          list: async () => ({ items: [] }),
          open: async () => ({ ok: true }),
          tools: async () => ({ items: [] }),
          invoke: async (panelId: string, toolName: string) => {
            invoked.push(`${panelId}:${toolName}`);
            return { ok: true };
          },
        },
      } as never,
    });
    try {
      expect(exposure.toolNames.has("Agent")).toBe(false);
      for (const input of [
        { action: "list" },
        { action: "invoke", panel_id: "panel-app:other", tool_name: "get_job_search_context" },
        { action: "invoke", panel_id: "panel-app:job-hunt-hq", tool_name: "unreviewed" },
      ]) {
        expect((await host.execute({ id: "blocked", name: "Panel", input })).isError).toBe(true);
      }
      expect(invoked).toEqual([]);
      expect(
        (
          await host.execute({
            id: "allowed",
            name: "Panel",
            input: {
              action: "invoke",
              panel_id: "panel-app:job-hunt-hq",
              tool_name: "get_job_search_context",
              arguments: {},
            },
          })
        ).isError,
      ).toBeFalsy();
      expect(invoked).toEqual(["panel-app:job-hunt-hq:get_job_search_context"]);
    } finally {
      await host.dispose();
    }
  });
});
