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
import type { SettingsManager } from "../settings/manager.js";
import type { CapabilityDescriptor } from "./types.js";

/** Buckets in capabilityOverrides. */
export type OverrideBucket = keyof NonNullable<CapabilityOverrides>;

/** Apply a tri-state override to a baseline. inherit/garbage → baseline. */
export function applyOverride(globalEnabled: boolean, override?: CapabilityOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return globalEnabled;
}

/** Which capabilityOverrides bucket a descriptor kind writes to. */
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
    case "builtin":
      return "builtin";
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

/**
 * Whitelist (opt-in) variant of {@link effectiveDisabledList}, used only for
 * the no-repo "conversation" scope where skill/plugin default-state is INVERTED:
 * everything is disabled UNLESS the project override bucket explicitly marks it
 * `"on"`. This is the opposite of the normal denylist (default-enabled) model.
 *
 * Given the full set of installed names and an override bucket:
 *   - a name explicitly `"on"`  → kept enabled (NOT in the returned list)
 *   - everything else (`"off"`, inherit/absent, garbage) → disabled (in the list)
 *
 * The returned list is the effective disabled list to feed run-time
 * skill/plugin filtering. Order follows `allInstalledNames`; duplicates are
 * collapsed.
 */
export function whitelistDisabledList(
  allInstalledNames: string[],
  bucket: Record<string, CapabilityOverride> | undefined,
): string[] {
  const disabled: string[] = [];
  const seen = new Set<string>();
  for (const name of allInstalledNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (bucket?.[name] === "on") continue; // explicit allow → stays enabled
    disabled.push(name);
  }
  return disabled;
}

/**
 * Fold a project builtin override bucket into the global enabled/disabled
 * builtin-tool lists, producing the lists to feed resolveBuiltinToolNames
 * (whose effective set is `preset.builtinTools ∪ enabled − disabled`).
 *
 * Unlike skills/plugins/agents — which the engine reads as a single denylist
 * — builtin tools resolve from a pair of allow/deny lists, so an override must
 * land in BOTH to win regardless of which side the preset/global config put
 * the token on:
 *   - "on"  → add to enabled, remove from disabled (force-enabled)
 *   - "off" → add to disabled, remove from enabled (force-disabled)
 *   - inherit/absent → leave the baseline untouched
 */
export function effectiveBuiltinLists(
  globalEnabled: string[],
  globalDisabled: string[],
  bucket: Record<string, CapabilityOverride> | undefined,
): { enabledBuiltinTools: string[]; disabledBuiltinTools: string[] } {
  const enabled = new Set(globalEnabled);
  const disabled = new Set(globalDisabled);
  if (bucket) {
    for (const [token, state] of Object.entries(bucket)) {
      if (state === "on") {
        enabled.add(token);
        disabled.delete(token);
      } else if (state === "off") {
        disabled.add(token);
        enabled.delete(token);
      }
    }
  }
  return {
    enabledBuiltinTools: [...enabled],
    disabledBuiltinTools: [...disabled],
  };
}

const PROFILE_MERGED_OVERRIDE_BUCKETS = [
  "skills",
  "plugins",
  "agents",
  "mcp",
  "builtin",
  "pluginHooks",
] as const;

/**
 * 合并两层三态 overlay：`top`（用户手写 capabilityOverrides）按 key 赢过
 * `base`（profile.overrides 快照）。Pet visibility 属于 host/project 策略，
 * 不可由 portable profile 注入；只保留 top 的直接项目设置。
 */
export function mergeCapabilityOverrides(
  base: CapabilityOverrides | undefined,
  top: CapabilityOverrides | undefined,
): CapabilityOverrides | undefined {
  const merged: NonNullable<CapabilityOverrides> = {};
  for (const bucket of PROFILE_MERGED_OVERRIDE_BUCKETS) {
    const combined = { ...(base?.[bucket] ?? {}), ...(top?.[bucket] ?? {}) };
    if (Object.keys(combined).length > 0) merged[bucket] = combined;
  }
  if (top?.pet && Object.keys(top.pet).length > 0) merged.pet = { ...top.pet };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 项目 overrides 的唯一读取咽喉：profile 快照垫底、用户手写覆盖。
 * 所有折叠消费方（engine / disabled-lists / capability service）必须
 * 经这里读，不得再直接 getForScope().capabilityOverrides。
 */
export function effectiveProjectOverrides(
  settings: Pick<SettingsManager, "getForScope">,
  cwd: string | undefined,
  explicitProfileOverrides?: CapabilityOverrides,
): CapabilityOverrides | undefined {
  if (!cwd) return undefined;
  try {
    const scoped = settings.getForScope("project", cwd) as {
      capabilityOverrides?: CapabilityOverrides;
      profile?: { overrides?: CapabilityOverrides };
    };
    return mergeCapabilityOverrides(
      explicitProfileOverrides ?? scoped.profile?.overrides,
      scoped.capabilityOverrides,
    );
  } catch {
    return undefined;
  }
}
