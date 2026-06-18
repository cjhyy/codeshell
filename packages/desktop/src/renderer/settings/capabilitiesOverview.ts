/**
 * Pure helpers for the unified "能力总览" (capability overview) section.
 *
 * The data comes from the core CapabilityService via
 * `window.codeshell.listCapabilities`; every descriptor is a read-only
 * projection of one extension capability (builtin tool / MCP server /
 * skill / plugin) plus an inlined `control` telling the backend which
 * settings key to write. The UI never branches on that — it just calls
 * `setCapabilityEnabled(cwd, id, on)`. These helpers only shape the list
 * for display, so they stay free of React/IPC and are unit-testable.
 */
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";

export type CapabilityKind = CapabilityDescriptor["kind"];

/** Display order + labels for the kinds. builtin sits last (folded). */
export const CAPABILITY_GROUP_ORDER: CapabilityKind[] = [
  "mcp",
  "skill",
  "plugin",
  "agent",
  "builtin",
];

export const CAPABILITY_GROUP_LABEL: Record<CapabilityKind, string> = {
  mcp: "MCP 服务器",
  skill: "技能",
  plugin: "插件",
  agent: "子代理",
  builtin: "内置工具",
};

export interface CapabilityGroup {
  kind: CapabilityKind;
  label: string;
  items: CapabilityDescriptor[];
}

/**
 * The browser capability is THREE builtin tools (observe/act/navigate) that
 * always move together — turning the panel on/off should flip all three (and,
 * in core, the browser prompt section follows the tools). We fold them into one
 * synthetic "浏览器" row in the overview; its toggle fans out to all three real
 * descriptors. The synthetic id is recognized by the component to expand back.
 */
export const BROWSER_TOOL_IDS = ["builtin:browser_observe", "builtin:browser_act", "builtin:browser_navigate"];
export const BROWSER_GROUP_ID = "builtin:__browser__";

/** True if this descriptor is one of the browser tools we fold. */
export function isBrowserTool(cap: CapabilityDescriptor): boolean {
  return cap.kind === "builtin" && BROWSER_TOOL_IDS.includes(cap.id);
}

/**
 * Collapse the browser tool descriptors into one synthetic descriptor. enabled
 * = ALL three on; projectOverride = the shared override iff all three agree,
 * else undefined (mixed → shows as 继承-ish / no single state). Pure +
 * unit-testable; the component fans a toggle back out via BROWSER_TOOL_IDS.
 */
export function foldBrowserGroup(browserTools: CapabilityDescriptor[]): CapabilityDescriptor | null {
  if (browserTools.length === 0) return null;
  const allOn = browserTools.every((c) => c.enabled);
  const overrides = new Set(browserTools.map((c) => c.projectOverride ?? "inherit"));
  const sharedOverride = overrides.size === 1 ? browserTools[0]!.projectOverride : undefined;
  const allBaselineOn = browserTools.every((c) => (c.globalEnabled ?? c.enabled));
  return {
    id: BROWSER_GROUP_ID,
    kind: "builtin",
    name: "浏览器自动化",
    description: "browser_observe / browser_act / browser_navigate —— 看网页、操作、看图、多 tab(整组开关)",
    enabled: allOn,
    control: browserTools[0]!.control, // unused for the synthetic row (component fans out)
    globalEnabled: allBaselineOn,
    projectOverride: sharedOverride,
    effectiveSource: browserTools[0]!.effectiveSource,
  };
}

/**
 * Bucket descriptors by kind in the fixed display order, dropping empty
 * groups so the UI doesn't render headers for kinds with no items.
 * Within a group the original order is preserved (the service already
 * returns a stable, name-sorted projection). The three browser builtin tools
 * are folded into one synthetic "浏览器" row (see foldBrowserGroup).
 */
export function groupCapabilities(
  caps: CapabilityDescriptor[],
): CapabilityGroup[] {
  const browserTools = caps.filter(isBrowserTool);
  const folded = foldBrowserGroup(browserTools);
  return CAPABILITY_GROUP_ORDER.map((kind) => {
    if (kind !== "builtin") {
      return { kind, label: CAPABILITY_GROUP_LABEL[kind], items: caps.filter((c) => c.kind === kind) };
    }
    // builtin group: non-browser tools as-is, plus the single folded browser row.
    const others = caps.filter((c) => c.kind === "builtin" && !isBrowserTool(c));
    const items = folded ? [folded, ...others] : others;
    return { kind, label: CAPABILITY_GROUP_LABEL[kind], items };
  }).filter((g) => g.items.length > 0);
}

/** A group whose rows are collapsed by default (only builtin, for now). */
export function isCollapsedByDefault(kind: CapabilityKind): boolean {
  return kind === "builtin";
}

/**
 * Effective collapsed state for a group: a kind in `toggled` has been
 * manually flipped away from its default, everything else follows
 * isCollapsedByDefault. Keeps the toggle bookkeeping out of the component
 * so it's unit-testable.
 */
export function isGroupCollapsed(
  toggled: ReadonlySet<CapabilityKind>,
  kind: CapabilityKind,
): boolean {
  const def = isCollapsedByDefault(kind);
  return toggled.has(kind) ? !def : def;
}

/**
 * One-line meta string shown under a capability's name. Surfaces the
 * MCP tool count and read-only marker when present; empty otherwise.
 */
export function capabilityMeta(cap: CapabilityDescriptor): string {
  const parts: string[] = [];
  const count = cap.origin?.toolCount;
  if (typeof count === "number") {
    parts.push(`${count} 个工具`);
  }
  if (cap.origin?.isReadOnly) {
    parts.push("只读");
  }
  return parts.join(" · ");
}
