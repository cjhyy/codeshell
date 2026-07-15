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
// The browser speaks the CORE protocol (agent/run, agent/approve,
// agent/streamEvent, …) as a first-party front end: this module is a thin
// WS ↔ worker-stdio pipe, NOT a re-implementation of the desktop mobile
// orchestrator. Every authenticated tab sees the identical line stream
// (same semantics as AgentBridge's renderer fan-out).
//
// Restart recovery: sessions persist on disk in the worker's data dir; a
// server restart spawns a fresh worker on the first inbound frame and the
// browser re-lists sessions over the same protocol.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
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
  close(): Promise<void>;
}

export async function startHeadlessServer(opts: HeadlessServeOptions): Promise<HeadlessServer> {
  const host = opts.host ?? "127.0.0.1";
  const log: WorkerBridgeLog = opts.log ?? (() => {});

  const passcode = new AccessPasscode({ filePath: join(opts.dataDir, "access.json") });
  let generatedPasscode: string | undefined;
  if (opts.passcode) {
    passcode.set(opts.passcode);
  } else if (!passcode.isSet()) {
    generatedPasscode = randomBytes(6).toString("base64url");
    passcode.set(generatedPasscode);
  }

  const tabs = new Set<WebSocket>();
  const broadcast = (line: string): void => {
    for (const tab of tabs) {
      if (tab.readyState === tab.OPEN) tab.send(line);
    }
  };

  const bridge = new WorkerBridgeCore({
    entryPath: opts.workerEntryPath,
    execPath: opts.execPath,
    fallbackCwd: () => opts.cwd,
    log,
    onStderr: (text) => log("worker.stderr", { text: previewLine(text) }),
    onExit: (info) => {
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
  bridge.subscribeLines(broadcast);

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

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws" || !passcode.allows(req as never)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      tabs.add(ws);
      log("tab.connected", { tabs: tabs.size });
      ws.on("message", (data) => {
        const line = String(data);
        // Validate framing before touching the worker: a malformed frame from
        // one tab must never kill the shared pipe.
        let parsed: { jsonrpc?: string } | undefined;
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
        // Spawn-on-first-frame (idempotent): the browser's first request wakes
        // the worker, mirroring the renderer's spawn-on-agent/run semantics.
        bridge.ensureWorker(opts.cwd);
        bridge.injectWorkerMessage(line);
      });
      ws.on("close", () => {
        tabs.delete(ws);
        log("tab.closed", { tabs: tabs.size });
      });
      ws.on("error", () => {
        tabs.delete(ws);
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
    close: async () => {
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

/** decodeURIComponent that returns null instead of throwing on bad input. */
function decodeSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
