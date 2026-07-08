/**
 * Renderer-visible types for window.codeshell. Imports `type`-only from
 * core; nothing at runtime crosses the boundary (the lint rule that bans
 * core imports in renderer source explicitly allows `import type`).
 */

import type {
  StreamEvent,
  ApprovalRequest,
  CapabilityDescriptor,
  ReasoningControl,
  CCAvailability,
  DiscoveredSession,
  QuotaResult,
  SessionWorkspace,
} from "@cjhyy/code-shell-core";

export type { SessionWorkspace };

/** One step in replaying a persisted transcript into renderer state. */
export type FoldItem =
  | { kind: "stream"; event: StreamEvent; timestamp?: number }
  | { kind: "user"; text: string; steerId?: string; clientMessageId?: string; timestamp?: number }
  // User interrupted this turn (Stop). Rebuilt from the core transcript's
  // `turn_stopped` event so resume restores the "你停止了本轮" marker; without
  // it the interrupted turn folds behind the process-card header on reload.
  | { kind: "turn_stopped"; timestamp?: number };

/**
 * The wire envelope the agent server sends for tool approvals. The
 * outer requestId is what the renderer echoes back via approve();
 * the inner request carries what the user actually needs to see.
 */
/** One background shell surfaced to the dock panel (TODO 3.2). */
export interface BackgroundShellInfo {
  shellId: string;
  sessionId: string;
  command: string;
  cwd: string;
  status: "starting" | "running" | "exited" | "killed" | "orphaned";
  startedAt: number;
  exitedAt?: number;
  exitCode: number | null;
  signal: string | null;
  detectedPort?: number;
  /** Total bytes written so far (monotonic). Shown as live progress for
   *  long jobs like downloads. May be absent from older core builds. */
  totalBytes?: number;
}

export interface BackgroundWorkSourceSession {
  sessionId: string;
  shortId: string;
  title?: string;
  current: boolean;
}

type BackgroundWorkWithSource<T> = T & { sourceSession: BackgroundWorkSourceSession };

/** One unified background-work row for the background panel. Discriminated by
 *  `kind`; mirrors core BackgroundWorkEntry (shells + sub-agents + jobs). */
export type BackgroundWorkInfo =
  | BackgroundWorkWithSource<{ kind: "shell"; shell: BackgroundShellInfo }>
  | BackgroundWorkWithSource<{
      kind: "subagent";
      agentId: string;
      name?: string;
      agentType?: string;
      description: string;
      status: "running" | "completed" | "failed" | "cancelled";
      startedAt: number;
      finishedAt?: number;
    }>
  | BackgroundWorkWithSource<{
      kind: "job";
      jobId: string;
      description: string;
      status: "running" | "completed" | "failed";
      startedAt: number;
      finishedAt?: number;
      /** Result summary / error, once finished. */
      finalText?: string;
      /** Files an external agent (DriveAgent) changed, parsed from its transcript. */
      changedFiles?: string[];
    }>;

export type WorktreeCleanupSkippedEvent = {
  root: string;
  skipped: Array<{
    path: string;
    branch: string;
    reason: "dirty" | "unmerged_commits" | "base_unknown" | "inspect_failed" | "remove_failed";
    detail?: string;
  }>;
};

export type PtyStartResult = { ok: true; pid: number } | { ok: false; detail: string };

/** A plugin-provided hook surfaced to the settings 钩子 page. Mirrors
 *  core's PluginHookEntry (renderer can't import core). */
export interface PluginHookEntry {
  plugin: string;
  event: string;
  rawEvent: string;
  command: string;
  matcher?: string;
  disabled: boolean;
  /** Stable per-hook identity (`plugin:RawEvent:command`) — the record key
   *  written to `capabilityOverrides.pluginHooks` to toggle just this hook. */
  key: string;
}

export interface ApprovalRequestEnvelope {
  /** Owning chat session — renderer routes the modal to the right tab. */
  sessionId?: string;
  requestId: string;
  request: ApprovalRequest;
}

export interface ApprovalResolvedEnvelope {
  /** Owning engine session when known. */
  sessionId?: string;
  requestId: string;
  approved?: boolean;
}

export type MobilePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface MobilePermissionModeEnvelope {
  sessionId: string;
  mode: MobilePermissionMode;
}

export interface MobilePermissionModeSnapshotEntry {
  sessionId: string;
  mode: MobilePermissionMode;
}

/**
 * Multi-session stream envelope. The renderer routes by sessionId; a missing
 * sessionId (legacy single-engine path) routes to the active session.
 */
export interface StreamEventEnvelope {
  sessionId: string;
  event: StreamEvent;
}

/** One entry in a main-held session snapshot: a forwarded event + its seq. */
export interface SnapshotEntry {
  seq: number;
  event: StreamEvent;
}

/** Reply to subscribeSession — events past the requested cursor + next cursor. */
export interface SessionSnapshot {
  events: SnapshotEntry[];
  nextSeq: number;
}

/**
 * A raw on-disk transcript event (getSessionRawEvents). Preserves the stable
 * `id` (dedup key) and `turnNumber`/`timestamp` that the folded reader drops.
 */
export interface RawTranscriptEvent {
  id: string;
  type: string;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export type AgentStatusEvent = { status: "ready" | "shutting_down" | string };

/**
 * Per-path outcome of an undoFiles batch. Mirrors the shape declared
 * in main/desktop-services.ts. `action` records what we tried to do
 * (restore via git, remove from disk, or skip because the path was
 * rejected); `ok=false` carries the underlying error message.
 */
export interface UndoFilesResult {
  path: string;
  ok: boolean;
  action: "restore" | "remove" | "skip";
  error?: string;
}

/** State of the latest turn's snapshot-based undo (files:turnUndoState). */
export interface TurnUndoState {
  /** The latest turn has live snapshots and can be undone. */
  undoable: boolean;
  /** The latest turn was undone and can be re-applied. */
  redoable: boolean;
  /** Files the undo/redo would touch (for the card label). */
  fileCount: number;
}

/** Per-file outcome of a turn-level undo/redo (files:undoTurn / files:redoTurn). */
export interface TurnUndoResult {
  filePath: string;
  ok: boolean;
}

export type MemoryLevel = "user" | "project";
export type MemoryScope = "user" | "dream" | "pending";
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface RendererMemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  fileName: string;
  scope: MemoryScope;
  level: MemoryLevel;
  /** 固定/置顶 — exempt from maxAge injection filtering, sorts first. */
  pinned?: boolean;
  id?: string;
  /** Provenance: "manual" user/UI, "auto" extractor, "dream" dream consolidation. */
  origin?: "auto" | "manual" | "dream";
  /** Recall lifecycle — how many times read, when last read, when created.
   *  Surfaced in the settings panel; drives recall-based TTL in core. */
  useCount?: number;
  updateCount?: number;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  usageCount?: number;
  lastUsed?: string;
  created?: string;
  originProject?: string;
  originProjects?: string[];
  promotionReason?: string;
  promotionStatus?: "pending" | "rejected";
}

