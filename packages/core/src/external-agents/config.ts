import type {
  ClaudeModeDecision,
  ExternalAgentModeOverride,
  ExternalAgentsSettings,
  ResolvedClaudeCodeSettings,
  ResolvedExternalAgentsConfig,
} from "./types.js";

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function isTrustedWorkspace(cwd: string, trustedWorkspaces: string[]): boolean {
  const normalizedCwd = normalizePath(cwd);
  return trustedWorkspaces.some((path) => normalizedCwd === normalizePath(path));
}

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

export function resolveClaudeModeForWorkspace(
  cfg: ResolvedClaudeCodeSettings,
  cwd: string,
  override: ExternalAgentModeOverride,
): ClaudeModeDecision {
  const trusted = isTrustedWorkspace(cwd, cfg.trustedWorkspaces);
  if (override === "safe") {
    return { mode: "safe", args: [], requiresHighRiskApproval: false, reason: "explicit_safe" };
  }
  if (override === "dangerous") {
    return {
      mode: "dangerous",
      args: cfg.dangerousArgs,
      requiresHighRiskApproval: !trusted,
      reason: trusted
        ? "explicit_dangerous_trusted_workspace"
        : "explicit_dangerous_outside_trusted_workspace",
    };
  }
  if (cfg.defaultMode === "dangerous") {
    return {
      mode: "dangerous",
      args: cfg.dangerousArgs,
      requiresHighRiskApproval: !(trusted && cfg.autoStartInTrustedWorkspaces),
      reason: trusted ? "trusted_workspace_default" : "dangerous_outside_trusted_workspace",
    };
  }
  return { mode: "safe", args: [], requiresHighRiskApproval: false, reason: "safe_default" };
}
