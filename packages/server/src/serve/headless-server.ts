// packages/server/src/serve/headless-server.ts
//
// Single-workspace Node host. The CLI uses Hub administrator sessions; the
// legacy passcode mode remains available to existing embedders.
// One WorkerBridgeCore owns execution and the persistent workspace sessions.
//
// The browser uses a deliberately small CORE-protocol projection: the host
// answers session list/detail itself and forwards only run/approve/cancel after
// workspace/session authorization. Per-tab request IDs are translated so
// responses return only to their origin; notifications fan out to all tabs.
//
// Restart recovery: sessions persist under the serve-owned worker data root; a
// server restart spawns a fresh worker on the first inbound frame and the
// browser re-lists sessions over the same protocol.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager, SettingsManager } from "@cjhyy/code-shell-core";
import { AccessPasscode } from "../mobile-remote/access-passcode.js";
import { resolveSafe } from "../mobile-remote/mobile-static.js";
import { contentTypeFor } from "../static-files.js";
import { createHubAuth } from "../hub/auth-http.js";
import { ApprovalLeases, type HubApproval } from "../hub/approval-lease.js";
import { HubUploads, hubJson, type PreparedHubUploads } from "../hub/uploads.js";
import { createHubConfiguration, HubConfigurationError } from "../hub/configuration.js";
import { HubRunReplay } from "../hub/run-replay.js";
import { HubOutboundTransport } from "../hub/outbound-transport.js";
import { createHubSkills } from "../hub/skills-management.js";
import { createHubMcpConfiguration } from "../hub/mcp-configuration.js";
import { createLinkHttp } from "../links/http.js";
import { createPanelHttp } from "../panels/http.js";
import { createHubPanelBinding } from "../panels/hub-binding.js";
import {
  createHubSessions,
  hubSessionPreview,
  readHubSessionState,
  readHubTranscript,
} from "../hub/session-management.js";
import { createHubFiles } from "../hub/files.js";
import { WorkerBridgeCore, previewLine, type WorkerBridgeLog } from "../worker-bridge-core.js";

export interface HeadlessServeOptions {
  /** Bind host. Default 127.0.0.1 — expose beyond loopback deliberately. */
  host?: string;
  /** Bind port. 0 picks an ephemeral port (tests). Default 8790. */
  port?: number;
  /** Workspace root the agent worker runs in. */
  cwd: string;
  /** Directory for serve state (access.json). */
  dataDir: string;
  /** Absolute path of the agent-server-stdio worker entry. */
  workerEntryPath: string;
  /** CODE_SHELL_CAPABILITY_MODULES spec injected into the worker env. */
  workerCapabilityModules?: string;
  /** Session root override for tests/relocated workers. Defaults to core's canonical root. */
  sessionRootDir?: string;
  /**
   * Isolated data root passed to the stdio worker. Defaults to `<dataDir>/worker`.
   * When `sessionRootDir` is supplied without this option, its parent is used.
   */
  workerDataRoot?: string;
  /** Runtime binary for the worker; defaults to process.execPath. */
  execPath?: string;
  /** Built web app root; when absent the server is WS/API-only. */
  staticRootDir?: string;
  /**
   * Set (rotate) the access passcode at boot. When omitted and none is
   * configured yet, a random one is generated and returned in
   * `generatedPasscode` — the CLI prints it once.
   */
  passcode?: string;
  /** CLI defaults to hub; omitted by existing API hosts keeps passcode compatibility. */
  authMode?: "hub" | "passcode";
  /** Explicit diagnostics opt-in; may include task content and worker stderr. */
  debugLogs?: boolean;
  /** Exact external origin; required for HTTPS reverse proxies. Never trust forwarded headers. */
  publicOrigin?: string;
  /** Session revocation/expiry sweep interval; defaults to 5 seconds. */
  authRecheckMs?: number;
  log?: WorkerBridgeLog;
  /** Test/host tuning; production defaults to 60 seconds. */
  pendingWorkerResponseTtlMs?: number;
  /** Test/host tuning; production defaults to a 5-second sweep. */
  pendingWorkerResponseReaperMs?: number;
}

export interface HeadlessServer {
  url: string;
  host: string;
  port: number;
  /** Present only when this boot had to generate a fresh passcode. */
  generatedPasscode?: string;
  bootstrapToken?: string;
  passcode: AccessPasscode;
  bridge: WorkerBridgeCore;
  /** Live authenticated tab count (for tests/status). */
  tabCount(): number;
  /** Outstanding browser→worker RPC count (for status/tests). */
  pendingResponseCount(): number;
  close(): Promise<void>;
}