export interface RendererMemoryEntryFull extends RendererMemoryEntry {
  content: string;
}

export interface SaveMemoryInput {
  level: MemoryLevel;
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  cwd?: string;
  pinned?: boolean;
  id?: string;
  origin?: "auto" | "manual" | "dream";
}

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

/** One recent commit for the review panel's 提交 submenu. */
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  relativeDate: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  current: boolean;
}

export interface SessionWorkspaceWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain?: boolean;
  isManaged?: boolean;
  diff?: WorktreeDiffSummary;
  occupiedBySessionIds?: string[];
  occupiedByOtherSession?: boolean;
}

export interface WorktreeDiffSummary {
  baseRef?: string;
  changedFiles: number;
  aheadCommits: number;
  hasUncommittedChanges: boolean;
}

export interface SessionWorkspaceList {
  current: SessionWorkspace;
  mainRoot: string;
  worktrees: SessionWorkspaceWorktreeInfo[];
}

export type WorkspaceReleaseResult =
  | { sessionId: string; ok: true; status: "released"; workspace: SessionWorkspace }
  | { sessionId: string; ok: true; status: "missing"; reason: string }
  | { sessionId: string; ok: false; status: "error"; error: string };

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

/** One entry in the file-browser tree. */
export interface FsEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
}

/** A file's contents for the file-browser preview. */
export interface FileContent {
  path: string;
  /** UTF-8 text, or null when binary / too large. */
  text: string | null;
  reason?: "too-large" | "binary";
  size: number;
}

/** A stored credential (token/link) as edited in the renderer. */
export interface CredentialView {
  id: string;
  type: "token" | "link" | "cookie";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  /** 逐条「AI 可自动取用」开关(取 cookie 文件走 HTTP,免审批门)。 */
  autoUseByAI?: boolean;
  /** 逐条「AI 可自动注入浏览器」开关(把 cookie 灌进内置浏览器,免审批门)。 */
  autoInjectByAI?: boolean;
  /** link: appUrl;cookie: 拓取平台与主域 + 抓取范围(all=全量分区)+ 切换策略。 */
  meta?: {
    appUrl?: string;
    platform?: string;
    domain?: string;
    scope?: "domain" | "all";
    switchMode?: "clear" | "merge";
  };
}
/** Masked credential returned to the renderer — never carries the secret value. */
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}

export type MarketplaceSource = { source: "github"; repo: string } | { source: "git"; url: string };

export type MarketplaceFormat = "claude-code" | "codex" | "universal";

export type PluginInstallJobStatus = "queued" | "installing" | "installed" | "failed";

export interface PluginInstallJob {
  id: string;
  pluginName: string;
  marketplaceName: string;
  status: PluginInstallJobStatus;
  requestedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface RecommendedMarketplace {
  id: string;
  name: string;
  description?: string;
  reason?: string;
  homepage?: string;
  source: MarketplaceSource;
  format?: MarketplaceFormat;
  official?: boolean;
  sort?: number;
  added?: boolean;
  pluginCount?: number;
}

export interface RecommendedMarketplaceList {
  source: "remote" | "cache" | "builtin";
  url?: string;
  error?: string;
  items: RecommendedMarketplace[];
}

export interface CodeshellApi {
  /** Main-process platform (`process.platform`), used for window chrome layout. */
  platform: string;
  /** Forward a structured log line to ~/.code-shell/logs/desktop-*.log via main. */
  log(msg: string, data?: Record<string, unknown>): void;
  run(
    prompt: string,
    opts?: {
      cwd?: string;
      sessionId?: string;
      permissionMode?: "plan" | "default" | "acceptEdits" | "auto" | "bypassPermissions";
      /** Model pool key to apply before this turn starts. */
      model?: string;
      /** Stable submit-intent id used for transcript/UI idempotency. */
      clientMessageId?: string;
      planMode?: boolean;
      /**
       * Goal mode: when set, the engine runs loop-until-done — on each
       * natural completion a GoalStopHook judges whether this goal is met
       * and, if not, re-prompts the model to continue (bounded by a
       * consecutive-block cap + maxTurns). Orthogonal to permissionMode.
       */
      goal?: string;
    },
  ): Promise<RpcResponse>;
  /** Cancel a session's running turn. sessionId optional for legacy callers. */
  cancel(sessionId?: string): Promise<RpcResponse>;
  /** Steer an in-flight run: queue a user message spliced at the next turn-loop
   *  step (不打断, for 引导). `id` is a stable handle echoed back on the
   *  steer_injected event and used to revoke via unsteer. Waits for the next
   *  run if none is active. */
  steer(
    sessionId: string,
    text: string,
    id?: string,
    clientMessageId?: string,
  ): Promise<RpcResponse>;
  /** Revoke a still-pending steer entry by id (撤回). The response data carries
   *  `{ removed }` — false if the loop already consumed it. */
  unsteer(sessionId: string, id: string): Promise<RpcResponse>;
  /**
   * Extend a running goal's turn / budget ceilings mid-run (TODO 3.1). Returns
   * the resulting effective limits; rejects if there's no active run.
   */
  goalExtend(
    sessionId: string,
    opts: {
      addTurns?: number;
      addTokenBudget?: number;
      addTimeBudgetMs?: number;
      addStopBlocks?: number;
    },
  ): Promise<{
    ok: boolean;
    limits: {
      maxTurns: number;
      tokenBudget?: number;
      timeBudgetMs?: number;
      maxStopBlocks: number;
    };
  }>;
  /** Clear a session's persisted active goal (CC /goal clear). */
  goalClear(sessionId: string): Promise<{ ok: boolean; cleared: boolean }>;
  /**
   * Read a session's persisted active goal objective (or null when none), so
   * the goal block + Cancel button can be re-surfaced on session load — a
   * persistent goal isn't replayed from the transcript, so a reloaded session
   * would otherwise show nothing.
   */
  goalGet(sessionId: string): Promise<{ ok: boolean; goal: string | null }>;
  /** Background-shell dock panel (TODO 3.2). */
  listBackgroundShells(sessionId: string): Promise<{ shells: BackgroundShellInfo[] }>;
  backgroundShellOutput(
    sessionId: string,
    shellId: string,
  ): Promise<{ header: string; text: string }>;
  killBackgroundShell(sessionId: string, shellId: string): Promise<{ ok: boolean }>;
  /** Unified background-work listing for the panel: shells + sub-agents + jobs. */
  listBackgroundWork(
    sessionId: string,
    opts?: { scope?: "session" | "all" },
  ): Promise<{ items: BackgroundWorkInfo[] }>;
  /**
   * Multi-session form. The dual-arg legacy form is also supported at runtime.
   * `scope` (once/session/project) on an approve threads to the engine's
   * ApprovalResult so the grant can be remembered for the session or project.
   */
  approve(
    sessionId: string,
    requestId: string,
    decision: "approve" | "deny",
    reason?: string,
    answer?: string,
    scope?: "once" | "session" | "project",
    pathScope?: "file" | "dir" | "tool",
  ): Promise<RpcResponse>;
  /** Legacy approve form — single-engine callers (kept for backward compat). */
  approve(
    requestId: string,
    decision: "approve" | "deny",
    reason?: string,
    answer?: string,
    scope?: "once" | "session" | "project",
    pathScope?: "file" | "dir" | "tool",
  ): Promise<RpcResponse>;
  /** Destroy a chat session and free its resources. */
  closeSession(sessionId: string): Promise<RpcResponse>;
  /**
   * Notify the agent worker of a configuration change.
   * Supports: { model?: string; reloadModels?: boolean; reloadSettings?: boolean }.
   * The worker applies model switches immediately — no restart needed.
   * `reloadSettings` hot-pushes disk-default config (preset / system prompts /
   * personalization / mcpServers) + settings hooks onto already-running
   * sessions; applied at the next turn boundary, in-flight turns untouched.
   */
  configure(params: {
    /**
     * When present, the configure targets ONE session's engine (per-session
     * model/permission/plan switch) instead of the worker-global default.
     * Routed to ChatSession.requestModelSwitch / setPermissionMode in
     * server.ts handleConfigure.
     */
    sessionId?: string;
    model?: string;
    permissionMode?: string;
    planMode?: boolean;
    reloadModels?: boolean;
    reloadSettings?: boolean;
  }): Promise<RpcResponse>;
  onStreamEvent(cb: (env: StreamEventEnvelope) => void): Unsubscribe;
  /**
   * Live automation session announcement. Fires once when an in-main
   * automation run emits session_started, carrying the engine sessionId plus
   * the job cwd + display title so the renderer can place the live run in the
   * correct project sidebar group (stream events carry no cwd).
   */
  onAutomationSession(
    cb: (meta: {
      sessionId: string;
      cwd: string;
      title: string;
      prompt: string;
      cronJobId: string;
      clientMessageId?: string;
    }) => void,
  ): Unsubscribe;
  /**
   * Mobile remote session announcement. Fires when a paired phone starts a
   * CodeShell run so the desktop renderer can place the session under the
   * correct project before stream events arrive.
   */
  onMobileSession(
    cb: (meta: {
      sessionId: string;
      cwd: string;
      title: string;
      prompt: string;
      clientMessageId?: string;
    }) => void,
  ): Unsubscribe;
  onApprovalRequest(cb: (env: ApprovalRequestEnvelope) => void): Unsubscribe;
  onApprovalResolved(cb: (env: ApprovalResolvedEnvelope) => void): Unsubscribe;
  onMobilePermissionMode(cb: (env: MobilePermissionModeEnvelope) => void): Unsubscribe;
  onStatus(cb: (evt: AgentStatusEvent) => void): Unsubscribe;
  onAgentLifecycle(cb: (evt: AgentLifecycleEvent) => void): Unsubscribe;
  onWorktreeCleanupSkipped(cb: (evt: WorktreeCleanupSkippedEvent) => void): Unsubscribe;
  /** Show native folder picker. Resolves to null if user canceled. */
  pickDir(): Promise<{ path: string; name: string } | null>;
  pickSkillDir(): Promise<{ path: string; name: string } | null>;
  pickGitBinary(): Promise<string | null>;

