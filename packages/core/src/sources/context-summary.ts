import type { SettingsManager } from "../settings/manager.js";
import { defaultCredentialStatus } from "./credential-status.js";
import { resolveEffectiveSourceAccess, type CredentialStatusFn } from "./resolve.js";
import type { ResolveSourceAccessInput } from "./resolve.js";

export const HIGH_PRIORITY_SOURCE_GUIDANCE =
  "For tasks relevant to these materials, consider available high-priority sources first. Follow each source's scopes, read policy and approval requirements.";

export interface BuildSourcesContextSummaryInput {
  cwd: string;
  settings: SettingsManager;
  credentialStatus?: CredentialStatusFn;
  settingsScope?: ResolveSourceAccessInput["settingsScope"];
  workspaceProfileName?: string;
  isSourceProfileCurrent?(): boolean;
}

export function buildSourcesContextSummary(input: BuildSourcesContextSummaryInput): string {
  if (input.isSourceProfileCurrent && !input.isSourceProfileCurrent()) return "";
  const sources = resolveEffectiveSourceAccess({
    cwd: input.cwd,
    settings: input.settings,
    credentialStatus: input.credentialStatus ?? defaultCredentialStatus,
    settingsScope: input.settingsScope,
    workspaceProfileName: input.workspaceProfileName,
  });
  if (sources.length === 0) return "";

  const lines = sources.map(
    ({ label, kind, status, scopes, priority }) =>
      `- ${label}${priority === "high" ? " [high priority]" : ""} (${kind}, ${status}): ${scopes.join(", ") || "(no scopes)"}`,
  );
  if (sources.some((source) => source.priority === "high"))
    lines.unshift(HIGH_PRIORITY_SOURCE_GUIDANCE);
  return `## Bound data sources\n${lines.join("\n")}`;
}
