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

let nextRpcId = 1;
const pending = new Map<number, (resp: unknown) => void>();
// Multi-session: callbacks receive `{ sessionId, event }` for stream events
// and `{ sessionId, requestId, request }` for approval requests.
const streamListeners: Array<(env: { sessionId: string; event: unknown }) => void> = [];
const approvalListeners: Array<(env: unknown) => void> = [];
const statusListeners: Array<(evt: unknown) => void> = [];
const lifecycleListeners: Array<(evt: unknown) => void> = [];

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
    const resolver = pending.get(id);
    if (resolver) {
      pending.delete(id);
      resolver(msg);
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
  } else if (method === "agent/approvalRequest") {
    // `{ sessionId, requestId, request }` envelope. requestId lets the
    // renderer echo the decision back via approve(sessionId, requestId, ...).
    approvalListeners.forEach((cb) => cb(params));
  } else if (method === "agent/status") {
    statusListeners.forEach((cb) => cb(params));
  }
});

ipcRenderer.on("agent:lifecycle", (_e: IpcRendererEvent, evt: unknown) => {
  lifecycleListeners.forEach((cb) => cb(evt));
});

const RPC_TIMEOUT_MS = 30_000;

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = nextRpcId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    // Reject (and drop the pending entry) if main never replies, so the caller
    // doesn't hang forever and the resolver doesn't leak in `pending`.
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`RPC '${method}' timed out after ${RPC_TIMEOUT_MS}ms`));
      }
    }, RPC_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    try {
      ipcRenderer.send("agent:msg", line);
    } catch (err) {
      clearTimeout(timer);
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
    rpc("agent/run", { task, ...(opts ?? {}) }),
  /**
   * Cancel a session's running turn. sessionId is required for the
   * multi-session worker; legacy callers that omitted it routed through
   * the (now-removed) single-flag path — multi-session always wants the id.
   */
  cancel: (sessionId?: string) => rpc("agent/cancel", { sessionId }),
  approve: (
    sessionIdOrRequestId: string,
    requestIdOrDecision: string | "approve" | "deny",
    decisionOrReason?: "approve" | "deny" | string,
    reasonOrAnswer?: string,
    answer?: string,
  ) => {
    // Multi-session form: approve(sessionId, requestId, decision, reason?, answer?)
    // Legacy form:        approve(requestId, decision, reason?, answer?)
    let sessionId: string | undefined;
    let requestId: string;
    let decision: "approve" | "deny";
    let reason: string | undefined;
    let answerText: string | undefined;
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
    } else {
      // Legacy: first arg is requestId
      requestId = sessionIdOrRequestId;
      decision = requestIdOrDecision as "approve" | "deny";
      reason = decisionOrReason as string | undefined;
      answerText = reasonOrAnswer;
    }
    return rpc("agent/approve", {
      sessionId,
      requestId,
      decision: decision === "approve"
        ? answerText !== undefined
          ? { approved: true, answer: answerText }
          : { approved: true }
        : { approved: false, reason },
    });
  },
  closeSession: (sessionId: string) => rpc("agent/closeSession", { sessionId }),
  configure: (params: { model?: string; reloadModels?: boolean }) =>
    rpc("agent/configure", params),
  onStreamEvent: (cb: (env: { sessionId: string; event: unknown }) => void): (() => void) => {
    streamListeners.push(cb);
    return () => {
      const i = streamListeners.indexOf(cb);
      if (i >= 0) streamListeners.splice(i, 1);
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
  getGitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
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
  getGitDiff: (cwd: string, file?: string) => ipcRenderer.invoke("git:diff", cwd, file),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  revealInFinder: (path: string) => ipcRenderer.invoke("shell:revealInFinder", path),
  openPath: (path: string, cwd?: string) =>
    ipcRenderer.invoke("shell:openPath", path, cwd),
  undoFiles: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke("files:undo", cwd, paths),
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
  listSkills: (cwd: string) => ipcRenderer.invoke("skills:list", cwd),
  searchFiles: (cwd: string, query: string) =>
    ipcRenderer.invoke("files:search", cwd, query),
  listPlugins: (cwd: string) => ipcRenderer.invoke("plugins:list", cwd),
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
  listMarketplaces: () => ipcRenderer.invoke("marketplace:list"),
  loadMarketplace: (name: string) => ipcRenderer.invoke("marketplace:load", name),
  addMarketplace: (input: string) => ipcRenderer.invoke("marketplace:add", input),
  removeMarketplace: (name: string) => ipcRenderer.invoke("marketplace:remove", name),
  installPlugin: (pluginName: string, marketplaceName: string) =>
    ipcRenderer.invoke("plugins:install", pluginName, marketplaceName),
  readSkillBody: (filePath: string) => ipcRenderer.invoke("skills:read", filePath),
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
  invalidateMcpProbeCache: (name?: string) =>
    ipcRenderer.invoke("mcp:invalidate", name),
  probeSearch: (input: unknown) => ipcRenderer.invoke("search:probe", input),
  resolveModelMeta: (models: unknown, providers: unknown) =>
    ipcRenderer.invoke("models:resolve-meta", models, providers),
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
});