  // Phase 4 — git / shell services (renderer never spawns child procs directly).
  getGitStatus(cwd: string): Promise<GitStatus>;
  /** Per-file +/- line counts (vs HEAD) for the review tree (TODO 2.3a). */
  getGitNumstat(cwd: string): Promise<Record<string, { added: number; removed: number }>>;
  /** Changed files + numstat for a committed range, e.g. "HEAD~1..HEAD" (TODO 2.3a). */
  getGitRangeChanges(
    cwd: string,
    range: string,
  ): Promise<{
    entries: GitStatusEntry[];
    numstat: Record<string, { added: number; removed: number }>;
  }>;
  /** Base branch to diff against for branch scope; "" if none (TODO 2.3a). */
  getGitBranchBase(cwd: string): Promise<string>;
  getGitBranches(cwd: string): Promise<GitBranches>;
  switchGitBranch(cwd: string, branch: string): Promise<GitBranches>;
  stashAndSwitchGitBranch(cwd: string, branch: string): Promise<GitBranches>;
  createWorktree(cwd: string, name: string, branchPrefix?: string): Promise<CreatedWorktree>;
  listWorktrees(cwd: string): Promise<WorktreeInfo[]>;
  getSessionWorkspace(sessionId: string, cwd: string): Promise<SessionWorkspace>;
  listSessionWorktrees(sessionId: string, cwd: string): Promise<SessionWorkspaceList>;
  getSessionWorktreeDiff(sessionId: string, worktreePath: string): Promise<WorktreeDiffSummary>;
  switchSessionWorkspace(
    sessionId: string,
    cwd: string,
    target: string,
  ): Promise<SessionWorkspaceList>;
  releaseSessionWorkspace(sessionId: string): Promise<WorkspaceReleaseResult>;
  releaseManySessionWorkspaces(sessionIds: string[]): Promise<WorkspaceReleaseResult[]>;
  onWorkspaceChanged(
    cb: (event: { sessionId: string; workspace?: SessionWorkspace; mainRoot?: string }) => void,
  ): Unsubscribe;
  cleanupSessionWorktree(
    sessionId: string,
    cwd: string,
    worktreePath: string,
    action: "detach" | "discard",
  ): Promise<SessionWorkspaceList>;
  /**
   * Push Electron-local Git prefs (branch prefix, auto-cleanup) to
   * main. The renderer is the source of truth (localStorage); main
   * keeps an in-memory copy so the periodic worktree-cleanup task and
   * default branch prefix have something to consult.
   */
  setGitPrefs(prefs: {
    branchPrefix: string;
    autoDeleteWorktrees: boolean;
    autoDeleteWorktreesGraceMins: number;
  }): Promise<void>;
  /** Unified diff for the working tree (vs HEAD). file optional. */
  getGitDiff(
    cwd: string,
    file?: string,
    /** Which uncommitted changes to diff (review-panel scope). Default "all". */
    mode?: "unstaged" | "staged" | "all",
  ): Promise<string>;
  /** Unified diff for a committed range (e.g. "HEAD~1..HEAD"); optional file (TODO 2.3a). */
  getGitRangeDiff(cwd: string, range: string, file?: string): Promise<string>;
  /** Most recent commits for the review panel's 提交 submenu. */
  getGitRecentCommits(cwd: string, limit?: number): Promise<GitCommit[]>;