export async function startHeadlessServer(opts: HeadlessServeOptions): Promise<HeadlessServer> {
  const host = opts.host ?? "127.0.0.1";
  const log: WorkerBridgeLog = (event, data) => {
    if (!opts.log) return;
    // Transport diagnostics must not write prompts, approval answers or worker
    // stderr previews to default service logs. Keep only structural metadata.
    const { raw: _raw, text: _text, ...metadata } = data ?? {};
    opts.log(event, opts.debugLogs ? data : metadata);
  };
  const workspaceCwd = resolve(opts.cwd);
  const panelBinding = opts.authMode === "hub" ? createHubPanelBinding(workspaceCwd) : undefined;
  const workerDataRoot = resolve(
    opts.workerDataRoot ??
      (opts.sessionRootDir ? dirname(resolve(opts.sessionRootDir)) : join(opts.dataDir, "worker")),
  );
  const sessionRootDir = resolve(opts.sessionRootDir ?? join(workerDataRoot, "sessions"));
  const expectedSessionRootDir = resolve(join(workerDataRoot, "sessions"));
  if (sessionRootDir !== expectedSessionRootDir) {
    throw new Error(
      `sessionRootDir must equal <workerDataRoot>/sessions (${expectedSessionRootDir}) so the host and worker authorize the same session store`,
    );
  }
  const sessionManager = new SessionManager(sessionRootDir);
  const pendingResponseTtlMs = opts.pendingWorkerResponseTtlMs ?? 60_000;
  const pendingResponseReaperMs = opts.pendingWorkerResponseReaperMs ?? 5_000;
  if (
    !Number.isSafeInteger(pendingResponseTtlMs) ||
    pendingResponseTtlMs <= 0 ||
    !Number.isSafeInteger(pendingResponseReaperMs) ||
    pendingResponseReaperMs <= 0
  ) {
    throw new Error("pending worker response timeouts must be positive safe integers");
  }

  const passcode = new AccessPasscode({ filePath: join(opts.dataDir, "access.json") });
  let generatedPasscode: string | undefined;
  if (opts.authMode !== "hub" && opts.passcode) {
    passcode.set(opts.passcode);
  } else if (opts.authMode !== "hub" && !passcode.isSet()) {
    generatedPasscode = randomBytes(6).toString("base64url");
    passcode.set(generatedPasscode);
  }

  const tabs = new Set<WebSocket>();
  // Auth revocation callbacks are registered before configuration modules are ready.
  // eslint-disable-next-line prefer-const
  let mcp: ReturnType<typeof createHubMcpConfiguration> | undefined;
  // eslint-disable-next-line prefer-const
  let configuration: ReturnType<typeof createHubConfiguration> | undefined;
  // eslint-disable-next-line prefer-const
  let links: ReturnType<typeof createLinkHttp> | undefined;
  // eslint-disable-next-line prefer-const
  let panels: ReturnType<typeof createPanelHttp> | undefined;
  const tabAuth = new Map<WebSocket, { sessionId: string; request: IncomingMessage }>();
  const hubAuth =
    opts.authMode === "hub"
      ? await createHubAuth({
          dataDir: opts.dataDir,
          publicOrigin: opts.publicOrigin,
          onRevoke: (sessionId) => {
            mcp?.cancelOwner(sessionId);
            configuration?.cancelOwner(sessionId);
            links?.cancelOwner(sessionId);
            panels?.cancelOwner(sessionId);
            for (const [ws, auth] of tabAuth) {
              if (auth.sessionId === sessionId) ws.close(4401, "session revoked");
            }
          },
        })
      : undefined;
  const uploads = hubAuth ? new HubUploads(join(opts.dataDir, "uploads"), workspaceCwd) : undefined;
  await uploads?.ready();
  const pendingWorkerResponses = new Map<
    string,
    {
      tab: WebSocket;
      originalId: string | number;
      tabId: number;
      insertedAt: number;
      method?: string;
      approvalId?: string;
    }
  >();
  const pendingResponsesByTab = new Map<number, number>();
  // Independent of response routing: leaving a tab does not stop its worker run.
  const runningSessions = new Map<string, string>();
  const runOwners = new Map<string, string>();
  const runReplay = new HubRunReplay();
  const runInputs = new Map<
    string,
    {
      sessionId: string;
      event: Record<string, unknown>;
      echoed: boolean;
    }
  >();
  let preparingRuns = 0;
  let configurationChanging = false;
  let configurationReloadFailed = false;
  const runUploads = new Map<string, PreparedHubUploads>();
  const isRunning = (sessionId: string): boolean =>
    [...runningSessions.values()].includes(sessionId);
  let nextTabId = 1;
  let nextWorkerRequestId = 1;
  const outbound = new HubOutboundTransport({
    tabs: () => tabs,
    onDrop: (metadata) => log("tab.backpressure_drop", { ...metadata }),
  });
  const sendToTab = (tab: WebSocket, line: string, _context: string): boolean =>
    outbound.send(tab, line);
  const broadcast = (line: string): void => {
    for (const tab of tabs) {
      sendToTab(tab, line, "broadcast");
    }
  };

  const notify = (method: string, params: unknown): void => {
    broadcast(JSON.stringify({ jsonrpc: "2.0", method, params }));
  };
  const publishStream = (sessionId: string, event: unknown): void => {
    const cursor = runReplay.append(sessionId, event);
    notify("agent/streamEvent", {
      sessionId,
      event,
      hubSequence: cursor.sequence,
      hubEpoch: cursor.epoch,
    });
  };
  const leases = new ApprovalLeases((lease) => notify("serve/approvalLease", lease));
  const authReaper = hubAuth
    ? setInterval(() => {
        leases.sweep();
        void uploads?.sweep().catch(() => {});
        for (const [ws, auth] of tabAuth) {
          void hubAuth
            .authenticate(auth.request)
            .then((session) => {
              if (!session) ws.close(4401, "session expired");
            })
            .catch(() => ws.close(4401, "session unavailable"));
        }
      }, opts.authRecheckMs ?? 5_000)
    : undefined;
  authReaper?.unref?.();

  const deletePendingWorkerResponse = (requestId: string): void => {
    const route = pendingWorkerResponses.get(requestId);
    if (!route) return;
    pendingWorkerResponses.delete(requestId);
    const remaining = (pendingResponsesByTab.get(route.tabId) ?? 1) - 1;
    if (remaining > 0) pendingResponsesByTab.set(route.tabId, remaining);
    else pendingResponsesByTab.delete(route.tabId);
  };

  const clearPendingWorkerResponsesForTab = (tabId: number): void => {
    for (const [requestId, route] of pendingWorkerResponses) {
      // A submitted approval still needs its worker ACK after this tab leaves.
      // In particular, an error must reopen the card on the remaining devices.
      if (route.tabId === tabId && !route.approvalId) deletePendingWorkerResponse(requestId);
    }
  };

  const failPendingWorkerResponses = (message: string): void => {
    for (const { tab, originalId } of pendingWorkerResponses.values()) {
      sendToTab(tab, hostQueryError(originalId, -32000, message), "worker-exit");
    }
    pendingWorkerResponses.clear();
    pendingResponsesByTab.clear();
    runningSessions.clear();
    runOwners.clear();
    runReplay.clear();
    runInputs.clear();
    for (const receipt of runUploads.values()) receipt.release();
    runUploads.clear();
  };

  const pendingResponseReaper = setInterval(() => {
    const now = Date.now();
    for (const [requestId, route] of pendingWorkerResponses) {
      // Runs answer only at turn end, potentially hours later.
      if (hubAuth && (route.method === "agent/run" || route.approvalId)) continue;
      if (now - route.insertedAt < pendingResponseTtlMs) continue;
      deletePendingWorkerResponse(requestId);
      sendToTab(
        route.tab,
        hostQueryError(route.originalId, -32000, "agent worker response timed out"),
        "worker-timeout",
      );
    }
  }, pendingResponseReaperMs);
  pendingResponseReaper.unref?.();

  // Notifications describe shared agent state and are broadcast. Correlated
  // JSON-RPC responses must return only to the tab that issued the request;
  // browser tabs all start their local counters at `web-1`, so broadcasting a
  // response lets one tab resolve another tab's promise.
  const routeWorkerLine = (line: string): void => {
    let message:
      | {
          id?: string | number | null;
          method?: string;
          [key: string]: unknown;
        }
      | undefined;
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      log("worker.frame_dropped", { reason: "not json", raw: previewLine(line) });
      return;
    }
    if (!message || message.id === undefined || message.method !== undefined) {
      if (hubAuth && message?.method === "agent/streamEvent") {
        const params = message.params as { sessionId?: unknown; event?: unknown } | undefined;
        if (typeof params?.sessionId === "string" && params.event !== undefined) {
          let event = params.event;
          const value = event as Record<string, unknown> | null;
          if (value?.type === "session_user_message" && typeof value.clientMessageId === "string") {
            const input = [...runInputs.values()].find(
              (candidate) =>
                candidate.sessionId === params.sessionId &&
                candidate.event.clientMessageId === value.clientMessageId,
            );
            if (input) {
              if (input.echoed) return;
              input.echoed = true;
              event = input.event;
            }
          }
          publishStream(params.sessionId, event);
          return;
        }
      }
      if (hubAuth && message?.method === "agent/runAccepted") {
        const params = message.params as { requestId?: unknown; sessionId?: unknown } | undefined;
        const requestId = String(params?.requestId);
        const input = runInputs.get(requestId);
        if (input && !input.echoed) {
          input.echoed = true;
          publishStream(input.sessionId, input.event);
        }
        const route = pendingWorkerResponses.get(requestId);
        if (route)
          sendToTab(
            route.tab,
            JSON.stringify({
              ...message,
              params: { ...params, requestId: route.originalId },
            }),
            "run-accepted",
          );
        return;
      }
      if (hubAuth && message?.method === "agent/approvalRequest") {
        const approval = message.params as HubApproval | undefined;
        if (
          approval &&
          typeof approval.requestId === "string" &&
          typeof approval.sessionId === "string"
        ) {
          const request = approval.request as { toolName?: string; args?: Record<string, unknown> } | undefined;
          if (request?.toolName === "__panel_action__") {
            const ownerId = runOwners.get(approval.sessionId);
            const result = ownerId && panels
              ? panels.panelAction(ownerId, approval.sessionId, request.args ?? {})
              : Promise.resolve({ ok: false, detail: "当前对话没有可用的面板连接。" });
            void result.catch(() => ({ ok: false, detail: "面板操作未完成。" })).then((answer) => {
              if (!isRunning(approval.sessionId) || runOwners.get(approval.sessionId) !== ownerId) return;
              return bridge.request("agent/approve", {
                sessionId: approval.sessionId, requestId: approval.requestId,
                connectionId: approval.connectionId, generation: approval.generation,
                decision: { approved: true, answer: JSON.stringify(answer) },
              }, { id: `panel-reply-${randomUUID()}`, consume: true, settleOnExit: true, failFast: true, timeoutMs: 5000,
                meta: { origin: "host", producer: "hub-panel-action" },
              });
            }).catch(() => {});
            return;
          }
          try {
            leases.add(approval);
          } catch {
            workerUnavailable("pending approval limit exceeded");
            bridge.kill();
            return;
          }
        }
      } else if (hubAuth && message?.method === "agent/approvalResolved") {
        const requestId = (message.params as { requestId?: string })?.requestId;
        if (requestId) leases.resolved(requestId);
      }
      broadcast(line);
      return;
    }
    const receipt = runUploads.get(String(message.id));
    if (receipt) {
      runUploads.delete(String(message.id));
      if (message.error) receipt.release();
      else void receipt.commit().catch(() => log("upload.finalize_failed"));
    }
    const runSessionId = runningSessions.get(String(message.id));
    runInputs.delete(String(message.id));
    if (runSessionId) {
      const finishedSession = runningSessions.get(String(message.id));
      runningSessions.delete(String(message.id));
      if (finishedSession && !isRunning(finishedSession)) runOwners.delete(finishedSession);
      runReplay.finish(runSessionId, String(message.id));
      if (hubAuth)
        notify("serve/sessionStatus", {
          sessionId: runSessionId,
          running: isRunning(runSessionId),
        });
    }
    const route = pendingWorkerResponses.get(String(message.id));
    if (!route) {
      log("worker.response_dropped", { reason: "unknown request id", id: message.id });
      return;
    }
    if (route.approvalId) {
      if (message.error) {
        leases.retry(route.approvalId);
        notify("serve/approvalSnapshot", { approvals: leases.snapshot() });
      } else {
        // The worker's successful ACK is authoritative even if an implementation
        // omits the separate approvalResolved notification.
        leases.resolved(route.approvalId);
        notify("agent/approvalResolved", { requestId: route.approvalId });
      }
    }
    deletePendingWorkerResponse(String(message.id));
    sendToTab(route.tab, JSON.stringify({ ...message, id: route.originalId }), "worker-response");
  };

  const workerUnavailable = (message: string): void => {
    failPendingWorkerResponses(message);
    leases.clear();
    if (hubAuth) notify("serve/approvalSnapshot", { approvals: [] });
    notify("serve/workerExit", { clean: false, gaveUp: true });
  };
  const bridge = new WorkerBridgeCore({
    entryPath: opts.workerEntryPath,
    execPath: opts.execPath,
    fallbackCwd: () => opts.cwd,
    buildEnv: () => ({
      ...process.env,
      CODE_SHELL_DATA_ROOT: workerDataRoot,
      CODE_SHELL_CREDENTIAL_ACCESS: "local",
      ...(opts.workerCapabilityModules
        ? { CODE_SHELL_CAPABILITY_MODULES: opts.workerCapabilityModules }
        : {}),
    }),
    log,
    onStderr: (text) => log("worker.stderr", { text: previewLine(text) }),
    onSpawnFailed: () => workerUnavailable("agent worker could not start"),
    onSpawnError: () => workerUnavailable("agent worker could not start"),
    onExit: (info) => {
      failPendingWorkerResponses("agent worker stopped");
      leases.clear();
      if (hubAuth) notify("serve/approvalSnapshot", { approvals: [] });
      configurationReloadFailed = false;
      // Synthetic serve-level notification so the UI can show "agent worker
      // stopped" without conflating it with in-protocol agent/status.
      broadcast(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "serve/workerExit",
          params: { clean: info.clean, gaveUp: info.gaveUp },
        }),
      );
    },
  });
  bridge.subscribeLines(routeWorkerLine);

  const withConfigurationMutation = async <T>(write: () => Promise<T>): Promise<T> => {
    if (
      configurationChanging ||
      preparingRuns > 0 ||
      runningSessions.size > 0 ||
      (panels?.activeTaskCount() ?? 0) > 0 ||
      pendingWorkerResponses.size > 0
    ) {
      throw new HubConfigurationError(409, "请等待当前任务完成后再保存配置。");
    }
    configurationChanging = true;
    try {
      const result = await write();
      // Use Desktop's fixed hot-reload operation, preserving sessions and
      // background commands. This host-only RPC is never browser-controlled.
      if (bridge.hasChild()) {
        const outcome = await bridge.request(
          "agent/configure",
          {
            reloadModels: true,
            reloadSettings: true,
          },
          {
            id: `hub-configuration-${nextWorkerRequestId++}`,
            timeoutMs: 5_000,
            consume: true,
            settleOnExit: true,
            failFast: true,
            meta: { origin: "serve", producer: "serve-configuration" },
          },
        );
        if (outcome.status !== "result") {
          configurationReloadFailed = bridge.hasChild();
          throw new HubConfigurationError(503, "配置已保存但未能生效，请重新保存或重启服务。");
        }
      }
      configurationReloadFailed = false;
      notify("serve/configurationChanged", {});
      return result;
    } finally {
      configurationChanging = false;
    }
  };
  const configurationOptions = {
    cwd: workspaceCwd,
    isAuthorized: async (req: IncomingMessage) => !!(await hubAuth?.authenticate(req)),
    ownerId: async (req: IncomingMessage) => (await hubAuth?.authenticate(req))?.id,
    withMutation: withConfigurationMutation,
  };
  configuration = hubAuth ? createHubConfiguration(configurationOptions) : undefined;
  links = hubAuth
    ? createLinkHttp({
        ...configurationOptions,
        onChanged: () => notify("serve/configurationChanged", {}),
      })
    : undefined;
  panels = hubAuth
    ? createPanelHttp({
        ...configurationOptions,
        ...panelBinding,
        dataDir: opts.dataDir,
        host: "hub",
        agentTaskOptions: {
          workerEntryPath: opts.workerEntryPath,
          buildEnv: () => ({
            ...process.env,
            CODE_SHELL_DATA_ROOT: workerDataRoot,
            CODE_SHELL_CREDENTIAL_ACCESS: "local",
            ...(opts.workerCapabilityModules ? { CODE_SHELL_CAPABILITY_MODULES: opts.workerCapabilityModules } : {}),
          }),
        },
        onChanged: () => notify("serve/configurationChanged", {}),
      })
    : undefined;
  const skills = hubAuth
    ? createHubSkills({
        ...configurationOptions,
        dataDir: opts.dataDir,
        owner: async (req) => (await hubAuth.authenticate(req))?.id ?? null,
      })
    : undefined;
  mcp = hubAuth
    ? createHubMcpConfiguration({
        ...configurationOptions,
        ownerId: async (req) => (await hubAuth.authenticate(req))?.id,
      })
    : undefined;
  const sessionManagement = hubAuth
    ? createHubSessions({
        cwd: workspaceCwd,
        sessionRootDir,
        dataDir: opts.dataDir,
        isAuthorized: configurationOptions.isAuthorized,
        isRunning,
        onChanged: (sessionId) => notify("serve/sessionsChanged", { sessionId }),
      })
    : undefined;
  const files = hubAuth
    ? createHubFiles({ cwd: workspaceCwd, isAuthorized: configurationOptions.isAuthorized })
    : undefined;

  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    const root = opts.staticRootDir;
    if (!root) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("no web app bundled; WS endpoint at /ws");
      return;
    }
    const pathname = decodeSafely(new URL(req.url ?? "/", "http://localhost").pathname);
    if (pathname === null) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad path");
      return;
    }
    let filePath = pathname === "/" ? null : resolveSafe(root, pathname.replace(/^\//, ""));
    if (filePath === null || !existsSync(filePath)) {
      // SPA fallback: any unknown (or traversal-rejected) HTML navigation gets
      // index.html; non-navigation asset misses stay 404.
      const accept = req.headers.accept ?? "";
      const wantsHtml = typeof accept === "string" && accept.includes("text/html");
      if (!wantsHtml && pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      filePath = join(root, "index.html");
      if (!existsSync(filePath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("web app not built");
        return;
      }
    }
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, {
        "content-type": contentTypeFor(extname(filePath)),
        "cache-control": "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  };

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (pathname === "/health" && req.method === "GET") {
      hubJson(res, 200, { status: "ok", mode: hubAuth ? "hub" : "passcode" });
      return;
    }
    if (hubAuth) {
      if (await panels?.handleAssets(req, res)) return;
      if (await hubAuth.handle(req, res)) return;
      if (pathname.startsWith("/api/")) {
        const session = await hubAuth.authenticate(req);
        if (!session) {
          hubJson(res, 401, { error: "login required" });
          return;
        }
        if (!hubAuth.isOriginAllowed(req)) {
          hubJson(res, 403, { error: "origin rejected" });
          return;
        }
        if (await configuration!.handle(req, res)) return;
        if (await links!.handle(req, res)) return;
        if (await panels!.handle(req, res)) return;
        if (await skills!.handle(req, res)) return;
        if (await mcp!.handle(req, res)) return;
        if (await sessionManagement!.handle(req, res)) return;
        if (await files!.handle(req, res)) return;
        const upload = /^\/api\/v1\/uploads\/([^/]+)$/.exec(pathname);
        if (upload && req.method === "PUT") {
          await uploads!.accept(
            upload[1]!,
            session.id,
            req,
            res,
            async () => !!(await hubAuth.authenticate(req)),
          );
          return;
        }
        hubJson(res, 404, { error: "API endpoint not found" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        hubJson(res, 405, { error: "method not allowed" });
        return;
      }
      // Public static shell contains no user data and supplies the setup/login page.
      serveStatic(req, res);
      return;
    }
    if (!passcode.gate(req, res)) return;
    serveStatic(req, res);
  };
  const server: Server = createServer((req, res) => {
    void handleHttp(req, res).catch(() => hubJson(res, 500, { error: "server request failed" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const session = hubAuth ? await hubAuth.authenticate(req) : undefined;
    const allowed = hubAuth
      ? !!session && hubAuth.isOriginAllowed(req)
      : passcode.allows(req as never);
    if (pathname !== "/ws" || !allowed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (tabs.size >= 64) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const tabId = nextTabId++;
    wss.handleUpgrade(req, socket, head, (ws) => {
      tabs.add(ws);
      if (session) tabAuth.set(ws, { sessionId: session.id, request: req });
      const holderId = String(tabId);
      if (hubAuth) {
        sendToTab(
          ws,
          JSON.stringify({ jsonrpc: "2.0", method: "serve/hello", params: { tabId: holderId } }),
          "hello",
        );
        sendToTab(
          ws,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "serve/approvalSnapshot",
            params: { approvals: leases.snapshot() },
          }),
          "approval-snapshot",
        );
      }
      log("tab.connected", { tabs: tabs.size });
      const handleMessage = async (data: unknown): Promise<void> => {
        if (ws.readyState !== ws.OPEN) return;
        if (hubAuth && !(await hubAuth.authenticate(req))) {
          ws.close(4401, "session expired");
          return;
        }
        if (webSocketPayloadBytes(data) > 1024 * 1024) {
          log("tab.frame_dropped", { reason: "payload too large" });
          ws.close(1009, "payload too large");
          return;
        }
        const line = String(data);
        // Validate framing before touching the worker: a malformed frame from
        // one tab must never kill the shared pipe.
        let parsed:
          | {
              jsonrpc?: string;
              id?: string | number | null;
              method?: string;
              params?: Record<string, unknown>;
            }
          | undefined;
        try {
          parsed = JSON.parse(line) as { jsonrpc?: string };
        } catch {
          log("tab.frame_dropped", { reason: "not json", raw: previewLine(line) });
          return;
        }
        if (!parsed || parsed.jsonrpc !== "2.0") {
          log("tab.frame_dropped", { reason: "not jsonrpc", raw: previewLine(line) });
          return;
        }
        if (
          hubAuth &&
          (parsed.method === "serve/approval.claim" || parsed.method === "serve/approval.release")
        ) {
          const requestId = parsed.params?.requestId;
          try {
            if (typeof requestId !== "string") throw new Error("requestId required");
            const result =
              parsed.method === "serve/approval.claim"
                ? leases.claim(requestId, holderId)
                : (leases.release(requestId, holderId), { released: true });
            sendToTab(
              ws,
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, result }),
              "approval-lease",
            );
          } catch (error) {
            sendToTab(
              ws,
              hostQueryError(parsed.id ?? null, -32009, (error as Error).message),
              "approval-lease",
            );
          }
          return;
        }
        const hostReply = replyToHostSessionQuery(
          parsed,
          sessionManager,
          workspaceCwd,
          isRunning,
          hubAuth ? runReplay : undefined,
        );
        if (hostReply) {
          sendToTab(ws, hostReply, "host-session-query");
          return;
        }
        const policyReply = authorizeServeRequest(parsed, sessionManager, workspaceCwd, isRunning);
        if (policyReply) {
          sendToTab(ws, policyReply, "request-policy");
          return;
        }
        if (
          hubAuth &&
          (parsed.id === undefined ||
            parsed.id === null ||
            (typeof parsed.id !== "string" && typeof parsed.id !== "number"))
        ) {
          sendToTab(ws, hostQueryError(null, -32600, "request id required"), "request-id");
          return;
        }
        if ((pendingResponsesByTab.get(tabId) ?? 0) >= 64) {
          sendToTab(
            ws,
            hostQueryError(
              parsed.id ?? null,
              -32000,
              "too many pending agent worker requests for this tab",
            ),
            "pending-limit",
          );
          return;
        }
        let approvalId: string | undefined;
        if (hubAuth && parsed.method === "agent/approve") {
          const requestId = parsed.params?.requestId;
          const approval = typeof requestId === "string" ? leases.get(requestId) : undefined;
          if (!approval || approval.sessionId !== parsed.params?.sessionId) {
            sendToTab(
              ws,
              hostQueryError(parsed.id ?? null, -32009, "approval is no longer pending"),
              "approval",
            );
            return;
          }
          const decision = parsed.params?.decision;
          if (
            !decision ||
            typeof decision !== "object" ||
            typeof (decision as { approved?: unknown }).approved !== "boolean"
          ) {
            sendToTab(
              ws,
              hostQueryError(parsed.id ?? null, -32602, "approval decision required"),
              "approval",
            );
            return;
          }
          try {
            leases.submit(approval.requestId, holderId);
            approvalId = approval.requestId;
            // Connection/generation belong to the worker's request, never to browser input.
            parsed.params = {
              sessionId: approval.sessionId,
              requestId: approval.requestId,
              decision,
              ...(approval.connectionId !== undefined
                ? { connectionId: approval.connectionId }
                : {}),
              ...(approval.generation !== undefined ? { generation: approval.generation } : {}),
            };
          } catch (error) {
            sendToTab(
              ws,
              hostQueryError(parsed.id ?? null, -32009, (error as Error).message),
              "approval",
            );
            return;
          }
        }
        let preparedUploads: PreparedHubUploads | undefined;
        let uploadsTransferred = false;
        const preparingRun = !!hubAuth && parsed.method === "agent/run";
        if (hubAuth && (configurationChanging || configurationReloadFailed)) {
          sendToTab(
            ws,
            hostQueryError(
              parsed.id ?? null,
              -32009,
              configurationReloadFailed
                ? "请先重新保存配置或重启服务，再发送任务。"
                : "配置正在保存，请稍后重新发送任务。",
            ),
            "configuration-changing",
          );
          return;
        }
        if (preparingRun) preparingRuns++;
        try {
          if (hubAuth && parsed.method === "agent/run") {
            // Server-assigned ids ensure even clients that omit them have
            // tracked runs, upload ownership and refreshable stream snapshots.
            parsed.params = {
              ...parsed.params,
              sessionId: parsed.params?.sessionId ?? randomUUID(),
              clientMessageId: parsed.params?.clientMessageId ?? randomUUID(),
            };
            if (runningSessions.size >= 64) {
              sendToTab(
                ws,
                hostQueryError(parsed.id ?? null, -32000, "too many active runs"),
                "run-limit",
              );
              return;
            }
            try {
              preparedUploads = await uploads!.prepare(
                parsed.params?.uploadIds,
                session!.id,
                parsed.params?.sessionId,
              );
              const {
                uploadIds: _uploadIds,
                attachments: _attachments,
                ...params
              } = parsed.params ?? {};
              const attachments = preparedUploads.attachments;
              parsed.params = { ...params, ...(attachments.length ? { attachments } : {}) };
            } catch (error) {
              sendToTab(
                ws,
                hostQueryError(parsed.id ?? null, -32602, (error as Error).message),
                "attachments",
              );
              return;
            }
            if (ws.readyState !== ws.OPEN || !(await hubAuth.authenticate(req))) return;
          }
          // Recheck after asynchronous staging/authentication; other tabs may
          // have filled the runtime's capacity while this request was suspended.
          if (hubAuth && parsed.method === "agent/run" && runningSessions.size >= 64) {
            sendToTab(
              ws,
              hostQueryError(parsed.id ?? null, -32000, "too many active runs"),
              "run-limit",
            );
            return;
          }
          // This host intentionally exposes one workspace. A browser must not be
          // able to escape it by supplying another cwd, and a missing cwd must
          // not silently become the worker's global no-repo conversation.
          let defaultModel: string | undefined;
          if (hubAuth && parsed.method === "agent/run" && parsed.params?.model === undefined) {
            try {
              // The preparation guard remains held while reading and dispatching.
              // Reloading the shared model pool alone does not change an existing
              // session's selected model; this normal run parameter switches it at
              // the turn boundary and also refreshes edited connection credentials.
              defaultModel = new SettingsManager(workspaceCwd, "full").get().defaults.text;
            } catch {
              sendToTab(
                ws,
                hostQueryError(parsed.id ?? null, -32602, "模型设置读取失败，请检查服务器配置。"),
                "configuration-invalid",
              );
              return;
            }
          }
          const workerMessage =
            parsed.method === "agent/run"
              ? {
                  ...parsed,
                  params: {
                    ...(parsed.params ?? {}),
                    ...(defaultModel ? { model: defaultModel } : {}),
                    cwd: workspaceCwd,
                  },
                }
              : parsed;
          if (workerMessage.id === null) {
            sendToTab(
              ws,
              hostQueryError(null, -32600, "JSON-RPC request id must not be null"),
              "request-id",
            );
            return;
          }
          let baselineEvents = 0;
          const baselineSessionId = workerMessage.params?.sessionId;
          if (hubAuth && parsed.method === "agent/run" && typeof baselineSessionId === "string") {
            try {
              if (readOptionalHubSessionState(sessionManager, baselineSessionId)) {
                baselineEvents = readHubTranscript(sessionRootDir, baselineSessionId).length;
              }
            } catch (cause) {
              sendToTab(
                ws,
                hostQueryError(
                  workerMessage.id ?? null,
                  -32001,
                  cause instanceof Error ? cause.message : "会话记录无法读取，请检查服务器备份。",
                ),
                "transcript-unavailable",
              );
              return;
            }
          }
          if (workerMessage.id !== undefined) {
            if ((pendingResponsesByTab.get(tabId) ?? 0) >= 64) {
              sendToTab(
                ws,
                hostQueryError(
                  workerMessage.id,
                  -32000,
                  "too many pending agent worker requests for this tab",
                ),
                "pending-limit",
              );
              return;
            }
            if (hubAuth && parsed.method === "agent/run") {
              const runSession = workerMessage.params?.sessionId;
              const ownerId = tabAuth.get(ws)?.sessionId;
              const activeOwner = typeof runSession === "string" ? runOwners.get(runSession) : undefined;
              if (activeOwner && activeOwner !== ownerId) {
                sendToTab(ws, hostQueryError(workerMessage.id, -32009,
                  "此对话正在另一台设备运行，请等待完成后再发送。"), "run-owner");
                return;
              }
            }
            const workerRequestId = `serve-${tabId}-${nextWorkerRequestId++}`;
            pendingWorkerResponses.set(workerRequestId, {
              tab: ws,
              originalId: workerMessage.id,
              tabId,
              insertedAt: Date.now(),
              method: parsed.method,
              ...(approvalId ? { approvalId } : {}),
            });
            pendingResponsesByTab.set(tabId, (pendingResponsesByTab.get(tabId) ?? 0) + 1);
            workerMessage.id = workerRequestId;
            if (preparedUploads?.attachments.length) {
              runUploads.set(workerRequestId, preparedUploads);
              uploadsTransferred = true;
            }
            const runSessionId = workerMessage.params?.sessionId;
            if (parsed.method === "agent/run" && typeof runSessionId === "string") {
              if (hubAuth) {
                runReplay.begin(runSessionId, workerRequestId, baselineEvents);
                const params = workerMessage.params ?? {};
                runInputs.set(workerRequestId, {
                  sessionId: runSessionId,
                  echoed: false,
                  event: {
                    type: "session_user_message",
                    text: typeof params.displayText === "string" ? params.displayText : params.task,
                    clientMessageId: params.clientMessageId,
                    attachments: (preparedUploads?.attachments ?? []).map((attachment) => ({
                      name: attachment.originalName ?? basename(attachment.path),
                      size: attachment.size,
                      mime: attachment.mime,
                      path: attachment.relPath ?? attachment.absPath,
                    })),
                  },
                });
              }
              runningSessions.set(workerRequestId, runSessionId);
              const ownerId = tabAuth.get(ws)?.sessionId;
              if (ownerId) runOwners.set(runSessionId, ownerId);
              if (hubAuth)
                notify("serve/sessionStatus", { sessionId: runSessionId, running: true });
            }
          }
          const workerLine = JSON.stringify(workerMessage);
          // Spawn-on-first-frame (idempotent): the browser's first request wakes
          // the worker, mirroring the renderer's spawn-on-agent/run semantics.
          bridge.ensureWorker(opts.cwd);
          if (!bridge.canSend()) {
            workerUnavailable("agent worker is unavailable");
            return;
          }
          bridge.injectWorkerMessage(workerLine, { origin: "serve", producer: "serve-ws" });
        } finally {
          if (preparingRun) preparingRuns--;
          if (!uploadsTransferred) preparedUploads?.release();
        }
      };
      let queued = 0;
      let chain = Promise.resolve();
      ws.on("message", (data) => {
        if (++queued > 64) {
          ws.close(1008, "too many queued requests");
          queued--;
          return;
        }
        chain = chain
          .then(() => handleMessage(data))
          .catch(() => {
            sendToTab(ws, hostQueryError(null, -32000, "request failed"), "request-error");
          })
          .finally(() => {
            queued--;
          });
      });
      ws.on("close", () => {
        tabs.delete(ws);
        tabAuth.delete(ws);
        leases.releaseHolder(holderId);
        clearPendingWorkerResponsesForTab(tabId);
        log("tab.closed", { tabs: tabs.size });
      });
      ws.on("error", () => {
        tabs.delete(ws);
        tabAuth.delete(ws);
        leases.releaseHolder(holderId);
        clearPendingWorkerResponsesForTab(tabId);
      });
    });
  };
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void upgrade(req, socket, head).catch(() => socket.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 8790, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(pendingResponseReaper);
    if (authReaper) clearInterval(authReaper);
    await uploads?.close();
    await skills?.close();
    await mcp?.close();
    configuration?.close();
    links?.close();
    panels?.close();
    files?.close();
    bridge.kill();
    wss.close();
    server.close();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8790);
  const url = `http://${host}:${port}`;
  log("serve.listening", { url });

  return {
    url,
    host,
    port,
    ...(generatedPasscode ? { generatedPasscode } : {}),
    ...(hubAuth?.bootstrapToken ? { bootstrapToken: hubAuth.bootstrapToken } : {}),
    passcode,
    bridge,
    tabCount: () => tabs.size,
    pendingResponseCount: () => pendingWorkerResponses.size,
    close: async () => {
      clearInterval(pendingResponseReaper);
      if (authReaper) clearInterval(authReaper);
      await uploads?.close();
      await skills?.close();
      await mcp?.close();
      configuration?.close();
      links?.close();
      panels?.close();
      files?.close();
      for (const tab of tabs) {
        try {
          tab.terminate();
        } catch {
          /* ignore */
        }
      }
      tabs.clear();
      bridge.kill();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
        // server.close() alone waits out keep-alive HTTP sockets forever;
        // drop them so shutdown is prompt.
        server.closeAllConnections?.();
      });
    },
  };
}

function webSocketPayloadBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Array.isArray(data)) {
    return data.reduce(
      (total, item) => total + (typeof item?.byteLength === "number" ? item.byteLength : 0),
      0,
    );
  }
  if (data && typeof data === "object" && "byteLength" in data) {
    const byteLength = (data as { byteLength?: unknown }).byteLength;
    return typeof byteLength === "number" ? byteLength : Number.POSITIVE_INFINITY;
  }
  return Buffer.byteLength(String(data), "utf8");
}

function replyToHostSessionQuery(
  message: {
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  },
  sessionManager: SessionManager,
  workspaceCwd: string,
  isRunning: (sessionId: string) => boolean = () => false,
  runReplay?: HubRunReplay,
): string | undefined {
  if (message.method !== "agent/query" || message.id === undefined) return undefined;
  const queryType = message.params?.type;
  if (queryType === "sessions") {
    const sessions = sessionManager
      .list(100, { cwd: workspaceCwd, archived: false, rootsOnly: true })
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        startedAt: session.startedAt,
        model: session.model,
        status: session.status,
        turnCount: session.turnCount,
        lastActiveAt: session.lastActiveAt,
        ...(session.title ? { title: session.title } : {}),
        ...(session.preview ? { preview: hubSessionPreview(session.preview) } : {}),
      }));
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { type: "sessions", data: sessions },
    });
  }
  if (queryType !== "session_detail") return undefined;

  const sessionId = message.params?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return hostQueryError(message.id, -32602, "sessionId required for session_detail");
  }
  let missingSession = false;
  try {
    const state = readOptionalHubSessionState(sessionManager, sessionId);
    missingSession = !state;
    if (!state) throw new Error("Session not found in this workspace");
    if (resolve(state.cwd) !== workspaceCwd) {
      return hostQueryError(message.id, -32001, "Session not found in this workspace");
    }
    const transcript = readHubTranscript(sessionManager.getStorageDir(), sessionId);
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        type: "session_detail",
        data: {
          state,
          ...(runReplay ? runReplay.snapshot(sessionId, transcript) : { transcript }),
          running: isRunning(sessionId),
        },
      },
    });
  } catch (error) {
    if (
      runReplay?.hasEmptyBaseline(sessionId) &&
      isRunning(sessionId) &&
      (missingSession || (error as { status?: number }).status === 404)
    ) {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          type: "session_detail",
          data: {
            state: { sessionId, cwd: workspaceCwd, status: "active", turnCount: 0 },
            ...runReplay.snapshot(sessionId, []),
            running: true,
          },
        },
      });
    }
    return hostQueryError(
      message.id,
      -32001,
      error instanceof Error ? error.message : "Session not found",
    );
  }
}

