// Automation summaries and inputs exchanged over the automation:* IPC routes.
export type AutomationPermissionLevel = "read-only" | "workspace-write" | "full";

export interface AutomationSummary {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  /** Why the scheduler auto-disabled the job; null when enabled or paused by hand. */
  disabledReason?: string | null;
  cwd: string | null;
  projectId: string | null;
  rootId: string | null;
  timezone: string | null;
  permissionLevel: AutomationPermissionLevel | null;
  lastRun: number | null;
  nextRun: number | null;
  runCount: number;
  createdAt: number;
  /** @deprecated Always null — automation runs as a Session, not a RunManager run. */
  lastRunId: string | null;
  once: boolean;
  resumeSessionId: string | null;
  templateSource: {
    installKey: string;
    templateId: string;
    revision: string;
    pluginVersion?: string;
  } | null;
}

export interface CreateAutomationInput {
  name: string;
  schedule: string;
  prompt: string;
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
  timezone?: string;
  permissionLevel?: AutomationPermissionLevel;
  resumeSessionId?: string;
}

export interface UpdateAutomationInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
  permissionLevel?: AutomationPermissionLevel;
  resumeSessionId?: string | null;
}
