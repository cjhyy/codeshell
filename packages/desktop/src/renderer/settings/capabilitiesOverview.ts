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

/** Display order + labels for the four kinds. builtin sits last (folded). */
export const CAPABILITY_GROUP_ORDER: CapabilityKind[] = [
  "mcp",
  "skill",
  "plugin",
  "builtin",
];

export const CAPABILITY_GROUP_LABEL: Record<CapabilityKind, string> = {
  mcp: "MCP 服务器",
  skill: "技能",
  plugin: "插件",
  builtin: "内置工具",
};

export interface CapabilityGroup {
  kind: CapabilityKind;
  label: string;
  items: CapabilityDescriptor[];
}

/**
 * Bucket descriptors by kind in the fixed display order, dropping empty
 * groups so the UI doesn't render headers for kinds with no items.
 * Within a group the original order is preserved (the service already
 * returns a stable, name-sorted projection).
 */
export function groupCapabilities(
  caps: CapabilityDescriptor[],
): CapabilityGroup[] {
  return CAPABILITY_GROUP_ORDER.map((kind) => ({
    kind,
    label: CAPABILITY_GROUP_LABEL[kind],
    items: caps.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** A group whose rows are collapsed by default (only builtin, for now). */
export function isCollapsedByDefault(kind: CapabilityKind): boolean {
  return kind === "builtin";
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