/** A missing session can be created; malformed or unsafe existing storage must fail closed. */
function readOptionalHubSessionState(sessionManager: SessionManager, sessionId: string) {
  try {
    return readHubSessionState(sessionManager.getStorageDir(), sessionId);
  } catch (error) {
    if ((error as { status?: number }).status === 404 && !sessionManager.exists(sessionId)) {
      return undefined;
    }
    throw error;
  }
}

const SERVE_ALLOWED_WORKER_METHODS = new Set(["agent/run", "agent/approve", "agent/cancel"]);

/**
 * The no-account Web host deliberately exposes only the methods used by its
 * bundled SPA. Passcode possession grants control of this workspace, not raw
 * access to the worker's full local protocol surface.
 */
function authorizeServeRequest(
  message: {
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  },
  sessionManager: SessionManager,
  workspaceCwd: string,
  isRunning: (sessionId: string) => boolean = () => false,
): string | undefined {
  if (!message.method || !SERVE_ALLOWED_WORKER_METHODS.has(message.method)) {
    return hostQueryError(message.id ?? null, -32601, "Method is not available in Web serve mode");
  }

  const rawSessionId = message.params?.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
  if (message.method === "agent/run" && sessionId === null) return undefined;
  if (!sessionId) {
    return hostQueryError(message.id ?? null, -32602, "sessionId is required");
  }

  // A tracked run was already authorized for this host's forced workspace.
  // Stop must work even before Core publishes its first persistent state file.
  if (message.method === "agent/cancel" && isRunning(sessionId)) return undefined;

  try {
    const session = readOptionalHubSessionState(sessionManager, sessionId);
    if (session && resolve(session.cwd) === workspaceCwd) return undefined;
    if (!session && !sessionManager.exists(sessionId) && message.method === "agent/run")
      return undefined;
  } catch {
    // Invalid ids and unreadable existing records must not become new sessions.
  }
  return hostQueryError(message.id ?? null, -32001, "Session not found in this workspace");
}

function hostQueryError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** decodeURIComponent that returns null instead of throwing on bad input. */
function decodeSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
