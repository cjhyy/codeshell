import type {
  ExternalAgentsSettings,
  ResolvedExternalAgentsConfig,
} from "./types.js";

export function resolveExternalAgentConfig(
  settings: ExternalAgentsSettings | undefined,
): ResolvedExternalAgentsConfig {
  return {
    claudeCode: {
      command: settings?.claudeCode?.command ?? "claude",
      defaultMode: settings?.claudeCode?.defaultMode ?? "safe",
      dangerousArgs: settings?.claudeCode?.dangerousArgs ?? [],
      trustedWorkspaces: settings?.claudeCode?.trustedWorkspaces ?? [],
      autoStartInTrustedWorkspaces: settings?.claudeCode?.autoStartInTrustedWorkspaces ?? false,
    },
    codex: {
      command: settings?.codex?.command ?? "codex",
      args: settings?.codex?.args ?? [],
    },
  };
}
