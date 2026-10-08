/**
 * EffectiveSourceAccess：binding × source.enabled × credential 状态求交，
 * 默认 deny（ADR §1.3/§3）。Profile 只收窄 binding，不能扩大授权。
 */
import { createHash } from "node:crypto";
import { resolveActiveWorkspaceProfileSelection } from "../profile/resolve.js";
import type { WorkspaceProfile } from "../profile/types.js";
import type { SettingsManager } from "../settings/manager.js";
import {
  LOCAL_FILES_SOURCE_ID,
  listLocalFiles,
  localFilesSourceFor,
} from "./adapters/local-files.js";
import { listBindings } from "./binding.js";
import { readSourceDefinition } from "./catalog.js";
import { isLinkSourceAvailable, linkSourceAuthorityRevision } from "./link-view.js";
import type { SourceDefinition, WorkspaceSourceBinding } from "./types.js";

export type SourceAccessStatus = "ok" | "dangling" | "unavailable";
export type CredentialStatusFn = (
  ref: string,
  context?: { cwd: string; settingsScope?: import("../settings/manager.js").SettingsScope },
) => "ok" | "missing" | "expired";

export interface EffectiveSourceAccess {
  sourceId: string;
  label: string;
  kind: string;
  scopes: string[];
  readPolicy: "ask" | "deny";
  status: SourceAccessStatus;
  definition?: SourceDefinition;
  /** Opaque Profile identity/revision for final authority checks, never prompt content. */
  profileRevision?: string;
  /** Opaque account/grant/resource snapshot; never contains bearer material. */
  credentialRevision?: string;
}

export interface ResolveSourceAccessInput {
  cwd: string;
  settings: SettingsManager;
  credentialStatus: CredentialStatusFn;
  settingsScope?: import("../settings/manager.js").SettingsScope;
  workspaceProfileName?: string;
  /** Explicit trusted Profile input; omitted resolves Session pin/project selection. */
  profile?: Pick<WorkspaceProfile, "name" | "sourceAccess">;
}

function statusOf(
  definition: SourceDefinition | undefined,
  credentialStatus: CredentialStatusFn,
  context: { cwd: string; settingsScope?: import("../settings/manager.js").SettingsScope },
): SourceAccessStatus {
  if (!definition) return "dangling";
  if (!definition.enabled) return "unavailable";
  if (definition.kind === "link" && !isLinkSourceAvailable(definition, context))
    return "unavailable";
  if (definition.credentialRef && credentialStatus(definition.credentialRef, context) !== "ok") {
    return "unavailable";
  }
  return "ok";
}

function definitionFor(binding: WorkspaceSourceBinding, cwd: string): SourceDefinition | undefined {
  return binding.sourceId === LOCAL_FILES_SOURCE_ID
    ? localFilesSourceFor(cwd)
    : readSourceDefinition(binding.sourceId);
}

export function resolveEffectiveSourceAccess(
  input: ResolveSourceAccessInput,
): EffectiveSourceAccess[] {
  const bindings = listBindings(input.settings, input.cwd);
  const access = bindings.map((binding) => {
    const definition = definitionFor(binding, input.cwd);
    return {
      sourceId: binding.sourceId,
      label: definition?.label ?? binding.sourceId,
      kind: definition?.kind ?? "unknown",
      scopes: binding.scopes,
      readPolicy: binding.readPolicy,
      status: statusOf(definition, input.credentialStatus, input),
      ...(definition ? { definition } : {}),
      ...(definition?.kind === "link"
        ? { credentialRevision: linkSourceAuthorityRevision(definition, input) }
        : {}),
    } satisfies EffectiveSourceAccess;
  });

  const hasImplicitLocalFiles = bindings.length > 0 || listLocalFiles(input.cwd).length > 0;
  if (hasImplicitLocalFiles && !access.some((item) => item.sourceId === LOCAL_FILES_SOURCE_ID)) {
    const definition = localFilesSourceFor(input.cwd);
    access.push({
      sourceId: definition.id,
      label: definition.label,
      kind: definition.kind,
      scopes: ["uploads"],
      readPolicy: "ask",
      status: "ok",
      definition,
    });
  }

  const selection = input.profile
    ? { name: input.profile.name, profile: input.profile }
    : resolveActiveWorkspaceProfileSelection({
        cwd: input.cwd,
        settings: input.settings,
        sessionProfile: input.workspaceProfileName,
      });
  // A missing selected Profile must not silently restore unrestricted bindings.
  if (selection.name && !selection.profile) return [];
  const profileRevision = selection.name
    ? createHash("sha256").update(JSON.stringify(selection)).digest("hex")
    : undefined;
  const rules = selection.profile?.sourceAccess;
  return access.flatMap((item) => {
    const rule = rules?.find((candidate) => candidate.sourceId === item.sourceId);
    if (rules !== undefined && !rule) return [];
    return [
      {
        ...item,
        scopes: rule ? item.scopes.filter((scope) => rule.scopes.includes(scope)) : item.scopes,
        readPolicy: item.readPolicy === "deny" || rule?.readPolicy === "deny" ? "deny" : "ask",
        ...(profileRevision ? { profileRevision } : {}),
      },
    ];
  });
}