  // ── Terminal (pty) — interactive shell panel ──────────────────────────
  /** Token unique to this window's renderer process (for window-unique ids). */
  windowToken: string;
  /** Start (or reattach) the pty for sessionId. */
  ptyStart(opts: {
    sessionId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<PtyStartResult>;
  /** Send user keystrokes to the shell. */
  ptyWrite(sessionId: string, data: string): Promise<void>;
  /** Tell the shell the viewport changed. */
  ptyResize(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Terminate the shell. */
  ptyKill(sessionId: string): Promise<void>;
  /** Subscribe to shell output. Returns an unsubscribe fn. */
  onPtyData(cb: (msg: { sessionId: string; data: string }) => void): () => void;
  /** Subscribe to shell exit. Returns an unsubscribe fn. */
  onPtyExit(
    cb: (msg: { sessionId: string; exitCode: number; signal?: number }) => void,
  ): () => void;

  // ── Filesystem — file-browser panel ───────────────────────────────────
  /** List one directory level under the workspace root (dirs first). */
  readDir(root: string, dir: string): Promise<FsEntry[]>;
  /** Read a text file (capped at 2 MB; binary/oversize → text null). */
  readFileContent(root: string, path: string): Promise<FileContent>;
  /** Does this path resolve to an existing file inside root? Never throws. */
  fileExists(root: string, path: string): Promise<boolean>;

  // ── Credentials module ────────────────────────────────────────────────
  credentials: {
    list(cwd: string): Promise<MaskedCredentialView[]>;
    save(cwd: string, scope: "user" | "project", cred: CredentialView): Promise<void>;
    remove(cwd: string, scope: "user" | "project", id: string): Promise<void>;
    /** 只改元数据(label/autoUseByAI/meta),保留 secret —— 编辑/AI 开关用。 */
    patchMeta(
      cwd: string,
      scope: "user" | "project",
      id: string,
      fields: {
        label?: string;
        exposeAsEnv?: string;
        autoUseByAI?: boolean;
        autoInjectByAI?: boolean;
        meta?: {
          appUrl?: string;
          platform?: string;
          domain?: string;
          scope?: "domain" | "all";
          switchMode?: "clear" | "merge";
        };
      },
    ): Promise<void>;
    cookieDomains(bucket?: string): Promise<string[]>;
    cookiePreview(domain: string, bucket?: string): Promise<{ count: number }>;
    /** 按域拓取 cookie jar(组装成 cookie 凭证存库用)。 */
    captureCookieJar(domain: string, bucket?: string): Promise<{ jar: unknown[]; count: number }>;
    /** 全量拓取当前 chat session 浏览器分区所有 cookie(按域抓不全的站用)。 */
    captureAllCookies(bucket?: string): Promise<{ jar: unknown[]; count: number }>;
    /** 全量拓取所有当前活着的内置浏览器面板 session,去重合并。 */
    captureAllCookiesAllSessions(): Promise<{ jar: unknown[]; count: number }>;
    /** 切换账号:把某 cookie 凭证导回浏览器覆盖当前登录态。 */
    restoreCookieToBrowser(cwd: string, id: string, bucket?: string): Promise<{ count: number }>;
    /** 独立窗口登录抓 cookie(登 Google/YouTube 用)。fullCapture=全量模式。 */
    loginCapture(req: { url: string; platform?: string; fullCapture?: boolean }): Promise<
      | {
          ok: true;
          jar: unknown[];
          domain: string;
          suggestedLabel?: string;
          loginCheck: { ok: boolean; missing?: string[] };
        }
      | { ok: false; cancelled?: boolean; error?: string }
    >;
  };

  // ── Browser popout window ─────────────────────────────────────────────
  /** Probe common localhost dev-server ports via real TCP connect in main;
   *  returns the open ports (ascending). */
  probeLocalhostPorts(ports?: number[]): Promise<number[]>;
  /** Open the standalone browser window, optionally at an initial URL. */
  openBrowserPopout(initialUrl?: string): Promise<void>;
  /** From a popout: send an element-pick anchor back to the parent window. */
  sendBrowserAnchor(anchor: unknown): void;
  /** In the parent: receive anchors forwarded from a popout. Returns unsubscribe. */
  onBrowserAnchorFromPopout(cb: (anchor: unknown) => void): () => void;
  // ── Browser-anchor hub(圈选统一:状态下行、操作上行)──────────────────
  /** Main window → hub: push the active session's browser anchors on change. */
  syncBrowserAnchors(anchors: unknown[]): void;
  /** Popout: subscribe to the broadcast anchor state. Returns unsubscribe. */
  onBrowserAnchorsState(cb: (anchors: unknown[]) => void): () => void;
  /** A page link wanted a new window; main routes it here to open as a new tab. */
  onBrowserOpenTab(cb: (payload: { url: string }) => void): () => void;
  /** Cookie 账号切换后,main 广播此事件让浏览器面板重载当前 tab。 */
  onBrowserReload(cb: () => void): () => void;
  /** From a popout: ask the owner (main window) to remove an anchor by id. */
  sendBrowserAnchorRemove(anchorId: string): void;
  /** From a popout: ask the owner to update an anchor's comment. */
  sendBrowserAnchorUpdate(update: { id: string; comment: string }): void;
  /** In the parent: receive a popout's update request. Returns unsubscribe. */
  onBrowserAnchorUpdateFromPopout(cb: (update: unknown) => void): () => void;
  /** In the parent: receive a popout's remove request. Returns unsubscribe. */
  onBrowserAnchorRemoveFromPopout(cb: (anchorId: unknown) => void): () => void;

  openExternal(url: string): Promise<void>;
  revealInFinder(path: string, cwd?: string): Promise<void>;
  /**
   * Open a file with the system default app. Relative paths resolve
   * against `cwd` (defaults to the worker cwd if omitted). A trailing
   * `:line[:col]` suffix is tolerated and stripped before opening.
   * Returns the resolved absolute path; throws if Electron rejects
   * the open (uncommon — usually the file just doesn't exist, in
   * which case we reveal the parent in Finder instead).
   */
  openPath(path: string, cwd?: string): Promise<string>;
  /**
   * Open a path in an external editor (Cursor / VS Code by default; override
   * with the `CODE_SHELL_EDITOR` env var). A trailing `:line[:col]` suffix is
   * honored via the editor's `--goto` flag. Returns the editor command that
   * launched; rejects if no editor is found on PATH (caller falls back to the
   * OS "open").
   */
  openInEditor(path: string, cwd?: string): Promise<string>;
  /**
   * Read an image file (absolute path) as a base64 `data:` URL so the
   * renderer can display it without `file://` (blocked by webSecurity/CSP).
   * Returns null if the path isn't an absolute image file or read fails.
   */
  readImageDataUrl(absPath: string): Promise<string | null>;
  /**
   * Save an image (`data:` URL) to a user-chosen location via a native save
   * dialog. Used by the Lightbox / attachment "download" action. Returns the
   * saved absolute path, or null if the user cancelled.
   */
  saveImage(src: string, opts?: { name?: string; mime?: string }): Promise<string | null>;
  /**
   * Revert working-tree edits to the given relative paths. Tracked
   * files are restored from HEAD; untracked files are deleted from
   * disk. Returns a per-path result so the UI can show partial
   * failures rather than aborting the batch.
   */
  undoFiles(cwd: string, paths: string[]): Promise<UndoFilesResult[]>;
  /**
   * Turn-level undo/redo via core FileHistory snapshots (keyed by engine
   * sessionId, not cwd). Always acts on the latest turn internally. Used by the
   * latest Files-Changed card: undo reverts the turn's edits to pre-turn state
   * (and deletes files it created); redo re-applies them.
   */
  turnUndoState(sessionId: string): Promise<TurnUndoState>;
  undoTurn(sessionId: string): Promise<TurnUndoResult[]>;
  redoTurn(sessionId: string): Promise<TurnUndoResult[]>;
  /**
   * List memory entries. `cwd` is required for level="project".
   * level="user" returns entries from ~/.code-shell/memory/<scope>;
   * level="project" scopes under the given cwd's project memory dir.
   */
  listMemory(level: MemoryLevel, scope: MemoryScope, cwd?: string): Promise<RendererMemoryEntry[]>;
  /** Read one memory entry's full content. Returns null if not found. */
  readMemory(
    level: MemoryLevel,
    scope: MemoryScope,
    name: string,
    cwd?: string,
  ): Promise<RendererMemoryEntryFull | null>;
  /** Create or overwrite a memory entry. Returns the file slug. */
  saveMemory(input: SaveMemoryInput): Promise<string>;
  /** Soft-delete a memory entry. Returns true on success, false if missing. */
  deleteMemory(
    level: MemoryLevel,
    scope: MemoryScope,
    name: string,
    cwd?: string,
  ): Promise<boolean>;
  /** 审批门: list global memories auto-extracted as "global" awaiting approval
   *  (full content included so the panel shows it inline). */
  listPendingMemory(): Promise<RendererMemoryEntryFull[]>;
  /** Approve a pending memory → moves it into the global dream store (injected).
   *  Returns the new filename, or null if not found. */
  approvePendingMemory(name: string): Promise<string | null>;
  /** Demote a pending memory → falls back to its source project's user store
   *  (not promoted to global, but kept). Returns the new filename or null. */
  demotePendingMemory(name: string): Promise<string | null>;
  /** Reject a pending memory → mark source rejected, then soft-delete pending. */
  rejectPendingMemory(name: string): Promise<boolean>;
  /** Promote a project-level user memory to the global user store (manual ↑).
   *  Returns the new global filename, or null if not found. */
  promoteMemoryToGlobal(cwd: string, name: string): Promise<string | null>;
  /**
   * Run one manual dream consolidation pass over the `dream` scope at the
   * given level (project requires cwd). Runs an LLM in the main process; the
   * promise resolves when consolidation finishes. `summary` is the LLM's
   * one-paragraph description of what it changed.
   */
  runDream(level: MemoryLevel, cwd?: string): Promise<{ ran: boolean; summary: string }>;

  // Phase 5 — settings / sessions / logs.
  /**
   * Authoritative no-repo conversation cwd (~/.code-shell/no-repo) resolved by
   * main. The renderer is a thin client and must use this rather than
   * recomputing homedir(), so the cwd it writes capabilityOverrides to matches
   * the worker's runtime cwd byte-for-byte.
   */
  noRepoCwd(): Promise<string>;
  getSettings(scope: "user" | "project", cwd?: string): Promise<Record<string, unknown> | null>;
  updateSettings(
    scope: "user" | "project",
    patch: Record<string, unknown>,
    cwd?: string,
  ): Promise<void>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listSessionTitles(): Promise<Record<string, string>>;
  renameSession(id: string, title: string): Promise<void>;
  tailLog(bucket: "ui-ink" | "engine" | "desktop", lines?: number): Promise<string[]>;
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail | null>;
  getSessionTranscript(sessionId: string): Promise<FoldItem[]>;
  listDiskSessions(opts?: { limit?: number; cursor?: string }): Promise<{
    sessions: Array<{
      id: string;
      engineSessionId: string;
      cwd: string;
      title: string;
      updatedAt: number;
      origin: "desktop" | "automation";
    }>;
    nextCursor: string | null;
  }>;
  subscribeSession(sessionId: string, sinceSeq?: number): Promise<SessionSnapshot>;
  getSessionRawEvents(sessionId: string, sinceId?: string): Promise<RawTranscriptEvent[]>;
  deleteRun(runId: string): Promise<void>;
  listAutomations(): Promise<AutomationSummary[]>;
  getAutomation(id: string): Promise<AutomationSummary | null>;
  createAutomation(input: CreateAutomationInput): Promise<AutomationSummary>;
  updateAutomation(id: string, patch: UpdateAutomationInput): Promise<AutomationSummary | null>;
  deleteAutomation(id: string): Promise<boolean>;
  pauseAutomation(id: string): Promise<boolean>;
  resumeAutomation(id: string): Promise<boolean>;
  runAutomationNow(id: string): Promise<boolean>;
  /** Abort the in-flight run of cron job `id`, if any. Returns false when no
   *  run is in flight. Used by session delete to stop a still-running run. */
  cancelAutomationRun(id: string): Promise<boolean>;
  listSkills(cwd: string, opts?: { includeDisabled?: boolean }): Promise<SkillSummary[]>;
  listPlugins(cwd: string): Promise<PluginSummary[]>;
  /** Full content inventory for one installed plugin (详情页). */
  getPluginDetail(installKey: string): Promise<PluginDetail | null>;
  /**
   * Unified capability view (builtin tools + MCP servers + skills + plugins)
   * via the core CapabilityService. Never throws — returns [] on error.
   */
  listCapabilities(cwd: string): Promise<CapabilityDescriptor[]>;
  /**
   * Toggle one capability on/off. scope:"user" (default) routes to the global
   * settings key; scope:"project" writes a tri-state capabilityOverrides entry
   * for `cwd` (on/off only — use setCapabilityOverride for "inherit").
   */
  setCapabilityEnabled(
    cwd: string,
    id: string,
    on: boolean,
    opts?: { scope?: "user" | "project" },
  ): Promise<void>;
  /**
   * Write a project tri-state override (继承/开/关). "inherit" deletes the
   * override key so the capability falls back to the global baseline.
   */
  setCapabilityOverride(cwd: string, id: string, state: "inherit" | "on" | "off"): Promise<void>;
  /** Force context compaction for a live engine session. */
  compactSession(
    sessionId: string,
  ): Promise<{ type: "compact"; data: { before: number; after: number; strategy: string } }>;
  uninstallPlugin(
    pluginName: string,
    marketplaceName: string,
  ): Promise<{ ok: boolean; removedFromManifest: boolean; removedFromDisk: boolean }>;
  /** Uninstall a local / direct-GitHub plugin (no marketplace) by bare name. */
  uninstallLocalPlugin(name: string): Promise<void>;
  /** Re-install a plugin from its recorded source (manual update). Atomic in core. */
  updatePlugin(name: string): Promise<{ updated: boolean; reason: string }>;
  /** Check if a remote plugin has a newer commit upstream (network; never throws). */
  checkPluginUpdate(name: string): Promise<{
    name: string;
    updateAvailable: boolean;
    currentCommit?: string;
    latestCommit?: string;
    reason?: string;
  }>;
  /**
   * Is a usable git binary available (on PATH, or the configured `git.path`)?
   * Marketplace install needs git; the UI uses this to prompt up front.
   */
  checkGit(): Promise<{ available: boolean; path?: string; installUrl?: string; message?: string }>;
  /**
   * Voice input (听写): transcribe recorded audio → text. Resolves the
   * configured (or OpenAI-fallback) STT provider in main. `error:"no-audio-provider"`
   * when none is configured.
   */
  transcribeAudio(payload: {
    cwd: string;
    audio: ArrayBuffer;
    mimeType?: string;
    provider?: string;
    language?: string;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Whether a transcription provider is resolvable (drives mic-button enablement). */
  sttAvailable(cwd: string): Promise<{ available: boolean }>;
  /** What voice input will actually use now (configured / fallback / none),
   *  key masked. Lets the UI show the active or fallback transcribe config. */
  sttDescribe(cwd: string): Promise<{
    source: "connection" | "fallback" | "none";
    model?: string;
    baseUrl?: string;
    maskedKey?: string;
    reusedCredentialId?: string;
    reusedCredentialCatalogId?: string;
  }>;
  /** Ensure OS-level microphone access (macOS TCC prompt). True on other OSes. */
  ensureMicAccess(): Promise<{ granted: boolean }>;
  /** List known plugin marketplaces (never throws — returns [] on read error). */
  listMarketplaces(): Promise<
    Array<{
      name: string;
      source: MarketplaceSource;
      installLocation: string;
      lastUpdated: string;
      pluginCount: number;
      format: MarketplaceFormat;
    }>
  >;
  /** Load one marketplace's manifest (flattened owner/author). Null if missing. */
  loadMarketplace(name: string): Promise<{
    name: string;
    description?: string;
    owner?: string;
    plugins: Array<{
      name: string;
      description?: string;
      author?: string;
      category?: string;
      homepage?: string;
      /** Declared in the manifest when present — often absent (CC has no version convention). */
      version?: string;
    }>;
  } | null>;
  /** Load the curated/recommended marketplace list (remote → cache → builtin fallback). */
  listRecommendedMarketplaces(): Promise<RecommendedMarketplaceList>;
  /** Parse a github repo / git url string and add it as a marketplace. */
  addMarketplace(input: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  /** Add one marketplace by id/name from the recommended list. */
  addRecommendedMarketplace(id: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  /** Remove a marketplace by name. Returns true if it existed. */
  removeMarketplace(name: string): Promise<boolean>;
  /** Re-pull a known marketplace from its source (git fetch + reset). */
  refreshMarketplace(name: string): Promise<{ ok: boolean; error?: string }>;
  /** Current marketplace plugin install jobs, including queued/running/failed items. */
  listPluginInstallJobs(): Promise<PluginInstallJob[]>;
  /** Subscribe to install-job changes emitted by main. */
  onPluginInstallJobsChanged(cb: (jobs: PluginInstallJob[]) => void): () => void;
  /** Install a plugin from a marketplace. */
  installPlugin(
    pluginName: string,
    marketplaceName: string,
  ): Promise<{ ok: boolean; job?: PluginInstallJob; error?: string }>;
  /** Retry a failed marketplace plugin install job. */
  retryPluginInstallJob(
    id: string,
  ): Promise<{ ok: boolean; job?: PluginInstallJob; error?: string }>;
  /** Open a native picker for a local plugin source (a directory or a .zip). */
  pickPluginSource(
    kind: "dir" | "zip",
  ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null>;
  /**
   * Install a plugin from a local directory or .zip (global scope). On a
   * same-name collision, resolves to { ok:false, alreadyInstalled:true, name }
   * carrying the AUTHORITATIVE plugin name (from the manifest) — the UI confirms
   * an overwrite and retries with `overwrite: true`.
   */
  installLocalPlugin(input: {
    kind: "dir" | "zip";
    path: string;
    overwrite?: boolean;
  }): Promise<
    | { ok: true; name: string }
    | { ok: false; alreadyInstalled: true; name: string }
    | { ok: false; error?: string }
  >;
  /** Fuzzy file search rooted at `cwd` for the @-mention popover. */
  searchFiles(cwd: string, query: string): Promise<FileSearchHit[]>;
  readSkillBody(filePath: string): Promise<string>;
  installLocalSkill(
    sourceDir: string,
    scope: "user" | "project",
    cwd?: string,
    name?: string,
  ): Promise<InstalledSkill>;
  uninstallSkill(filePath: string, source: "user" | "project" | "plugin"): Promise<void>;
  /**
   * Check if a GitHub-sourced skill has a newer commit upstream (network;
   * never throws). Locally-installed skills resolve to updateAvailable:false.
   */
  checkSkillUpdate(filePath: string): Promise<{
    filePath: string;
    updateAvailable: boolean;
    currentCommit?: string;
    latestCommit?: string;
    reason?: string;
  }>;
  /**
   * One-click re-download + atomic replace of a GitHub-sourced skill (the
   * manual "update" button). Rejects on failure (UI alerts); a failed update
   * keeps the old version on disk.
   */
  updateSkill(filePath: string): Promise<{ updated: boolean; reason: string }>;
  listAgents(cwd: string): Promise<AgentSummary[]>;
  readAgentBody(filePath: string): Promise<string>;
  saveAgent(
    def: AgentDefinitionInput,
    opts?: { scope?: "user" | "project"; cwd?: string },
  ): Promise<AgentSummary>;
  deleteAgent(name: string, opts?: { scope?: "user" | "project"; cwd?: string }): Promise<void>;
  inspectGithubSkill(url: string, existingNames?: string[]): Promise<GithubRepoInspection>;
  installFromGithub(input: GithubSkillInstallInput): Promise<InstalledSkill>;
  probeMcpServers(configs: McpServerProbeInput[], force?: boolean): Promise<McpProbeResult[]>;
  listMergedMcpServers(
    base: Record<string, unknown>,
    disabledPlugins?: string[],
    /** When set, main folds project capabilityOverrides for THIS cwd over the
     *  global list — pluginDisabled then reflects the effective state. */
    cwd?: string,
  ): Promise<
    Record<string, McpServerProbeInput & { source?: "settings" | "plugin"; editable?: boolean }>
  >;
  /** Read-only list of plugin-provided hooks (for the settings 钩子 page). */
  listPluginHooks(disabledPlugins?: string[]): Promise<PluginHookEntry[]>;
  invalidateMcpProbeCache(name?: string): Promise<void>;
  probeSearch(input: SearchProbeInput): Promise<SearchProbeResult>;
  probeImage(input: ImageProbeInput): Promise<ImageProbeResult>;
  getModelCatalog(): Promise<CatalogEntry[]>;
  saveCatalogEntry: (
    entry: unknown,
  ) => Promise<{ ok: boolean; action?: "added" | "updated"; error?: string; backup?: string }>;
  deleteCatalogEntry: (
    id: string,
  ) => Promise<{ ok: boolean; removed: boolean; error?: string; backup?: string }>;
  getCatalogOrigins: () => Promise<Record<string, "builtin" | "user" | "user-override-of-builtin">>;
  resolveModelMeta(
    models: Array<{
      key: string;
      model?: string;
      providerKey?: string;
      maxContextTokens?: number | null;
    }>,
    providers: Array<{ key?: string; kind?: string; baseUrl?: string; apiKey?: string }>,
  ): Promise<
    Array<{
      key: string;
      maxContextTokens: number;
      maxCompletionTokens?: number;
      source: "settings" | "openrouter-api" | "hardcoded" | "fallback";
      supportsVision: boolean;
    }>
  >;
  /**
   * Describe which reasoning/thinking control a (provider kind, model) pair
   * should render. Pure core lookup (reasoningControlFor) bridged via main —
   * the renderer never imports core at runtime.
   */
  reasoningControl(kind: string, model: string): Promise<ReasoningControl>;
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
  getTrustRisks(path: string): Promise<{
    permissionRules: number;
    envKeys: string[];
    hooks: number;
    mcpServers: string[];
    setupScripts: boolean;
  }>;
  recents(): Promise<{ path: string; name: string; lastOpenedAt: number }[]>;
  projects: {
    list(): Promise<Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>>;
    resolveRoot(path: string): Promise<{ path: string; name: string }>;
    add(project: { path: string; name: string }): Promise<void>;
    remove(projectPath: string): Promise<void>;
    setPinned(projectPath: string, pinned: boolean): Promise<void>;
    onChanged(
      cb: (
        projects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
      ) => void,
    ): () => void;
  };
  notify(opts: { title: string; body?: string; subtitle?: string }): Promise<void>;
  isWindowFullscreen(): Promise<boolean>;
  onWindowFullscreenChange(cb: (state: { fullscreen: boolean }) => void): Unsubscribe;
  setBadgeCount(count: number): Promise<void>;
  onMenuEvent(cb: (event: string, payload?: unknown) => void): Unsubscribe;
  newWindow(): Promise<void>;
  /** The running app version (from Electron `app.getVersion()`). */
  getAppVersion(): Promise<string>;
  checkForUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getUpdaterStatus(): Promise<UpdaterStatus>;
  onUpdaterStatus(cb: (status: UpdaterStatus) => void): Unsubscribe;

  /**
   * Mobile Web Remote — Electron-hosted LAN HTTP/WebSocket controller for a
   * trusted phone. Off by default; `start` binds to localhost/LAN and returns
   * a one-time pairing URL. No public relay (see mobile-remote design spec).
   */
  mobileRemote: {
    start(opts?: { mode?: "lan" | "tunnel" }): Promise<{
      url: string;
      pairingUrl: string;
      expiresAt: number;
      mode: "lan" | "tunnel";
    }>;
    stop(): Promise<void>;
    pairingUrl(): Promise<{ pairingUrl: string; expiresAt: number }>;
    status(): Promise<{
      running: boolean;
      url?: string;
      mode?: "lan" | "tunnel";
      tunnelRunning?: boolean;
      tunnelConnected?: boolean;
    }>;
    listDevices(): Promise<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        lastSeenAt?: number;
        revokedAt?: number;
      }>
    >;
    revokeDevice(id: string): Promise<boolean>;
    removeDevice(id: string): Promise<boolean>;
    renameDevice(id: string, name: string): Promise<boolean>;
    onlineDevices(): Promise<string[]>;
    onOnlineChange(cb: (ids: string[]) => void): Unsubscribe;
    // ── Public tunnel mode ──
    cloudflaredInstalled(): Promise<boolean>;
    downloadCloudflared(): Promise<boolean>;
    onDownloadProgress(cb: (pct: number) => void): Unsubscribe;
    passcodeStatus(): Promise<{ isSet: boolean }>;
    setPasscode(passcode: string): Promise<boolean>;
    tunnelStatus(): Promise<{ running: boolean; connected: boolean }>;
    onTunnelStatus(cb: (s: { status: string; detail?: unknown }) => void): Unsubscribe;
    updateProjects(projects: MobileProjectMeta[]): Promise<boolean>;
    updatePermissionModes(entries: MobilePermissionModeSnapshotEntry[]): Promise<boolean>;
    notifyApprovalResolved(input: ApprovalResolvedEnvelope): Promise<boolean>;
  };

  /**
   * Rooms — resident Claude Code (stream-json) sessions, dual-ended with the
   * phone: desktop and phone drive the SAME RoomManager / process /
   * messages.jsonl, so context is shared.
   */
  rooms: {
    list(): Promise<RoomPublic[]>;
    projects(): Promise<MobileProjectMeta[]>;
    create(input: {
      name?: string;
      cwd: string;
      kind?: "claude-code" | "codex";
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    }): Promise<RoomPublic>;
    open(roomId: string): Promise<{ status: "running" | "missing" }>;
    close(roomId: string): Promise<void>;
    send(roomId: string, text: string): Promise<boolean>;
    history(roomId: string, sinceSeq?: number): Promise<RoomMessageWire[]>;
    onMessage(cb: (env: { roomId: string; msg: RoomMessageWire }) => void): Unsubscribe;
  };

  /**
   * CC rooms — orchestration of the external `claude` CLI (probe availability,
   * discover its on-disk sessions, list/delete CC-backed scheduled tasks).
   */
  ccRoom: {
    probe(force?: boolean): Promise<CCAvailability>;
    codexProbe(force?: boolean): Promise<CCAvailability>;
    /** Bounded by default (recent 2 weeks AND ≤20); pass all=true to fetch every
     *  session (the "load more" path). `total` is the full unbounded count. */
    listSessions(
      cwd: string,
      all?: boolean,
    ): Promise<{ sessions: DiscoveredSession[]; total: number }>;
    listCodexSessions(
      cwd: string,
      all?: boolean,
    ): Promise<{ sessions: DiscoveredSession[]; total: number }>;
    openSession(
      claudeSessionId: string,
      cwd: string,
      mode: string,
      kind?: "claude-code" | "codex",
    ): Promise<{ roomId: string }>;
    send(roomId: string, text: string): Promise<boolean>;
    respondApproval(roomId: string, requestId: string, decision: unknown): Promise<boolean>;
    roomHistory(roomId: string, sinceSeq?: number): Promise<unknown[]>;
    readHistory(
      cwd: string,
      sessionId: string,
      limit: number,
    ): Promise<{
      messages: {
        role: "user" | "assistant";
        text: string;
        tools?: { name: string; summary: string; args?: Record<string, unknown> }[];
      }[];
      hasMore: boolean;
      totalCount: number;
    }>;
    readCodexHistory(
      cwd: string,
      threadId: string,
      limit: number,
    ): Promise<{
      messages: {
        role: "user" | "assistant";
        text: string;
        tools?: { name: string; summary: string; args?: Record<string, unknown> }[];
      }[];
      hasMore: boolean;
      totalCount: number;
    }>;
    closeSession(roomId: string): Promise<void>;
    onRoomMessage(cb: (env: { roomId: string; msg: unknown }) => void): () => void;
    onApprovalRequest(
      cb: (req: {
        roomId: string;
        requestId: string;
        toolName: string;
        displayName?: string;
        input: unknown;
        description?: string;
        /** AskUserQuestion only: parsed prompt + option labels for a choice card. */
        askUser?: { question: string; header?: string; options: string[]; multiSelect: boolean };
      }) => void,
    ): () => void;
    onApprovalResolved(
      cb: (p: { roomId: string; requestId: string; decision: unknown }) => void,
    ): () => void;
  };

  /** Remaining CC/Codex subscription quota. "codex" is free; "claude" costs ~1 token. */
  quota: {
    get(provider?: "claude" | "codex" | "both"): Promise<QuotaResult>;
  };
}

export interface MobileProjectMeta {
  path: string;
  name: string;
  addedAt?: number;
  pinned?: boolean;
}

export interface RoomPublic {
  id: string;
  name: string;
  cwd: string;
  kind: "claude-code" | "codex";
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  createdAt: number;
  lastActiveAt: number;
  open: boolean;
}

export interface RoomMessageWire {
  seq: number;
  ts: number;
  from: "user" | "agent" | "system";
  type: string;
  text?: string;
  tool?: string;
  summary?: string;
  reason?: string;
  isError?: boolean;
  /** claude tool_use id (toolu_…) — pairs a tool_result to its start so the UI
   *  seals the right card even when tools run in parallel. */
  toolId?: string;
  /** Full structured tool_use input (e.g. a sub-agent's `prompt`) on `tool`
   *  messages — what the tool card expands to. Absent on legacy messages. */
  args?: Record<string, unknown>;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | {
      kind: "manual-required";
      version: string;
      url: string;
      message: string;
      reason: "mac-signature" | "mac-readonly-volume";
    }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "installing"; version: string }
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

export interface ImageProbeInput {
  /** Adapter selector — "openai" | "google" | … */
  kind: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** How a param lands on the request body (mirror of core WireSpec). */
export interface WireSpec {
  field: string;
}

/** One generic declarative param (mirror of core ParamSpec). */
export interface ParamSpec {
  name: string;
  label?: string;
  control: "enum" | "number" | "toggle" | "text";
  options?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  doc?: string;
  wire?: WireSpec;
}

/** A known model under an entry (mirror of core ModelPreset). */
export interface ModelPreset {
  value: string;
  label?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  params?: ParamSpec[];
}

/** Model catalog template (mirror of core CatalogEntry). */
export interface CatalogEntry {
  id: string;
  tag: "text" | "image" | "video" | "audio";
  adapterKind: string;
  protocol?: "openai-compat" | "anthropic-style";
  shape?: "generic-sync" | "fal-queue";
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel?: string;
  needsKey?: boolean;
  modelPresets?: ModelPreset[];
  signupUrl?: string;
  test?: boolean;
  paramsDoc?: string;
}

export interface ImageProbeResult {
  status: "ok" | "error" | "unconfigured";
  /** data:image/png;base64,… preview of the generated probe image when ok. */
  previewDataUrl?: string;
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
  /** (stdio) NAMES of env vars forwarded from the parent process. */
  envVars?: string[];
  /** (HTTP) NAME of an env var sent as `Authorization: Bearer <value>`. */
  bearerTokenEnvVar?: string;
  /** (HTTP) header-name → env-var-NAME map, values read at connect time. */
  envHeaders?: Record<string, string>;
  /** (HTTP) id of a stored credential used as the Bearer token. */
  credentialRef?: string;
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

export interface FileSearchHit {
  /** Path relative to cwd, forward-slash separated. */
  path: string;
  /** Basename of the file. */
  name: string;
}

export interface AgentSummary {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
  source: "project" | "user" | "plugin";
  override: boolean;
  /** Sources this def shadows (e.g. ["user"] when a project agent wins). */
  shadowedSources?: Array<"project" | "user" | "plugin">;
  filePath: string;
}

export interface AgentDefinitionInput {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
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

/** Full inventory for the plugin detail view (plugins:detail). */
export interface PluginDetail extends PluginSummary {
  content: {
    skills: { name: string; description?: string }[];
    commands: string[];
    agents: string[];
    hooks: PluginHookEntry[];
    mcpServers: string[];
  };
}

export type AutomationPermissionLevel = "read-only" | "workspace-write" | "full";

export interface AutomationSummary {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  cwd: string | null;
  timezone: string | null;
  permissionLevel: AutomationPermissionLevel | null;
  lastRun: number | null;
  nextRun: number | null;
  runCount: number;
  createdAt: number;
  lastRunId: string | null;
  once: boolean;
  resumeSessionId: string | null;
}

export interface CreateAutomationInput {
  name: string;
  schedule: string;
  prompt: string;
  cwd?: string;
  timezone?: string;
  permissionLevel?: AutomationPermissionLevel;
}

export interface UpdateAutomationInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  cwd?: string;
  permissionLevel?: AutomationPermissionLevel;
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
  source?: string;
  cronJobName?: string;
}

export interface RunDetail extends RunSummary {
  attemptCount: number;
  latestCheckpointId: string | null;
  latestApprovalId: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  events: Array<{
    eventId: string;
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
  }>;
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
