// packages/server/src/serve/headless-server.ts
//
// Headless serve entry — the no-account web host (TODO「服务端部署 + Web
// Client（无账号体系）」Phase 1').
//
// Composition, all pre-existing parts:
//   - AccessPasscode        HTTP gate (challenge page) + WS `allows()`;
//                           passcode + remember-cookie is the ONLY access
//                           control — no AuthN/AuthZ, no users, by decision.
//   - WorkerBridgeCore      spawns/drives ONE agent-server-stdio worker.
//   - resolveSafe           path-traversal-safe static file resolution.
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
import { dirname, extname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "@cjhyy/code-shell-core";
import { AccessPasscode } from "../mobile-remote/access-passcode.js";
import { resolveSafe } from "../mobile-remote/mobile-static.js";
import { contentTypeFor } from "../static-files.js";
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
  const log: WorkerBridgeLog = opts.log ?? (() => {});
  const workspaceCwd = resolve(opts.cwd);
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
  if (opts.passcode) {
    passcode.set(opts.passcode);
  } else if (!passcode.isSet()) {
    generatedPasscode = randomBytes(6).toString("base64url");
    passcode.set(generatedPasscode);
  }

  const tabs = new Set<WebSocket>();
  const pendingWorkerResponses = new Map<
    string,
    { tab: WebSocket; originalId: string | number; tabId: number; insertedAt: number }
  >();
  const pendingResponsesByTab = new Map<number, number>();
  let nextTabId = 1;
  let nextWorkerRequestId = 1;
  const broadcast = (line: string): void => {
    for (const tab of tabs) {
      if (tab.readyState === tab.OPEN) tab.send(line);
    }
  };

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
      if (route.tabId === tabId) deletePendingWorkerResponse(requestId);
    }
  };

  const failPendingWorkerResponses = (message: string): void => {
    for (const { tab, originalId } of pendingWorkerResponses.values()) {
      if (tab.readyState !== tab.OPEN) continue;
      tab.send(hostQueryError(originalId, -32000, message));
    }
    pendingWorkerResponses.clear();
    pendingResponsesByTab.clear();
  };

  const pendingResponseReaper = setInterval(() => {
    const now = Date.now();
    for (const [requestId, route] of pendingWorkerResponses) {
      if (now - route.insertedAt < pendingResponseTtlMs) continue;
      deletePendingWorkerResponse(requestId);
      if (route.tab.readyState === route.tab.OPEN) {
        route.tab.send(hostQueryError(route.originalId, -32000, "agent worker response timed out"));
      }
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
      broadcast(line);
      return;
    }
    const route = pendingWorkerResponses.get(String(message.id));
    if (!route) {
      log("worker.response_dropped", { reason: "unknown request id", id: message.id });
      return;
    }
    deletePendingWorkerResponse(String(message.id));
    if (route.tab.readyState !== route.tab.OPEN) return;
    route.tab.send(JSON.stringify({ ...message, id: route.originalId }));
  };

  const bridge = new WorkerBridgeCore({
    entryPath: opts.workerEntryPath,
    execPath: opts.execPath,
    fallbackCwd: () => opts.cwd,
    buildEnv: () => ({
      ...process.env,
      CODE_SHELL_DATA_ROOT: workerDataRoot,
      ...(opts.workerCapabilityModules
        ? { CODE_SHELL_CAPABILITY_MODULES: opts.workerCapabilityModules }
        : {}),
    }),
    log,
    onStderr: (text) => log("worker.stderr", { text: previewLine(text) }),
    onExit: (info) => {
      failPendingWorkerResponses("agent worker stopped");
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

  const server: Server = createServer((req, res) => {
    // The passcode gate fronts EVERY route — same posture as the tunnel mode
    // of the mobile remote host. gate() renders the challenge page for HTML
    // navigations and sets the remember cookie on success.
    if (!passcode.gate(req, res)) return;
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws" || !passcode.allows(req as never)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const tabId = nextTabId++;
    wss.handleUpgrade(req, socket, head, (ws) => {
      tabs.add(ws);
      log("tab.connected", { tabs: tabs.size });
      ws.on("message", (data) => {
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
        const hostReply = replyToHostSessionQuery(parsed, sessionManager, workspaceCwd);
        if (hostReply) {
          ws.send(hostReply);
          return;
        }
        const policyReply = authorizeServeRequest(parsed, sessionManager, workspaceCwd);
        if (policyReply) {
          ws.send(policyReply);
          return;
        }
        // This host intentionally exposes one workspace. A browser must not be
        // able to escape it by supplying another cwd, and a missing cwd must
        // not silently become the worker's global no-repo conversation.
        const workerMessage =
          parsed.method === "agent/run"
            ? { ...parsed, params: { ...(parsed.params ?? {}), cwd: workspaceCwd } }
            : parsed;
        if (workerMessage.id === null) {
          ws.send(hostQueryError(null, -32600, "JSON-RPC request id must not be null"));
          return;
        }
        if (workerMessage.id !== undefined) {
          if ((pendingResponsesByTab.get(tabId) ?? 0) >= 64) {
            ws.send(
              hostQueryError(
                workerMessage.id,
                -32000,
                "too many pending agent worker requests for this tab",
              ),
            );
            return;
          }
          const workerRequestId = `serve-${tabId}-${nextWorkerRequestId++}`;
          pendingWorkerResponses.set(workerRequestId, {
            tab: ws,
            originalId: workerMessage.id,
            tabId,
            insertedAt: Date.now(),
          });
          pendingResponsesByTab.set(tabId, (pendingResponsesByTab.get(tabId) ?? 0) + 1);
          workerMessage.id = workerRequestId;
        }
        const workerLine = JSON.stringify(workerMessage);
        // Spawn-on-first-frame (idempotent): the browser's first request wakes
        // the worker, mirroring the renderer's spawn-on-agent/run semantics.
        bridge.ensureWorker(opts.cwd);
        bridge.injectWorkerMessage(workerLine, { origin: "serve", producer: "serve-ws" });
      });
      ws.on("close", () => {
        tabs.delete(ws);
        clearPendingWorkerResponsesForTab(tabId);
        log("tab.closed", { tabs: tabs.size });
      });
      ws.on("error", () => {
        tabs.delete(ws);
        clearPendingWorkerResponsesForTab(tabId);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8790, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8790);
  const url = `http://${host}:${port}`;
  log("serve.listening", { url });

  return {
    url,
    host,
    port,
    ...(generatedPasscode ? { generatedPasscode } : {}),
    passcode,
    bridge,
    tabCount: () => tabs.size,
    pendingResponseCount: () => pendingWorkerResponses.size,
    close: async () => {
      clearInterval(pendingResponseReaper);
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
): string | undefined {
  if (message.method !== "agent/query" || message.id === undefined) return undefined;
  const queryType = message.params?.type;
  if (queryType === "sessions") {
    const sessions = sessionManager
      .list()
      .filter((session) => resolve(session.cwd) === workspaceCwd)
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        startedAt: session.startedAt,
        model: session.model,
        status: session.status,
        turnCount: session.turnCount,
        ...(session.preview ? { preview: session.preview } : {}),
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
  try {
    const bundle = sessionManager.resume(sessionId);
    if (resolve(bundle.state.cwd) !== workspaceCwd) {
      return hostQueryError(message.id, -32001, "Session not found in this workspace");
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        type: "session_detail",
        data: { state: bundle.state, transcript: bundle.transcript.getEvents() },
      },
    });
  } catch (error) {
    return hostQueryError(
      message.id,
      -32001,
      error instanceof Error ? error.message : "Session not found",
    );
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

  try {
    const session = sessionManager.resume(sessionId).state;
    if (resolve(session.cwd) === workspaceCwd) return undefined;
  } catch {
    // A caller may choose the id for a brand-new run. Other methods must target
    // an already-persisted session owned by this workspace.
    if (message.method === "agent/run") return undefined;
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
