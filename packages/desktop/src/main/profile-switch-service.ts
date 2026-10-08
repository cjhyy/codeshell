import { createHash } from "node:crypto";
import { SettingsManager, invalidateSkillCache, validateSettings } from "@cjhyy/code-shell-core";
import {
  defaultCredentialStatus,
  effectiveProjectOverrides,
  planWorkspaceProfileSwitch,
  readWorkspaceProfile,
  resolveEffectiveSourceAccess,
} from "@cjhyy/code-shell-core/internal";
import type { WorkspaceProfile } from "@cjhyy/code-shell-core";
import type { ResolvedRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { profileSwitchCapabilitySnapshot } from "./capabilities-service.js";
import type { ProfileSwitchAdoptResult, ProfileSwitchPreview } from "../shared/profile-switch.js";

type SwitchTarget = Exclude<ResolvedRendererConfigurationTarget, { kind: "no-repo" }>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function switchPlan(target: SwitchTarget, name: string | null, project: Record<string, unknown>) {
  if (name !== null && (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))) {
    throw new Error("invalid digital-human profile id");
  }
  const settings = new SettingsManager(target.cwd, "full");
  const scoped = validateSettings(project);
  const current = scoped.profile;
  // An unreadable old default must not prevent exiting it. Preserve its
  // identity as unavailable and deny its source access; candidates stay strict.
  let currentProfile: WorkspaceProfile | undefined;
  try {
    currentProfile = current?.active ? readWorkspaceProfile(current.active) : undefined;
    if (currentProfile?.name !== current?.active) currentProfile = undefined;
  } catch {
    currentProfile = undefined;
  }
  const nextProfile = name === null ? undefined : readWorkspaceProfile(name);
  if (name && !nextProfile) throw new Error(`Digital human "${name}" not found`);
  if (name && nextProfile?.name !== name)
    throw new Error("Digital human definition identity does not match its selected directory");
  // Every review/commit refreshes discovery; a stale scanner cache cannot hide an install/removal.
  invalidateSkillCache();
  const snapshot = profileSwitchCapabilitySnapshot(target.cwd);
  const local = settings.getRawForScope("local", target.cwd, { strict: true });
  const localSettings = validateSettings(local);
  // Reuse the exact override fold, including machine-private precedence.
  const scopeView = {
    getForScope: (scope: "project" | "local") => (scope === "project" ? scoped : localSettings),
  };
  // Explicit empty Profile base means only the direct project/local overrides are folded.
  const directOverrides = effectiveProjectOverrides(scopeView, target.cwd, {});
  const plan = planWorkspaceProfileSwitch({
    current,
    currentProfile,
    nextProfile,
    installed: snapshot.installed,
    // Preserve Desktop's existing exclusivity contract: only Skills have an exclusive inventory.
    exclusiveInventory: { skills: snapshot.installed.skills },
    directOverrides,
    capabilities: snapshot.capabilities,
  });
  const sourcesFor = (profile: WorkspaceProfile | undefined, selectedName?: string) => {
    // A missing selected definition must remain deny-all; absence of selection falls back to bindings.
    if (selectedName && !profile) return [];
    return resolveEffectiveSourceAccess({
      cwd: target.cwd,
      settings,
      credentialStatus: defaultCredentialStatus,
      settingsScope: "full",
      profile: profile ?? { name: "profile-switch-unbound" },
    });
  };
  const sourceBefore = sourcesFor(currentProfile, current?.active);
  const sourceAfter = sourcesFor(nextProfile);
  const summarize = (sources: typeof sourceBefore) =>
    sources.map(({ sourceId, label, scopes, readPolicy, status }) => ({
      sourceId,
      label,
      scopes,
      readPolicy,
      status,
    }));
  const sources = { before: summarize(sourceBefore), after: summarize(sourceAfter) };
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          target,
          current: project.profile,
          currentProfile,
          nextProfile,
          directOverrides,
          snapshot,
          directLayers: [scoped.capabilityOverrides, localSettings.capabilityOverrides],
          sources,
          // Metadata authority changes must stale a review; never return credential material.
          sourceAuthority: [sourceBefore, sourceAfter].map((items) =>
            items.map(({ sourceId, profileRevision, credentialRevision }) => ({
              sourceId,
              profileRevision,
              credentialRevision,
            })),
          ),
        }),
      ),
    )
    .digest("hex");
  const preview: ProfileSwitchPreview = {
    ...plan.impact,
    revision,
    target: {
      kind: target.kind,
      projectId: target.projectId,
      ...(target.kind === "session" ? { sessionId: target.sessionId } : {}),
    },
    sources,
    exclusiveSkillsOnly: nextProfile?.exclusiveCapabilities === true,
  };
  return { ...plan, preview };
}

/** Reads only definition/configuration/discovery metadata, never executes or installs requirements. */
export function previewProfileSwitch(
  target: SwitchTarget,
  name: string | null,
): ProfileSwitchPreview {
  const settings = new SettingsManager(target.cwd, "full");
  return switchPlan(target, name, settings.getRawForScope("project", target.cwd, { strict: true }))
    .preview;
}

/** CAS and the sole profile-subtree write share the existing cross-process settings lock. */
export function adoptProfileSwitch(
  target: SwitchTarget,
  name: string | null,
  expectedRevision: string,
): ProfileSwitchAdoptResult {
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))
    throw new Error("invalid profile switch revision");
  let result: ProfileSwitchAdoptResult = { status: "stale" };
  const settings = new SettingsManager(target.cwd, "full");
  settings.mutateSettingsForScope("project", target.cwd, (current) => {
    const plan = switchPlan(target, name, current);
    if (plan.preview.revision !== expectedRevision) return false;
    if (plan.subtree) current.profile = plan.subtree;
    else delete current.profile;
    result = { status: "adopted" };
  });
  return result;
}
