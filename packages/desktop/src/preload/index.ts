/**
 * Preload — bridges the renderer (browser context) to Electron main's
 * ipcMain via contextBridge. The renderer never imports core; it sees
 * only the typed `window.codeshell` surface defined here.
 *
 * Wire format on the IPC channel "agent:msg" is the full JSON-RPC
 * line (string) we relay verbatim to/from the agent worker's stdio.
 * That keeps the preload a true transparent transport — no protocol
 * interpretation in main, only in here (to fan out to listeners).
 *
 * Multi-session note: `agent/streamEvent` and `agent/approvalRequest`
 * notifications carry `sessionId` on their params; we forward that to
 * listeners as `{ sessionId, event }` / `{ sessionId, requestId, request }`
 * envelopes so the renderer can route by session bucket. `run`, `cancel`,
 * `approve`, and `closeSession` all take a sessionId so the worker can
 * dispatch via ChatSessionManager.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** One background shell as surfaced to the dock panel (TODO 3.2). Mirrors core
 *  BgShell's public shape; renderer-local since the renderer can't import core. */
export interface BackgroundShellInfo {
  shellId: string;
  sessionId: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed";
  startedAt: number;
  exitedAt?: number;
  exitCode: number | null;
  signal: string | null;
  detectedPort?: number;
}

let nextRpcId = 1;
const pending = new Map<number, { resolve: (resp: unknown) => void; reject: (err: Error) => void }>();
// Multi-session: callbacks receive `{ sessionId, event }` for stream events
// and `{ sessionId, requestId, request }` for approval requests.
const streamListeners: Array<(env: { sessionId: string; event: unknown }) => void> = [];
const approvalListeners: Array<(env: unknown) => void> = [];
const statusListeners: Array<(evt: unknown) => void> = [];
const lifecycleListeners: Array<(evt: unknown) => void> = [];
// Live automation session announcements: `{ sessionId, cwd, title }`, fired
// once when an in-main automation Engine emits session_started.
const automationSessionListeners: Array<
  (meta: { sessionId: string; cwd: string; title: string; prompt: string; cronJobId: string }) => void
> = [];

// Browser automation may need to OPEN the panel before it can drive it (the
// agent asked to use the browser but no panel/tab is open yet). Main sends
// `browser:open-url`; we re-dispatch the renderer's existing `codeshell:open-url`
// window event, which opens the dock + browser panel and navigates to the URL —
// the same path a clicked chat link uses. did-attach-webview then registers the
// guest so the automation host has a target.
ipcRenderer.on("browser:open-url", (_e: IpcRendererEvent, payload: { url?: string }) => {
  window.dispatchEvent(new CustomEvent("codeshell:open-url", { detail: { url: payload?.url } }));
});

ipcRenderer.on("agent:msg", (_e: IpcRendererEvent, line: string) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // malformed — skip
  }
  // Response: has id, no method
  if ("id" in msg && !("method" in msg)) {
    // `pending` is keyed by the numeric ids we send. Coerce a string id (some
    // JSON-RPC peers echo ids as strings) to number so the lookup matches
    // instead of silently dropping the response.
    const rawId = (msg as { id: unknown }).id;
    const id = typeof rawId === "string" ? Number(rawId) : (rawId as number);
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve(msg);
    }
    return;
  }
  // Notification: has method
  const method = msg.method as string | undefined;
  const params = msg.params as Record<string, unknown> | undefined;
  if (method === "agent/streamEvent") {
    // Multi-session wire format: `{ sessionId, event }` envelope. The
    // renderer routes by sessionId; legacy callers can ignore it.
    const sessionId = (params?.sessionId as string | undefined) ?? "";
    const event = params?.event;
    streamListeners.forEach((cb) => cb({ sessionId, event }));
  } else if (method === "agent/automationSession") {
    const sessionId = (params?.sessionId as string | undefined) ?? "";
    const cwd = (params?.cwd as string | undefined) ?? "";
    const title = (params?.title as string | undefined) ?? "";
    const prompt = (params?.prompt as string | undefined) ?? "";
    const cronJobId = (params?.cronJobId as string | undefined) ?? "";
    if (sessionId) {
      automationSessionListeners.forEach((cb) => cb({ sessionId, cwd, title, prompt, cronJobId }));
    }
  } else if (method === "agent/approvalRequest") {
    // `{ sessionId, requestId, request }` envelope. requestId lets the
    // renderer echo the decision back via approve(sessionId, requestId, ...).
    approvalListeners.forEach((cb) => cb(params));
  } else if (method === "agent/status") {
    statusListeners.forEach((cb) => cb(params));
  }
});

ipcRenderer.on("agent:lifecycle", (_e: IpcRendererEvent, evt: unknown) => {
  // Worker death is the fallback that used to be covered by the per-RPC
  // timeout. Now that agent/run runs untimed, a crashed/exited worker would
  // otherwise leave its pending Promise hanging forever (busy never clears).
  // Reject every in-flight RPC when the child goes away. On a clean exit the
  // run has already resolved, so `pending` is empty and this is a no-op.
  const type = (evt as { type?: string } | null)?.type;
  if (type === "exited" || type === "gave_up") {
    if (pending.size > 0) {
      const err = new Error(`worker ${type} before replying`);
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(err);
      }
    }
  }
  lifecycleListeners.forEach((cb) => cb(evt));
});

