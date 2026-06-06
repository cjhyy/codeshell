export type ExternalAgentKind = "claude-code" | "codex";
export type ExternalAgentMode = "safe" | "dangerous";
export type ExternalAgentModeOverride = ExternalAgentMode | undefined;

export interface ClaudeCodeSettings {
  command?: string;
  defaultMode?: ExternalAgentMode;
  dangerousArgs?: string[];
  trustedWorkspaces?: string[];
  autoStartInTrustedWorkspaces?: boolean;
}

export interface CodexSettings {
  command?: string;
  args?: string[];
}

export interface ExternalAgentsSettings {
  claudeCode?: ClaudeCodeSettings;
  codex?: CodexSettings;
}

export interface ResolvedClaudeCodeSettings {
  command: string;
  defaultMode: ExternalAgentMode;
  dangerousArgs: string[];
  trustedWorkspaces: string[];
  autoStartInTrustedWorkspaces: boolean;
}

export interface ResolvedCodexSettings {
  command: string;
  args: string[];
}

export interface ResolvedExternalAgentsConfig {
  claudeCode: ResolvedClaudeCodeSettings;
  codex: ResolvedCodexSettings;
}

export interface ClaudeModeDecision {
  mode: ExternalAgentMode;
  args: string[];
  requiresHighRiskApproval: boolean;
  reason:
    | "explicit_safe"
    | "safe_default"
    | "trusted_workspace_default"
    | "dangerous_outside_trusted_workspace"
    | "explicit_dangerous_trusted_workspace"
    | "explicit_dangerous_outside_trusted_workspace";
}
