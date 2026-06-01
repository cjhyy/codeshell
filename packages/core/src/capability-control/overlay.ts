/**
 * Pure tri-state overlay math for project-scoped capability control.
 *
 * The overlay is NOT a second denylist. It layers over a global baseline:
 *   - "on"      → force enabled (even if globally disabled)
 *   - "off"     → force disabled (even if globally enabled)
 *   - "inherit" → take the global baseline (we never persist this literal;
 *                 absence of a key === inherit)
 * Unknown/garbage values are treated as inherit so a bad config never makes
 * every capability vanish (spec §9).
 *
 * See docs/superpowers/specs/2026-06-01-project-scoped-capabilities-and-session-isolation-design.md
 */
import type { CapabilityOverride, CapabilityOverrides } from "../settings/schema.js";
import type { CapabilityDescriptor } from "./types.js";

/** Buckets in capabilityOverrides: "skills" | "plugins" | "agents" | "mcp". */
export type OverrideBucket = keyof NonNullable<CapabilityOverrides>;

/** Apply a tri-state override to a baseline. inherit/garbage → baseline. */
export function applyOverride(globalEnabled: boolean, override?: CapabilityOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return globalEnabled;
}

/** Which capabilityOverrides bucket a descriptor kind writes to (builtin: none). */
export function bucketForKind(
  kind: CapabilityDescriptor["kind"] | "agent",
): OverrideBucket | undefined {
  switch (kind) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "mcp":
      return "mcp";
    case "agent":
      return "agents";
    default:
      return undefined;
  }
}

/** Strip the leading "<kind>:" prefix from a capability id to get its token. */
export function overrideTokenForId(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}

/** Read the project override for a descriptor, normalizing inherit/garbage to undefined. */
export function overrideFor(
  overrides: CapabilityOverrides | undefined,
  kind: CapabilityDescriptor["kind"] | "agent",
  token: string,
): "on" | "off" | undefined {
  const bucket = bucketForKind(kind);
  if (!bucket || !overrides) return undefined;
  const v = overrides[bucket]?.[token];
  return v === "on" || v === "off" ? v : undefined;
}

/**
 * Fold a project override bucket into a global "disabled" list, producing the
 * effective disabled list for run-time skill/plugin filtering. "on" un-disables
 * (removes from the list), "off" disables (adds to the list); inherit/absent
 * leaves the baseline.
 */
export function effectiveDisabledList(
  globalDisabled: string[],
  bucket: Record<string, CapabilityOverride> | undefined,
): string[] {
  const disabled = new Set(globalDisabled);
  if (bucket) {
    for (const [token, state] of Object.entries(bucket)) {
      if (state === "on") disabled.delete(token);
      else if (state === "off") disabled.add(token);
    }
  }
  return [...disabled];
}
