import type { SettingsManager } from "../settings/manager.js";
import { defaultCredentialStatus } from "./credential-status.js";
import { resolveEffectiveSourceAccess, type CredentialStatusFn } from "./resolve.js";

export interface BuildSourcesContextSummaryInput {
  cwd: string;
  settings: SettingsManager;
  credentialStatus?: CredentialStatusFn;
}

export function buildSourcesContextSummary(input: BuildSourcesContextSummaryInput): string {
  const sources = resolveEffectiveSourceAccess({
    cwd: input.cwd,
    settings: input.settings,
    credentialStatus: input.credentialStatus ?? defaultCredentialStatus,
  });
  if (sources.length === 0) return "";

  const lines = sources.map(
    ({ label, kind, status, scopes }) =>
      `- ${label} (${kind}, ${status}): ${scopes.join(", ") || "(no scopes)"}`,
  );
  return `## Bound data sources\n${lines.join("\n")}`;
}
