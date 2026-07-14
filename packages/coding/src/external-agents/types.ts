/** Permission profile for an external coding agent. */
export type ExternalAgentMode = "safe" | "dangerous";

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
