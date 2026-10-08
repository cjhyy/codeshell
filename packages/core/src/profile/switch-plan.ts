import type { CapabilityDescriptor } from "../capability-control/types.js";
import {
  applyOverride,
  mergeCapabilityOverrides,
  overrideFor,
} from "../capability-control/overlay.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import {
  workspaceProfileActivationSubtree,
  type InstalledCapabilityNames,
  type WorkspaceProfileSubtree,
} from "./activation.js";
import type { WorkspaceProfile } from "./types.js";

export type ProfileCapabilityKind = "skill" | "plugin" | "mcp" | "agent";
export interface ProfileSwitchImpact {
  before: { name: string; label: string; available: boolean } | null;
  after: { name: string; label: string; available: boolean } | null;
  instruction: { changed: boolean; beforeLength: number; afterLength: number };
  memory: { before: string | null; after: string | null };
  capabilities: Array<{
    kind: ProfileCapabilityKind;
    name: string;
    before: boolean;
    after: boolean;
  }>;
  missingDeclarations: Array<{ kind: ProfileCapabilityKind; name: string }>;
}

/** Configuration impact only: force-enable declarations never install or authorize a capability. */
export function planWorkspaceProfileSwitch(input: {
  current?: WorkspaceProfileSubtree;
  currentProfile?: WorkspaceProfile;
  nextProfile?: WorkspaceProfile;
  installed: InstalledCapabilityNames;
  exclusiveInventory?: InstalledCapabilityNames;
  directOverrides?: CapabilityOverrides;
  capabilities: Pick<CapabilityDescriptor, "kind" | "name" | "enabled">[];
}): { subtree?: WorkspaceProfileSubtree; impact: ProfileSwitchImpact } {
  const next = input.nextProfile;
  const subtree = next
    ? workspaceProfileActivationSubtree(next, input.exclusiveInventory)
    : undefined;
  const beforeOverrides = mergeCapabilityOverrides(input.current?.overrides, input.directOverrides);
  const afterOverrides = mergeCapabilityOverrides(subtree?.overrides, input.directOverrides);
  const identity = (name: string | undefined, profile: WorkspaceProfile | undefined) =>
    name ? { name, label: profile?.label ?? name, available: Boolean(profile) } : null;
  const oldInstruction = input.currentProfile?.mainInstruction ?? "";
  const newInstruction = next?.mainInstruction ?? "";
  const capabilities: ProfileSwitchImpact["capabilities"] = [];
  for (const capability of input.capabilities) {
    if (capability.kind === "builtin") continue;
    const before = applyOverride(
      capability.enabled,
      overrideFor(beforeOverrides, capability.kind, capability.name),
    );
    const after = applyOverride(
      capability.enabled,
      overrideFor(afterOverrides, capability.kind, capability.name),
    );
    if (before !== after)
      capabilities.push({ kind: capability.kind, name: capability.name, before, after });
  }
  const missingDeclarations: ProfileSwitchImpact["missingDeclarations"] = [];
  const buckets = { skill: "skills", plugin: "plugins", mcp: "mcp", agent: "agents" } as const;
  for (const [kind, bucket] of Object.entries(buckets) as Array<
    [ProfileCapabilityKind, keyof InstalledCapabilityNames]
  >) {
    const installed = new Set(input.installed[bucket] ?? []);
    for (const name of next?.[bucket] ?? []) {
      if (!installed.has(name)) missingDeclarations.push({ kind, name });
    }
  }
  return {
    ...(subtree ? { subtree } : {}),
    impact: {
      before: identity(input.current?.active, input.currentProfile),
      after: identity(next?.name, next),
      instruction: {
        changed: oldInstruction !== newInstruction,
        beforeLength: oldInstruction.length,
        afterLength: newInstruction.length,
      },
      memory: {
        before: input.currentProfile?.portableMemory ? input.currentProfile.name : null,
        after: next?.portableMemory ? next.name : null,
      },
      capabilities,
      missingDeclarations,
    },
  };
}
