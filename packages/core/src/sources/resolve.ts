/**
 * EffectiveSourceAccess：binding × source.enabled × credential 状态求交，
 * 默认 deny（ADR §1.3/§3）。`profile` 参数为 Profile 求交预留（ADR §6），
 * 本期恒不传；接线时 effective = binding ∩ profile 声明，只能收窄。
 */
import type { SettingsManager } from "../settings/manager.js";
import {
  LOCAL_FILES_SOURCE_ID,
  listLocalFiles,
  localFilesSourceFor,
} from "./adapters/local-files.js";
import { listBindings } from "./binding.js";
import { readSourceDefinition } from "./catalog.js";
import type { SourceDefinition, WorkspaceSourceBinding } from "./types.js";

export type SourceAccessStatus = "ok" | "dangling" | "unavailable";
export type CredentialStatusFn = (ref: string) => "ok" | "missing" | "expired";

export interface EffectiveSourceAccess {
  sourceId: string;
  label: string;
  kind: string;
  scopes: string[];
  readPolicy: "ask" | "deny";
  status: SourceAccessStatus;
  definition?: SourceDefinition;
}

export interface ResolveSourceAccessInput {
  cwd: string;
  settings: SettingsManager;
  credentialStatus: CredentialStatusFn;
  /** Profile 求交预留（ADR §6）；本期不实现。 */
  profile?: { requiredSources?: string[] };
}

function statusOf(
  definition: SourceDefinition | undefined,
  credentialStatus: CredentialStatusFn,
): SourceAccessStatus {
  if (!definition) return "dangling";
  if (!definition.enabled) return "unavailable";
  if (definition.credentialRef && credentialStatus(definition.credentialRef) !== "ok") {
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
      status: statusOf(definition, input.credentialStatus),
      ...(definition ? { definition } : {}),
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

  return access;
}
