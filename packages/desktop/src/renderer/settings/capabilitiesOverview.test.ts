import { describe, expect, test } from "bun:test";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import {
  capabilityMeta,
  groupCapabilities,
  isCollapsedByDefault,
} from "./capabilitiesOverview";

function cap(over: Partial<CapabilityDescriptor>): CapabilityDescriptor {
  return {
    id: "x:1",
    kind: "skill",
    name: "n",
    description: "d",
    enabled: true,
    control: { settingsKey: "disabledSkills", mode: "denylist", token: "n" },
    ...over,
  };
}

describe("groupCapabilities", () => {
  test("buckets by kind in fixed order, builtin last", () => {
    const groups = groupCapabilities([
      cap({ id: "b:1", kind: "builtin", name: "Read" }),
      cap({ id: "p:1", kind: "plugin", name: "Plg" }),
      cap({ id: "m:1", kind: "mcp", name: "Srv" }),
      cap({ id: "s:1", kind: "skill", name: "Skl" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "mcp",
      "skill",
      "plugin",
      "builtin",
    ]);
  });

  test("drops empty groups", () => {
    const groups = groupCapabilities([cap({ kind: "skill" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("skill");
  });

  test("preserves order within a group", () => {
    const groups = groupCapabilities([
      cap({ id: "s:b", kind: "skill", name: "B" }),
      cap({ id: "s:a", kind: "skill", name: "A" }),
    ]);
    expect(groups[0]!.items.map((c) => c.name)).toEqual(["B", "A"]);
  });

  test("labels each group", () => {
    const groups = groupCapabilities([cap({ kind: "mcp" })]);
    expect(groups[0]!.label).toBe("MCP 服务器");
  });
});

describe("isCollapsedByDefault", () => {
  test("only builtin is collapsed", () => {
    expect(isCollapsedByDefault("builtin")).toBe(true);
    expect(isCollapsedByDefault("mcp")).toBe(false);
    expect(isCollapsedByDefault("skill")).toBe(false);
    expect(isCollapsedByDefault("plugin")).toBe(false);
  });
});

describe("capabilityMeta", () => {
  test("shows MCP tool count", () => {
    expect(capabilityMeta(cap({ kind: "mcp", origin: { toolCount: 3 } }))).toBe(
      "3 个工具",
    );
  });

  test("shows read-only marker", () => {
    expect(
      capabilityMeta(cap({ kind: "mcp", origin: { isReadOnly: true } })),
    ).toBe("只读");
  });

  test("combines count and read-only", () => {
    expect(
      capabilityMeta(
        cap({ kind: "mcp", origin: { toolCount: 2, isReadOnly: true } }),
      ),
    ).toBe("2 个工具 · 只读");
  });

  test("empty when no origin detail", () => {
    expect(capabilityMeta(cap({ origin: undefined }))).toBe("");
  });
});