const RPC_TIMEOUT_MS = 30_000;

/**
 * Unwrap a JSON-RPC reply: `rpc()` resolves with the whole `{id, result|error}`
 * envelope, so data-returning callers must reach into `.result` (and surface
 * `.error`). Older bindings that ignore the payload can skip this.
 */
function rpcResult<T = unknown>(msg: unknown): T {
  const m = (msg ?? {}) as { result?: unknown; error?: { message?: string } };
  if (m.error) throw new Error(m.error.message ?? "RPC error");
  return m.result as T;
}

/**
 * Send a JSON-RPC request to main and resolve with its reply.
 *
 * `timeoutMs` guards against main never replying so the caller doesn't hang
 * and the resolver doesn't leak in `pending`. Pass `0` to DISABLE the timeout
 * for long-running requests: `agent/run` only resolves when the whole turn
 * finishes (minutes, with Playwright / image-gen / multi-turn tool loops), and
 * its responses stream in via agent:lifecycle meanwhile. A fixed 30s timeout
 * there fired mid-run, rejecting a still-healthy run — App.tsx's .catch then
 * cleared busy and nulled runningBucketRef, so the eventual streamEvents and
 * final result had no bucket to land in (UI froze on the last task snapshot).
 *
 * Recovery model now: normal end / error → cleared by the streamEvent the
 * renderer already listens for (turn_complete/error, App.tsx); worker process
 * death → the exited/gave_up lifecycle handler above rejects the pending run;
 * a wedged-but-alive worker (no events, no exit) → the user's Stop button
 * (agent/cancel) clears busy. No clock can tell "slow" from "wedged", so that
 * last call is left to the human rather than guessed by a timeout.
 */
