import { describe, expect, test } from "bun:test";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import {
  type CapabilityKind,
  capabilityMeta,
  groupCapabilities,
  isCollapsedByDefault,
  isGroupCollapsed,
  foldBrowserGroup,
  BROWSER_GROUP_ID,
} from "./capabilitiesOverview";

function browserCaps(over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor[] {
  return ["browser_observe", "browser_act", "browser_navigate"].map((n) => ({
    id: `builtin:${n}`,
    kind: "builtin" as const,
    name: n,
    description: "",
    enabled: true,
    control: { settingsKey: "agent.disabledBuiltinTools", mode: "denylist", token: n },
    ...over,
  }));
}

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

describe("foldBrowserGroup", () => {
  test("enabled only when all three tools are on", () => {
    expect(foldBrowserGroup(browserCaps({ enabled: true }))!.enabled).toBe(true);
    const mixed = browserCaps();
    mixed[1]!.enabled = false;
    expect(foldBrowserGroup(mixed)!.enabled).toBe(false);
  });
  test("shared projectOverride only when all agree", () => {
    expect(foldBrowserGroup(browserCaps({ projectOverride: "off" }))!.projectOverride).toBe("off");
    const mixed = browserCaps({ projectOverride: "off" });
    mixed[0]!.projectOverride = "on";
    expect(foldBrowserGroup(mixed)!.projectOverride).toBeUndefined();
  });
  test("empty input → null", () => {
    expect(foldBrowserGroup([])).toBeNull();
  });
});

describe("groupCapabilities browser fold", () => {
  test("collapses the three browser tools into one synthetic row", () => {
    const groups = groupCapabilities([
      cap({ id: "builtin:Read", kind: "builtin", name: "Read" }),
      ...browserCaps(),
    ]);
    const builtin = groups.find((g) => g.kind === "builtin")!;
    const ids = builtin.items.map((c) => c.id);
    expect(ids).toContain(BROWSER_GROUP_ID); // one folded row
    expect(ids).toContain("builtin:Read"); // non-browser tool stays
    expect(ids).not.toContain("builtin:browser_observe"); // raw tools hidden
    expect(builtin.items.length).toBe(2); // folded + Read
  });
});

describe("groupCapabilities", () => {
  test("buckets by kind in fixed order, agent before builtin (last)", () => {
    const groups = groupCapabilities([
      cap({ id: "b:1", kind: "builtin", name: "Read" }),
      cap({ id: "a:1", kind: "agent", name: "researcher" }),
      cap({ id: "p:1", kind: "plugin", name: "Plg" }),
      cap({ id: "m:1", kind: "mcp", name: "Srv" }),
      cap({ id: "s:1", kind: "skill", name: "Skl" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "mcp",
      "skill",
      "plugin",
      "agent",
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

  test("labels the agent group 子代理", () => {
    const groups = groupCapabilities([cap({ id: "a:1", kind: "agent", name: "x" })]);
    expect(groups[0]!.label).toBe("子代理");
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

describe("isGroupCollapsed", () => {
  const none = new Set<CapabilityKind>();

  test("follows the default when untoggled", () => {
    expect(isGroupCollapsed(none, "builtin")).toBe(true); // folded by default
    expect(isGroupCollapsed(none, "mcp")).toBe(false);
  });

  test("a toggled kind flips away from its default", () => {
    // builtin defaults collapsed → toggling expands it
    expect(isGroupCollapsed(new Set<CapabilityKind>(["builtin"]), "builtin")).toBe(false);
    // mcp defaults expanded → toggling collapses it
    expect(isGroupCollapsed(new Set<CapabilityKind>(["mcp"]), "mcp")).toBe(true);
  });

  test("only the toggled kind is affected", () => {
    const toggled = new Set<CapabilityKind>(["mcp"]);
    expect(isGroupCollapsed(toggled, "skill")).toBe(false);
    expect(isGroupCollapsed(toggled, "builtin")).toBe(true);
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
