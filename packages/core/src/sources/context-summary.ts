import type { SettingsManager } from "../settings/manager.js";
import { defaultCredentialStatus } from "./credential-status.js";
import { resolveEffectiveSourceAccess, type CredentialStatusFn } from "./resolve.js";
import type { ResolveSourceAccessInput } from "./resolve.js";

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
    ({ label, kind, status, scopes }) =>
      `- ${label} (${kind}, ${status}): ${scopes.join(", ") || "(no scopes)"}`,
  );
  return `## Bound data sources\n${lines.join("\n")}`;
}