function rpc(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextRpcId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (pending.delete(id)) {
              reject(new Error(`RPC '${method}' timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;
    pending.set(id, {
      resolve: (msg) => {
        if (timer) clearTimeout(timer);
        resolve(msg);
      },
      reject: (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    });
    try {
      ipcRenderer.send("agent:msg", line);
    } catch (err) {
      if (timer) clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

contextBridge.exposeInMainWorld("codeshell", {
  /** Forward a renderer-side log line into ~/.code-shell/logs/desktop-*.log. */
  log: (msg: string, data?: Record<string, unknown>) =>
    ipcRenderer.send("desktop:log", { msg, data }),
  run: (task: string, opts?: { cwd?: string; sessionId?: string; permissionMode?: string; planMode?: boolean } & Record<string, unknown>) =>
    // No timeout: a run resolves only when the whole turn completes (can be
    // minutes). The Stop button (agent/cancel) is the abort path, not a clock.
    rpc("agent/run", { task, ...(opts ?? {}) }, 0),
  /**
   * Cancel a session's running turn. sessionId is required for the
   * multi-session worker; legacy callers that omitted it routed through
   * the (now-removed) single-flag path — multi-session always wants the id.
   */
  cancel: (sessionId?: string) => rpc("agent/cancel", { sessionId }),
  /**
   * Steer an in-flight run: queue a user message that the running turn loop
   * splices into its NEXT step — 不打断 (vs cancel, which aborts). For 引导 (gentle
   * guidance mid-run). No-op-ish if the session has no active run (message waits
   * for its next run).
   */
  steer: (sessionId: string, text: string, id?: string) =>
    rpc("agent/steer", { sessionId, text, id }),
  /**
   * Revoke a still-pending steer entry by id (撤回). Returns { removed } —
   * false means the turn loop already consumed it (can't take it back; it will
   * arrive as a user bubble). For the queue panel's per-item delete button.
   */
  unsteer: (sessionId: string, id: string) => rpc("agent/unsteer", { sessionId, id }),
  /**
   * Extend a running goal's turn / budget ceilings mid-run (TODO 3.1). Returns
   * the resulting effective limits, or throws if there's no active run.
   */
  goalExtend: (
    sessionId: string,
    opts: { addTurns?: number; addTokenBudget?: number; addTimeBudgetMs?: number; addStopBlocks?: number },
  ) =>
    rpc("agent/goalExtend", { sessionId, ...opts }).then(rpcResult) as Promise<{
      ok: boolean;
      limits: { maxTurns: number; tokenBudget?: number; timeBudgetMs?: number; maxStopBlocks: number };
    }>,
  /** Clear a session's persisted active goal (CC /goal clear). */
  goalClear: (sessionId: string) =>
    rpc("agent/goalClear", { sessionId }).then(rpcResult) as Promise<{ ok: boolean; cleared: boolean }>,
  /** Read a session's persisted active goal objective (null when none). */
  goalGet: (sessionId: string) =>
    rpc("agent/goalGet", { sessionId }).then(rpcResult) as Promise<{ ok: boolean; goal: string | null }>,
  /** List a session's background shells for the dock panel (TODO 3.2). */
  listBackgroundShells: (sessionId: string) =>
    rpc("agent/backgroundShells", { sessionId, action: "list" }).then(rpcResult) as Promise<{
      shells: BackgroundShellInfo[];
    }>,
  /** Read one background shell's full retained output. */
  backgroundShellOutput: (sessionId: string, shellId: string) =>
    rpc("agent/backgroundShells", { sessionId, action: "output", shellId }).then(rpcResult) as Promise<{
      header: string;
      text: string;
    }>,
  /** Terminate one background shell's process group. */
  killBackgroundShell: (sessionId: string, shellId: string) =>
    rpc("agent/backgroundShells", { sessionId, action: "kill", shellId }).then(rpcResult) as Promise<{
      ok: boolean;
    }>,
  approve: (
    sessionIdOrRequestId: string,
    requestIdOrDecision: string | "approve" | "deny",
    decisionOrReason?: "approve" | "deny" | string,
    reasonOrAnswer?: string,
    answer?: string,
    scopeArg?: "once" | "session" | "project",
    pathScopeArg?: "file" | "dir" | "tool",
  ) => {
    // Multi-session form: approve(sessionId, requestId, decision, reason?, answer?, scope?, pathScope?)
    // Legacy form:        approve(requestId, decision, reason?, answer?, scope?, pathScope?)
    let sessionId: string | undefined;
    let requestId: string;
    let decision: "approve" | "deny";
    let reason: string | undefined;
    let answerText: string | undefined;
    let scope: "once" | "session" | "project" | undefined;
    let pathScope: "file" | "dir" | "tool" | undefined;
    if (
      typeof requestIdOrDecision === "string" &&
      requestIdOrDecision !== "approve" &&
      requestIdOrDecision !== "deny"
    ) {
      // Multi-session: first arg is sessionId
      sessionId = sessionIdOrRequestId;
      requestId = requestIdOrDecision;
      decision = decisionOrReason as "approve" | "deny";
      reason = reasonOrAnswer;
      answerText = answer;
      scope = scopeArg;
      pathScope = pathScopeArg;
    } else {
      // Legacy: first arg is requestId; scope/pathScope ride in the slots after
      // answer (answer kept undefined by callers, so scope lands here).
      requestId = sessionIdOrRequestId;
      decision = requestIdOrDecision as "approve" | "deny";
      reason = decisionOrReason as string | undefined;
      answerText = reasonOrAnswer;
      scope = (answer as "once" | "session" | "project" | undefined) ?? scopeArg;
      pathScope = scopeArg as "file" | "dir" | "tool" | undefined ?? pathScopeArg;
    }
    // Build the approve branch of ApprovalResult. `once` (or absent) is the
    // legacy payload — no always/scope — so the default path is unchanged; the
    // core InteractiveApprovalBackend reads always+scope(+pathScope) to remember
    // the grant.
    let approveBranch: Record<string, unknown> = { approved: true };
    if (answerText !== undefined) approveBranch.answer = answerText;
    if (scope && scope !== "once") {
      approveBranch.always = true;
      approveBranch.scope = scope;
      if (pathScope && pathScope !== "tool") approveBranch.pathScope = pathScope;
    }
    return rpc("agent/approve", {
      sessionId,
      requestId,
      decision: decision === "approve" ? approveBranch : { approved: false, reason },
    });
  },
  closeSession: (sessionId: string) => rpc("agent/closeSession", { sessionId }),
  configure: (params: {
    sessionId?: string;
    model?: string;
    permissionMode?: string;
    planMode?: boolean;
    reloadModels?: boolean;
    reloadSettings?: boolean;
  }) => rpc("agent/configure", params),
  onStreamEvent: (cb: (env: { sessionId: string; event: unknown }) => void): (() => void) => {
    streamListeners.push(cb);
    return () => {
      const i = streamListeners.indexOf(cb);
      if (i >= 0) streamListeners.splice(i, 1);
    };
  },
  onAutomationSession: (
    cb: (meta: { sessionId: string; cwd: string; title: string; prompt: string; cronJobId: string }) => void,
  ): (() => void) => {
    automationSessionListeners.push(cb);
    return () => {
      const i = automationSessionListeners.indexOf(cb);
      if (i >= 0) automationSessionListeners.splice(i, 1);
    };
  },
  onApprovalRequest: (cb: (req: unknown) => void): (() => void) => {
    approvalListeners.push(cb);
    return () => {
      const i = approvalListeners.indexOf(cb);
      if (i >= 0) approvalListeners.splice(i, 1);
    };
  },
  onStatus: (cb: (evt: unknown) => void): (() => void) => {
    statusListeners.push(cb);
    return () => {
      const i = statusListeners.indexOf(cb);
      if (i >= 0) statusListeners.splice(i, 1);
    };
  },
  onAgentLifecycle: (cb: (evt: unknown) => void): (() => void) => {
    lifecycleListeners.push(cb);
    return () => {
      const i = lifecycleListeners.indexOf(cb);
      if (i >= 0) lifecycleListeners.splice(i, 1);
    };
  },
  pickDir: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke("dialog:pickDir"),
  pickSkillDir: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke("dialog:pickSkillDir"),
  pickGitBinary: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:pickGitBinary"),
  getGitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
  /** Per-file +/- line counts for the review tree (TODO 2.3a). */
  getGitNumstat: (cwd: string) =>
    ipcRenderer.invoke("git:numstat", cwd) as Promise<
      Record<string, { added: number; removed: number }>
    >,
  /** Changed files + numstat for a committed range (TODO 2.3a). */
  getGitRangeChanges: (cwd: string, range: string) =>
    ipcRenderer.invoke("git:rangeChanges", cwd, range) as Promise<{
      entries: { code: string; path: string }[];
      numstat: Record<string, { added: number; removed: number }>;
    }>,
  /** Base branch (main/master/upstream) to diff against for branch scope (TODO 2.3a). */
  getGitBranchBase: (cwd: string) =>
    ipcRenderer.invoke("git:branchBase", cwd) as Promise<string>,
  getGitBranches: (cwd: string) => ipcRenderer.invoke("git:branches", cwd),
  switchGitBranch: (cwd: string, branch: string) =>
    ipcRenderer.invoke("git:switchBranch", cwd, branch),
  stashAndSwitchGitBranch: (cwd: string, branch: string) =>
    ipcRenderer.invoke("git:stashAndSwitchBranch", cwd, branch),
  createWorktree: (cwd: string, name: string, branchPrefix?: string) =>
    ipcRenderer.invoke("git:createWorktree", cwd, name, branchPrefix),
  listWorktrees: (cwd: string) => ipcRenderer.invoke("git:listWorktrees", cwd),
  setGitPrefs: (prefs: {
    branchPrefix: string;
    autoDeleteWorktrees: boolean;
    autoDeleteWorktreesGraceMins: number;
  }) => ipcRenderer.invoke("git:setPrefs", prefs),
  getGitDiff: (cwd: string, file?: string, mode?: "unstaged" | "staged" | "all") =>
    ipcRenderer.invoke("git:diff", cwd, file, mode),
  getGitRangeDiff: (cwd: string, range: string, file?: string) =>
    ipcRenderer.invoke("git:rangeDiff", cwd, range, file),
  getGitRecentCommits: (cwd: string, limit?: number) =>
    ipcRenderer.invoke("git:recentCommits", cwd, limit),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  revealInFinder: (path: string, cwd?: string) =>
    ipcRenderer.invoke("shell:revealInFinder", path, cwd),
  openPath: (path: string, cwd?: string) =>
    ipcRenderer.invoke("shell:openPath", path, cwd),
  /** Open a path in an external editor (Cursor/VS Code; CODE_SHELL_EDITOR override). */
  openInEditor: (path: string, cwd?: string) =>
    ipcRenderer.invoke("shell:openInEditor", path, cwd) as Promise<string>,
  /** Read an image file as a base64 data: URL (null on failure). */
  readImageDataUrl: (absPath: string) =>
    ipcRenderer.invoke("images:readDataUrl", absPath),
  /**
   * Save an image (data: URL) to a user-chosen location via a save dialog.
   * Returns the saved path, or null if the user cancelled.
   */
  saveImage: (src: string, opts?: { name?: string; mime?: string }) =>
    ipcRenderer.invoke("images:save", src, opts) as Promise<string | null>,
  undoFiles: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke("files:undo", cwd, paths),
  turnUndoState: (sessionId: string) =>
    ipcRenderer.invoke("files:turnUndoState", sessionId),
  undoTurn: (sessionId: string) => ipcRenderer.invoke("files:undoTurn", sessionId),
  redoTurn: (sessionId: string) => ipcRenderer.invoke("files:redoTurn", sessionId),
  listMemory: (level: string, scope: string, cwd?: string) =>
    ipcRenderer.invoke("memory:list", level, scope, cwd),
  readMemory: (level: string, scope: string, name: string, cwd?: string) =>
    ipcRenderer.invoke("memory:read", level, scope, name, cwd),
  saveMemory: (input: Record<string, unknown>) =>
    ipcRenderer.invoke("memory:save", input),
  deleteMemory: (level: string, scope: string, name: string, cwd?: string) =>
    ipcRenderer.invoke("memory:delete", level, scope, name, cwd),
  runDream: (level: string, cwd?: string) =>
    ipcRenderer.invoke("memory:dream", level, cwd),
  /** Authoritative no-repo conversation cwd (~/.code-shell/no-repo) from main.
   *  Renderer must use this, never recompute homedir() itself. */
  noRepoCwd: (): Promise<string> => ipcRenderer.invoke("no-repo:cwd"),
  getSettings: (scope: "user" | "project", cwd?: string) =>
    ipcRenderer.invoke("settings:get", scope, cwd),
  updateSettings: (scope: "user" | "project", patch: Record<string, unknown>, cwd?: string) =>
    ipcRenderer.invoke("settings:set", scope, patch, cwd),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),
  listSessionTitles: () => ipcRenderer.invoke("sessions:titles"),
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke("sessions:rename", id, title),
  tailLog: (bucket: "ui-ink" | "engine" | "desktop", lines?: number) =>
    ipcRenderer.invoke("logs:tail", bucket, lines),
  listRuns: () => ipcRenderer.invoke("runs:list"),
  getRun: (runId: string) => ipcRenderer.invoke("runs:get", runId),
  getSessionTranscript: (sessionId: string) =>
    ipcRenderer.invoke("sessions:transcript", sessionId),
  listDiskSessions: (opts?: { limit?: number; cursor?: string }) =>
    ipcRenderer.invoke("sessions:listDisk", opts ?? {}),
  /**
   * Re-subscribe to a session's main-held event snapshot after a remount.
   * Returns events past `sinceSeq` plus the next cursor, so the renderer can
   * replay what it missed and align the snapshot with the live stream.
   */
  subscribeSession: (sessionId: string, sinceSeq?: number) =>
    ipcRenderer.invoke("agent:subscribe", sessionId, sinceSeq),
  /**
   * Long-disconnect fallback: read raw transcript events (with stable id/
   * turnNumber/timestamp) from disk, optionally only those after `sinceId`.
   * Used when the main snapshot window has evicted older events.
   */
  getSessionRawEvents: (sessionId: string, sinceId?: string) =>
    ipcRenderer.invoke("sessions:rawEvents", sessionId, sinceId),
  deleteRun: (runId: string) => ipcRenderer.invoke("runs:delete", runId),
  listAutomations: () => ipcRenderer.invoke("automation:list"),
  getAutomation: (id: string) => ipcRenderer.invoke("automation:get", id),
  createAutomation: (input: {
    name: string;
    schedule: string;
    prompt: string;
    cwd?: string;
    timezone?: string;
    permissionLevel?: string;
  }) => ipcRenderer.invoke("automation:create", input),
  updateAutomation: (
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      schedule?: string;
      timezone?: string;
      cwd?: string;
      permissionLevel?: string;
    },
  ) => ipcRenderer.invoke("automation:update", id, patch),
  deleteAutomation: (id: string) => ipcRenderer.invoke("automation:delete", id),
  pauseAutomation: (id: string) => ipcRenderer.invoke("automation:pause", id),
  resumeAutomation: (id: string) => ipcRenderer.invoke("automation:resume", id),
  runAutomationNow: (id: string) => ipcRenderer.invoke("automation:runNow", id),
  cancelAutomationRun: (id: string) => ipcRenderer.invoke("automation:cancelRun", id),
  listSkills: (cwd: string) => ipcRenderer.invoke("skills:list", cwd),
  searchFiles: (cwd: string, query: string) =>
    ipcRenderer.invoke("files:search", cwd, query),
  listPlugins: (cwd: string) => ipcRenderer.invoke("plugins:list", cwd),
  /** Full content inventory for one installed plugin (详情页). */
  getPluginDetail: (installKey: string) => ipcRenderer.invoke("plugins:detail", installKey),
  listCapabilities: (cwd: string) =>
    ipcRenderer.invoke("capabilities:list", cwd),
  setCapabilityEnabled: (
    cwd: string,
    id: string,
    on: boolean,
    opts?: { scope?: "user" | "project" },
  ) => ipcRenderer.invoke("capabilities:setEnabled", cwd, id, on, opts),
  setCapabilityOverride: (cwd: string, id: string, state: "inherit" | "on" | "off") =>
    ipcRenderer.invoke("capabilities:setOverride", cwd, id, state),
  uninstallPlugin: (pluginName: string, marketplaceName: string) =>
    ipcRenderer.invoke("plugins:uninstall", pluginName, marketplaceName),
  uninstallLocalPlugin: (name: string) =>
    ipcRenderer.invoke("plugins:uninstallLocal", name),
  updatePlugin: (name: string) => ipcRenderer.invoke("plugins:update", name),
  checkPluginUpdate: (name: string) => ipcRenderer.invoke("plugins:checkUpdate", name),
  checkGit: () => ipcRenderer.invoke("git:check"),
  listMarketplaces: () => ipcRenderer.invoke("marketplace:list"),
  loadMarketplace: (name: string) => ipcRenderer.invoke("marketplace:load", name),
  addMarketplace: (input: string) => ipcRenderer.invoke("marketplace:add", input),
  removeMarketplace: (name: string) => ipcRenderer.invoke("marketplace:remove", name),
  refreshMarketplace: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("marketplace:refresh", name),
  installPlugin: (pluginName: string, marketplaceName: string) =>
    ipcRenderer.invoke("plugins:install", pluginName, marketplaceName),
  pickPluginSource: (
    kind: "dir" | "zip",
  ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null> =>
    ipcRenderer.invoke("dialog:pickPluginSource", kind),
  installLocalPlugin: (
    input: { kind: "dir" | "zip"; path: string; overwrite?: boolean },
  ): Promise<
    | { ok: true; name: string }
    | { ok: false; alreadyInstalled: true; name: string }
    | { ok: false; error?: string }
  > => ipcRenderer.invoke("plugins:installLocal", input),
  readSkillBody: (filePath: string) => ipcRenderer.invoke("skills:read", filePath),
  checkSkillUpdate: (filePath: string) =>
    ipcRenderer.invoke("skills:checkUpdate", filePath),
  updateSkill: (filePath: string) =>
    ipcRenderer.invoke("skills:update", filePath),
  installLocalSkill: (
    sourceDir: string,
    scope: "user" | "project",
    cwd?: string,
    name?: string,
  ) => ipcRenderer.invoke("skills:installLocal", sourceDir, scope, cwd, name),
  uninstallSkill: (filePath: string, source: "user" | "project" | "plugin") =>
    ipcRenderer.invoke("skills:uninstall", filePath, source),
  listAgents: (cwd: string) => ipcRenderer.invoke("agents:list", cwd),
  readAgentBody: (filePath: string) => ipcRenderer.invoke("agents:read", filePath),
  saveAgent: (
    def: import("./types").AgentDefinitionInput,
    opts?: { scope?: "user" | "project"; cwd?: string },
  ) => ipcRenderer.invoke("agents:save", def, opts),
  deleteAgent: (name: string, opts?: { scope?: "user" | "project"; cwd?: string }) =>
    ipcRenderer.invoke("agents:delete", name, opts),
  inspectGithubSkill: (url: string, existingNames?: string[]) =>
    ipcRenderer.invoke("skills:inspectGithub", url, existingNames),
  installFromGithub: (input: unknown) =>
    ipcRenderer.invoke("skills:installFromGithub", input),
  probeMcpServers: (configs: unknown, force?: boolean) =>
    ipcRenderer.invoke("mcp:probe", configs, force),
  listMergedMcpServers: (base: unknown, disabledPlugins?: unknown, cwd?: string) =>
    ipcRenderer.invoke("mcp:listMerged", base, disabledPlugins, cwd),
  listPluginHooks: (disabledPlugins?: unknown) =>
    ipcRenderer.invoke("hooks:listPlugin", disabledPlugins),
  invalidateMcpProbeCache: (name?: string) =>
    ipcRenderer.invoke("mcp:invalidate", name),
  probeSearch: (input: unknown) => ipcRenderer.invoke("search:probe", input),
  probeImage: (input: unknown) => ipcRenderer.invoke("image:probe", input),
  getModelCatalog: () => ipcRenderer.invoke("catalog:list"),
  saveCatalogEntry: (entry: unknown) => ipcRenderer.invoke("catalog:save", entry),
  deleteCatalogEntry: (id: string) => ipcRenderer.invoke("catalog:delete", id),
  getCatalogOrigins: () => ipcRenderer.invoke("catalog:origins"),
  resolveModelMeta: (models: unknown, providers: unknown) =>
    ipcRenderer.invoke("models:resolve-meta", models, providers),
  reasoningControl: (kind: string, model: string) =>
    ipcRenderer.invoke("models:reasoning-control", kind, model),
  listModels: (provider: unknown, refresh?: boolean) =>
    ipcRenderer.invoke("models:list", provider, refresh),
  getTrust: (path: string) => ipcRenderer.invoke("trust:get", path),
  setTrust: (path: string, level: "trusted" | "untrusted") =>
    ipcRenderer.invoke("trust:set", path, level),
  recents: () => ipcRenderer.invoke("recents:list"),
  notify: (opts: { title: string; body?: string; subtitle?: string }) =>
    ipcRenderer.invoke("notify:show", opts),
  setBadgeCount: (count: number) => ipcRenderer.invoke("badge:set", count),
  newWindow: () => ipcRenderer.invoke("window:new"),
  checkForUpdate: () => ipcRenderer.invoke("updater:check"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  getUpdaterStatus: () => ipcRenderer.invoke("updater:status"),
  onUpdaterStatus: (cb: (status: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, status: unknown) => cb(status);
    ipcRenderer.on("updater:status", h);
    return () => ipcRenderer.removeListener("updater:status", h);
  },
  onMenuEvent: (cb: (event: string, payload?: unknown) => void): (() => void) => {
    const wrap = (channel: string) => (_e: IpcRendererEvent, payload?: unknown) =>
      cb(channel.replace(/^menu:/, ""), payload);
    const channels = ["menu:add-project", "menu:open-recent", "menu:find", "menu:palette", "menu:toggle-sidebar", "menu:toggle-inspector", "menu:new-window"];
    const handlers = channels.map((c) => {
      const h = wrap(c);
      ipcRenderer.on(c, h);
      return { c, h };
    });
    return () => {
      handlers.forEach(({ c, h }) => ipcRenderer.removeListener(c, h));
    };
  },

  // ── Terminal (pty) ────────────────────────────────────────────────────
  /**
   * A token unique to this window's renderer process. Used to make terminal
   * session ids window-unique so two windows on the same repo don't hijack
   * each other's shell. Each BrowserWindow gets its own renderer process, so
   * its pid is a stable per-window discriminator for the window's lifetime.
   */
  windowToken: String(process.pid),
  ptyStart: (opts: { sessionId: string; cwd?: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke("pty:start", opts) as Promise<{ pid: number }>,
  ptyWrite: (sessionId: string, data: string) =>
    ipcRenderer.invoke("pty:write", sessionId, data),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:resize", sessionId, cols, rows),
  ptyKill: (sessionId: string) => ipcRenderer.invoke("pty:kill", sessionId),
  onPtyData: (cb: (msg: { sessionId: string; data: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, msg: { sessionId: string; data: string }) => cb(msg);
    ipcRenderer.on("pty:data", h);
    return () => ipcRenderer.removeListener("pty:data", h);
  },
  onPtyExit: (
    cb: (msg: { sessionId: string; exitCode: number; signal?: number }) => void,
  ): (() => void) => {
    const h = (_e: IpcRendererEvent, msg: { sessionId: string; exitCode: number; signal?: number }) =>
      cb(msg);
    ipcRenderer.on("pty:exit", h);
    return () => ipcRenderer.removeListener("pty:exit", h);
  },

  // ── Filesystem (file-browser panel) ───────────────────────────────────
  readDir: (root: string, dir: string) => ipcRenderer.invoke("fs:readDir", root, dir),
  readFileContent: (root: string, path: string) => ipcRenderer.invoke("fs:readFile", root, path),
  /** Does this path resolve to an existing file inside root? Never throws. */
  fileExists: (root: string, path: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:exists", root, path),

  // ── Browser popout window ─────────────────────────────────────────────
  /** Credentials module: token/link store CRUD + cookie capture. */
  credentials: {
    list: (cwd: string) => ipcRenderer.invoke("credentials:list", cwd),
    save: (cwd: string, scope: "user" | "project", cred: unknown) =>
      ipcRenderer.invoke("credentials:save", cwd, scope, cred),
    remove: (cwd: string, scope: "user" | "project", id: string) =>
      ipcRenderer.invoke("credentials:remove", cwd, scope, id),
    /** 只改元数据(label/autoUseByAI/meta),保留 secret —— 编辑/AI 开关用。 */
    patchMeta: (
      cwd: string,
      scope: "user" | "project",
      id: string,
      fields: {
        label?: string;
        exposeAsEnv?: string;
        autoUseByAI?: boolean;
        autoInjectByAI?: boolean;
        meta?: unknown;
      },
    ) => ipcRenderer.invoke("credentials:patchMeta", cwd, scope, id, fields),
    cookieDomains: (): Promise<string[]> => ipcRenderer.invoke("credentials:cookieDomains"),
    cookiePreview: (domain: string): Promise<{ count: number }> =>
      ipcRenderer.invoke("credentials:cookiePreview", domain),
    /** 按域拓取 cookie jar(组装成 cookie 凭证用)。 */
    captureCookieJar: (domain: string): Promise<{ jar: unknown[]; count: number }> =>
      ipcRenderer.invoke("credentials:captureCookieJar", domain),
    /** 全量拓取 persist:browser 分区所有 cookie(按域抓不全的站用)。 */
    captureAllCookies: (): Promise<{ jar: unknown[]; count: number }> =>
      ipcRenderer.invoke("credentials:captureAllCookies"),
    /** 切换账号:把某 cookie 凭证导回浏览器覆盖当前登录态。 */
    restoreCookieToBrowser: (cwd: string, id: string): Promise<{ count: number }> =>
      ipcRenderer.invoke("credentials:restoreCookieToBrowser", cwd, id),
    /** 独立窗口登录抓 cookie(登 Google/YouTube 用)。 */
    loginCapture: (req: {
      url: string;
      platform?: string;
      fullCapture?: boolean;
    }): Promise<
      | { ok: true; jar: unknown[]; domain: string; suggestedLabel?: string; loginCheck: { ok: boolean; missing?: string[] } }
      | { ok: false; cancelled?: boolean; error?: string }
    > => ipcRenderer.invoke("credentials:loginCapture", req),
  },
  /** Open the standalone browser window, optionally at an initial URL. */
  openBrowserPopout: (initialUrl?: string) => ipcRenderer.invoke("browser:popout", initialUrl),
  /** From a popout: send an element-pick anchor back to the parent window. */
  sendBrowserAnchor: (anchor: unknown) => ipcRenderer.send("browser:anchor", anchor),
  /** In the parent: receive anchors forwarded from a popout. Returns unsubscribe. */
  onBrowserAnchorFromPopout: (cb: (anchor: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, anchor: unknown) => cb(anchor);
    ipcRenderer.on("browser:anchor-from-popout", h);
    return () => ipcRenderer.removeListener("browser:anchor-from-popout", h);
  },
  // ── Browser-anchor hub(圈选统一:状态下行、操作上行)──────────────────
  /** Main window → hub: push the active session's browser anchors on change. */
  syncBrowserAnchors: (anchors: unknown[]) => ipcRenderer.send("browser:anchors-sync", anchors),
  /** Popout: subscribe to the broadcast anchor state. Returns unsubscribe. */
  onBrowserAnchorsState: (cb: (anchors: unknown[]) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, anchors: unknown[]) => cb(anchors);
    ipcRenderer.on("browser:anchors-state", h);
    return () => ipcRenderer.removeListener("browser:anchors-state", h);
  },
  /** A page link wanted a new window (target=_blank / window.open); main routes
   *  it here so the browser panel opens it as a new tab. Returns unsubscribe. */
  onBrowserOpenTab: (cb: (payload: { url: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, payload: { url: string }) => cb(payload);
    ipcRenderer.on("browser:open-tab", h);
    return () => ipcRenderer.removeListener("browser:open-tab", h);
  },
  /** Cookie 账号切换后,main 广播此事件让浏览器面板重载当前 tab。Returns unsubscribe. */
  onBrowserReload: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on("browser:reload", h);
    return () => ipcRenderer.removeListener("browser:reload", h);
  },
  /** From a popout: ask the owner (main window) to remove an anchor by id. */
  sendBrowserAnchorRemove: (anchorId: string) => ipcRenderer.send("browser:anchor-remove", anchorId),
  /** From a popout: ask the owner to update an anchor's comment. */
  sendBrowserAnchorUpdate: (update: { id: string; comment: string }) =>
    ipcRenderer.send("browser:anchor-update", update),
  /** In the parent: receive a popout's update request. Returns unsubscribe. */
  onBrowserAnchorUpdateFromPopout: (cb: (update: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, update: unknown) => cb(update);
    ipcRenderer.on("browser:anchor-update-from-popout", h);
    return () => ipcRenderer.removeListener("browser:anchor-update-from-popout", h);
  },
  /** In the parent: receive a popout's remove request. Returns unsubscribe. */
  onBrowserAnchorRemoveFromPopout: (cb: (anchorId: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, anchorId: unknown) => cb(anchorId);
    ipcRenderer.on("browser:anchor-remove-from-popout", h);
    return () => ipcRenderer.removeListener("browser:anchor-remove-from-popout", h);
  },

  // ── Mobile Web Remote (LAN phone controller; off by default) ──────────
  mobileRemote: {
    start: (opts?: { mode?: "lan" | "tunnel" }) =>
      ipcRenderer.invoke("mobileRemote:start", opts),
    stop: () => ipcRenderer.invoke("mobileRemote:stop"),
    pairingUrl: () => ipcRenderer.invoke("mobileRemote:pairingUrl"),
    status: () => ipcRenderer.invoke("mobileRemote:status"),
    listDevices: () => ipcRenderer.invoke("mobileRemote:listDevices"),
    revokeDevice: (id: string) => ipcRenderer.invoke("mobileRemote:revokeDevice", id),
    removeDevice: (id: string) => ipcRenderer.invoke("mobileRemote:removeDevice", id),
    renameDevice: (id: string, name: string) =>
      ipcRenderer.invoke("mobileRemote:renameDevice", id, name),
    onlineDevices: () => ipcRenderer.invoke("mobileRemote:onlineDevices"),
    onOnlineChange: (cb: (ids: string[]) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, ids: string[]) => cb(ids);
      ipcRenderer.on("mobileRemote:onlineChange", h);
      return () => ipcRenderer.removeListener("mobileRemote:onlineChange", h);
    },
    // ── Public tunnel mode ──
    cloudflaredInstalled: () => ipcRenderer.invoke("mobileRemote:cloudflaredInstalled"),
    downloadCloudflared: () => ipcRenderer.invoke("mobileRemote:downloadCloudflared"),
    onDownloadProgress: (cb: (pct: number) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, pct: number) => cb(pct);
      ipcRenderer.on("mobileRemote:downloadProgress", h);
      return () => ipcRenderer.removeListener("mobileRemote:downloadProgress", h);
    },
    passcodeStatus: () => ipcRenderer.invoke("mobileRemote:passcodeStatus"),
    setPasscode: (passcode: string) =>
      ipcRenderer.invoke("mobileRemote:setPasscode", passcode),
    tunnelStatus: () => ipcRenderer.invoke("mobileRemote:tunnelStatus"),
    onTunnelStatus: (
      cb: (s: { status: string; detail?: unknown }) => void,
    ): (() => void) => {
      const h = (_e: IpcRendererEvent, payload: { status: string; detail?: unknown }) =>
        cb(payload);
      ipcRenderer.on("mobileRemote:tunnelStatus", h);
      return () => ipcRenderer.removeListener("mobileRemote:tunnelStatus", h);
    },
  },

  // ── Rooms (resident Claude Code sessions; dual-ended with the phone) ──
  rooms: {
    list: () => ipcRenderer.invoke("rooms:list"),
    projects: () => ipcRenderer.invoke("rooms:projects"),
    create: (input: { name?: string; cwd: string; permissionMode?: string }) =>
      ipcRenderer.invoke("rooms:create", input),
    open: (roomId: string) => ipcRenderer.invoke("rooms:open", roomId),
    close: (roomId: string) => ipcRenderer.invoke("rooms:close", roomId),
    send: (roomId: string, text: string) => ipcRenderer.invoke("rooms:send", roomId, text),
    history: (roomId: string, sinceSeq?: number) =>
      ipcRenderer.invoke("rooms:history", roomId, sinceSeq),
    onMessage: (cb: (env: { roomId: string; msg: unknown }) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, env: { roomId: string; msg: unknown }) => cb(env);
      ipcRenderer.on("room:message", h);
      return () => ipcRenderer.removeListener("room:message", h);
    },
  },
});
