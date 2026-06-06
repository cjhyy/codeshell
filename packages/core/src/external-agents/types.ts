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

export type ExternalAgentJobStatus = "queued" | "running" | "completed" | "failed" | "killed";

export interface ExternalAgentJob {
  id: string;
  kind: ExternalAgentKind;
  sessionId: string;
  cwd: string;
  prompt: string;
  mode: ExternalAgentMode;
  args: string[];
  status: ExternalAgentJobStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export type ExternalAgentEvent =
  | { type: "job.started"; job: ExternalAgentJob }
  | { type: "job.output"; jobId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "job.completed"; job: ExternalAgentJob }
  | { type: "job.failed"; job: ExternalAgentJob; error: string }
  | { type: "job.killed"; job: ExternalAgentJob };

export interface StartExternalAgentJobInput {
  kind: ExternalAgentKind;
  sessionId: string;
  cwd: string;
  prompt: string;
  mode?: ExternalAgentMode;
  args?: string[];
  command: string;
}

export interface ExternalAgentAdapter {
  start(
    input: StartExternalAgentJobInput,
    onEvent: (event: ExternalAgentEvent) => void,
  ): ExternalAgentJob;
  stop(jobId: string): Promise<boolean>;
}
