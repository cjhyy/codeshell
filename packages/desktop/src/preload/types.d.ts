/**
 * Renderer-visible types for window.codeshell. Imports `type`-only from
 * core; nothing at runtime crosses the boundary (the lint rule that bans
 * core imports in renderer source explicitly allows `import type`).
 */

import type { StreamEvent, ApprovalRequest } from "@cjhyy/code-shell-core";

/**
 * The wire envelope the agent server sends for tool approvals. The
 * outer requestId is what the renderer echoes back via approve();
 * the inner request carries what the user actually needs to see.
 */
export interface ApprovalRequestEnvelope {
  requestId: string;
  request: ApprovalRequest;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export type AgentStatusEvent = { status: "ready" | "shutting_down" | string };

export type AgentLifecycleEvent =
  | { type: "exited"; code: number | null }
  | { type: "restarted" }
  | { type: "gave_up" };

export type Unsubscribe = () => void;

export interface GitStatusEntry {
  code: string;
  path: string;
}

export interface GitStatus {
  branch: string | null;
  entries: GitStatusEntry[];
  clean: boolean;
}

export interface CodeshellApi {
  /** Forward a structured log line to ~/.code-shell/logs/desktop-*.log via main. */
  log(msg: string, data?: Record<string, unknown>): void;
  run(prompt: string, opts?: { cwd?: string; sessionId?: string }): Promise<RpcResponse>;
  cancel(): Promise<RpcResponse>;
  approve(
    id: string,
    decision: "approve" | "deny",
    reason?: string,
    /** For AskUserQuestion: the user's selected/typed answer. */
    answer?: string,
  ): Promise<RpcResponse>;
  onStreamEvent(cb: (event: StreamEvent) => void): Unsubscribe;
  onApprovalRequest(cb: (env: ApprovalRequestEnvelope) => void): Unsubscribe;
  onStatus(cb: (evt: AgentStatusEvent) => void): Unsubscribe;
  onAgentLifecycle(cb: (evt: AgentLifecycleEvent) => void): Unsubscribe;
  /** Show native folder picker. Resolves to null if user canceled. */
  pickDir(): Promise<{ path: string; name: string } | null>;

  // Phase 4 — git / shell services (renderer never spawns child procs directly).
  getGitStatus(cwd: string): Promise<GitStatus>;
  /** Unified diff for the working tree (vs HEAD). file optional. */
  getGitDiff(cwd: string, file?: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;

  // Phase 5 — settings / sessions / logs.
  getSettings(scope: "user" | "project", cwd?: string): Promise<Record<string, unknown> | null>;
  updateSettings(scope: "user" | "project", patch: Record<string, unknown>, cwd?: string): Promise<void>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listSessionTitles(): Promise<Record<string, string>>;
  renameSession(id: string, title: string): Promise<void>;
  tailLog(bucket: "ui-ink" | "engine" | "desktop", lines?: number): Promise<string[]>;
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail | null>;

  // Phase 6 — native polish & security.
  getTrust(path: string): Promise<"trusted" | "untrusted" | "unknown">;
  setTrust(path: string, level: "trusted" | "untrusted"): Promise<void>;
  recents(): Promise<{ path: string; name: string; lastOpenedAt: number }[]>;
  notify(opts: { title: string; body?: string; subtitle?: string }): Promise<void>;
  setBadgeCount(count: number): Promise<void>;
  onMenuEvent(cb: (event: string, payload?: unknown) => void): Unsubscribe;
  newWindow(): Promise<void>;
  checkForUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getUpdaterStatus(): Promise<UpdaterStatus>;
  onUpdaterStatus(cb: (status: UpdaterStatus) => void): Unsubscribe;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

export interface DesktopSessionSummary {
  id: string;
  file: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunSummary {
  runId: string;
  objective: string;
  preset?: string;
  cwd: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sessionId: string | null;
  error: string | null;
  summary: string | null;
}

export interface RunDetail extends RunSummary {
  attemptCount: number;
  latestCheckpointId: string | null;
  latestApprovalId: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  events: Array<{ eventId: string; type: string; timestamp: number; data: Record<string, unknown> }>;
  checkpoints: Array<{
    checkpointId: string;
    createdAt: number;
    phase: string;
    summary: string;
    nextAction: string | null;
  }>;
  artifacts: string[];
}

declare global {
  interface Window {
    codeshell: CodeshellApi;
  }
}

export {};
