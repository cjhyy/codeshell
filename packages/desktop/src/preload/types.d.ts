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
  /** Owning chat session — renderer routes the modal to the right tab. */
  sessionId?: string;
  requestId: string;
  request: ApprovalRequest;
}

/**
 * Multi-session stream envelope. The renderer routes by sessionId; a missing
 * sessionId (legacy single-engine path) routes to the active session.
 */
export interface StreamEventEnvelope {
  sessionId: string;
  event: StreamEvent;
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

export interface GitBranches {
  isRepo: boolean;
  current: string | null;
  branches: string[];
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  current: boolean;
}

export interface CreatedWorktree {
  path: string;
  name: string;
  branch: string;
  originalBranch: string | null;
}

export interface InstalledSkill {
  name: string;
  targetDir: string;
  filePath: string;
}

export interface CodeshellApi {
  /** Forward a structured log line to ~/.code-shell/logs/desktop-*.log via main. */
  log(msg: string, data?: Record<string, unknown>): void;
  run(
    prompt: string,
    opts?: {
      cwd?: string;
      sessionId?: string;
      permissionMode?: "plan" | "default" | "acceptEdits" | "bypassPermissions";
      planMode?: boolean;
    },
  ): Promise<RpcResponse>;
  /** Cancel a session's running turn. sessionId optional for legacy callers. */
  cancel(sessionId?: string): Promise<RpcResponse>;
  /** Multi-session form. The dual-arg legacy form is also supported at runtime. */
  approve(
    sessionId: string,
    requestId: string,
    decision: "approve" | "deny",
    reason?: string,
    answer?: string,
  ): Promise<RpcResponse>;
  /** Legacy approve form — single-engine callers (kept for backward compat). */
  approve(
    requestId: string,
    decision: "approve" | "deny",
    reason?: string,
    answer?: string,
  ): Promise<RpcResponse>;
  /** Destroy a chat session and free its resources. */
  closeSession(sessionId: string): Promise<RpcResponse>;
  onStreamEvent(cb: (env: StreamEventEnvelope) => void): Unsubscribe;
  onApprovalRequest(cb: (env: ApprovalRequestEnvelope) => void): Unsubscribe;
  onStatus(cb: (evt: AgentStatusEvent) => void): Unsubscribe;
  onAgentLifecycle(cb: (evt: AgentLifecycleEvent) => void): Unsubscribe;
  /** Show native folder picker. Resolves to null if user canceled. */
  pickDir(): Promise<{ path: string; name: string } | null>;
  pickSkillDir(): Promise<{ path: string; name: string } | null>;

  // Phase 4 — git / shell services (renderer never spawns child procs directly).
  getGitStatus(cwd: string): Promise<GitStatus>;
  getGitBranches(cwd: string): Promise<GitBranches>;
  switchGitBranch(cwd: string, branch: string): Promise<GitBranches>;
  stashAndSwitchGitBranch(cwd: string, branch: string): Promise<GitBranches>;
  createWorktree(cwd: string, name: string): Promise<CreatedWorktree>;
  listWorktrees(cwd: string): Promise<WorktreeInfo[]>;
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
  listSkills(cwd: string): Promise<SkillSummary[]>;
  listPlugins(cwd: string): Promise<PluginSummary[]>;
  readSkillBody(filePath: string): Promise<string>;
  installLocalSkill(
    sourceDir: string,
    scope: "user" | "project",
    cwd?: string,
    name?: string,
  ): Promise<InstalledSkill>;
  uninstallSkill(filePath: string, source: "user" | "project" | "plugin"): Promise<void>;
  inspectGithubSkill(url: string, existingNames?: string[]): Promise<GithubRepoInspection>;
  installFromGithub(input: GithubSkillInstallInput): Promise<InstalledSkill>;
  probeMcpServers(
    configs: McpServerProbeInput[],
    force?: boolean,
  ): Promise<McpProbeResult[]>;
  invalidateMcpProbeCache(name?: string): Promise<void>;
  probeSearch(input: SearchProbeInput): Promise<SearchProbeResult>;
  resolveModelMeta(
    models: Array<{ key: string; model?: string; providerKey?: string; maxContextTokens?: number | null }>,
    providers: Array<{ key?: string; kind?: string; baseUrl?: string; apiKey?: string }>,
  ): Promise<Array<{
    key: string;
    maxContextTokens: number;
    maxCompletionTokens?: number;
    source: "settings" | "openrouter-api" | "hardcoded" | "fallback";
    supportsVision: boolean;
  }>>;
  listModels(
    provider: {
      key?: string;
      kind?: string;
      baseUrl?: string;
      apiKey?: string;
      modelsPath?: string;
    },
    refresh?: boolean,
  ): Promise<{
    fetchedAt: string;
    providerKey: string;
    models: Array<{ id: string; contextLength: number; maxOutputTokens: number }>;
    error?: string;
    fromCache?: boolean;
  }>;

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

export interface GithubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

export interface GithubDetectedSkill {
  name: string;
  description: string;
  pathInRepo: string;
  dirInRepo: string;
  alreadyInstalled?: boolean;
}

export interface GithubRepoInspection {
  url: GithubUrlInfo;
  defaultBranch: string;
  skills: GithubDetectedSkill[];
  isPlugin: boolean;
  totalDetected: number;
  warning?: string;
}

export interface GithubSkillInstallInput {
  inspection: GithubRepoInspection;
  selected: GithubDetectedSkill;
  scope: "user" | "project";
  cwd?: string;
  installName?: string;
}

export interface SearchProbeInput {
  provider: "serper" | "tavily" | "searxng";
  apiKey?: string;
  baseUrl?: string;
}

export interface SearchProbeResult {
  status: "ok" | "error" | "unconfigured";
  sampleTitles?: string[];
  errorMessage?: string;
  errorDetail?: string;
  lastProbedAt: string;
}

export interface McpServerProbeInput {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  headers?: Record<string, string>;
}

export interface McpProbedTool {
  name: string;
  description?: string;
}

export interface McpProbeResult {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  status: "ok" | "error" | "probing" | "unknown";
  lastProbedAt?: string;
  toolCount?: number;
  tools?: McpProbedTool[];
  errorMessage?: string;
  errorDetail?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
  filePath: string;
}

export interface PluginSummary {
  /** Display name (without the `@marketplace` suffix). */
  name: string;
  /** Full install key from installed-plugins.json (e.g. "superpowers@official"). */
  installKey: string;
  /** Marketplace source — null for direct git / GitHub installs without marketplace. */
  marketplace: string | null;
  /** Source line shown under the plugin name. */
  sourceLabel: string;
  /** Plugin install path (truncated display elsewhere). */
  installPath: string;
  installedAt: string;
  version: string;
  /** Number of skills this plugin contributes. */
  skillCount: number;
  /** Optional plugin description if `plugin.json` provides one. */
  description?: string;
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
