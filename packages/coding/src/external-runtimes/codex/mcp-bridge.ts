/**
 * Loopback HTTP MCP bridge: the reverse channel a Codex thread uses to call
 * CodeShell tools (§11.2).
 *
 * Shape and constraints are not guesswork — they were established against a real
 * `codex-cli 0.145.0` (probes in `docs/todo/evidence/`):
 *
 *  - Codex sends `accept: text/event-stream, application/json`. Answering with a
 *    plain JSON body makes it report `user cancelled MCP tool call` — a
 *    thoroughly misleading error that reads like a user refusal but is a
 *    transport mismatch. So: reply as SSE whenever the client will take it.
 *  - Thread identity arrives in the JSON-RPC body as `_meta.threadId` (and
 *    `_meta["x-codex-turn-metadata"].thread_id`), NOT in any HTTP header. The
 *    only headers present are `mcp-protocol-version`, `accept`, `authorization`.
 *  - `bearer_token_env_var` is a real, shipping Codex config surface, so the
 *    token goes through the environment and never onto a command line.
 *
 * Everything the model controls — tool name, arguments, call ordering — is
 * untrusted. Session identity is bound out of band via the thread context store.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { CodexThreadContextStore, ThreadContextMissReason } from "./thread-context-store.js";

/** What the bridge needs of a session tool host. Structural, so this module
 *  does not depend on core's concrete implementation. */
export interface BridgeToolHost {
  readonly businessSessionId: string;
  listTools(): readonly { name: string; description: string; inputSchema: unknown }[];
  execute(call: { id: string; name: string; input: unknown }): Promise<{
    result?: string;
    error?: string;
    isError?: boolean;
  }>;
}

export interface McpBridgeOptions {
  store: CodexThreadContextStore<BridgeToolHost>;
  /** Logical MCP server name Codex is configured with. */
  serverName?: string;
  /** Cap on a single request body. Prevents an oversized init/call. */
  maxBodyBytes?: number;
  /**
   * Structured log sink. Deliberately narrow: §12.4 forbids logging the bearer
   * token, full tool arguments, or full results, so only classifications and
   * identifiers get through here.
   */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface McpBridgeHandle {
  /** `http://127.0.0.1:<port>/mcp` — pass to Codex as `mcp_servers.<n>.url`. */
  readonly url: string;
  /** Value for the env var named by `mcp_servers.<n>.bearer_token_env_var`. */
  readonly token: string;
  readonly tokenEnvVar: string;
  close(): Promise<void>;
}

const MCP_PATH = "/mcp";
const DEFAULT_MAX_BODY = 1024 * 1024;
export const CODEX_MCP_TOKEN_ENV_VAR = "CODESHELL_CODEX_MCP_TOKEN";

/** Loopback only. A bridge that answers off-host would expose CodeShell tools
 *  to the network; §11.2 requires 127.0.0.1 / ::1 and nothing else. */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

export function threadIdFromMeta(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const direct = (meta as { threadId?: unknown }).threadId;
  if (typeof direct === "string" && direct) return direct;
  const turn = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
  if (turn && typeof turn === "object") {
    const nested = (turn as { thread_id?: unknown }).thread_id;
    if (typeof nested === "string" && nested) return nested;
  }
  return undefined;
}

function turnIdFromMeta(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const turn = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
  if (turn && typeof turn === "object") {
    const id = (turn as { turn_id?: unknown }).turn_id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** Model-facing text for a routing refusal. Says what happened without leaking
 *  which other sessions exist. */
function missMessage(reason: ThreadContextMissReason): string {
  switch (reason) {
    case "missing_thread_id":
      return "Refused: this tool call carried no thread identity, so it cannot be attributed to a session.";
    case "unknown_thread":
      return "Refused: this thread is not registered with the CodeShell host.";
    case "stale_generation":
      return "Refused: this thread belongs to a previous host generation and is no longer valid.";
    case "ambiguous_thread":
      return "Refused: a single batch may not span multiple threads.";
  }
}

export async function startCodexMcpBridge(options: McpBridgeOptions): Promise<McpBridgeHandle> {
  const token = randomBytes(32).toString("hex");
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const serverName = options.serverName ?? "codeshell_tools";
  const log = options.log ?? (() => {});
  const store = options.store;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log("bridge.handler_failed", { error: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req)) {
      log("bridge.rejected", { reason: "non_loopback" });
      res.writeHead(403).end();
      return;
    }
    if (req.url !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    // Constant-shape check; the token never reaches the log.
    if (req.headers.authorization !== `Bearer ${token}`) {
      log("bridge.rejected", { reason: "unauthorized" });
      res.writeHead(401).end();
      return;
    }

    const body = await readBody(req, maxBody);
    if (body === null) {
      log("bridge.rejected", { reason: "body_too_large" });
      res.writeHead(413).end();
      return;
    }
    if (body === "") {
      res.writeHead(202).end();
      return;
    }

    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      log("bridge.rejected", { reason: "malformed_json" });
      res.writeHead(400).end();
      return;
    }

    const reply = (result: unknown): void => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      // SSE when the client accepts it — see the module header; a plain JSON body
      // makes Codex report the call as user-cancelled.
      if (String(req.headers.accept ?? "").includes("text/event-stream")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    };

    if (message.method === "initialize") {
      reply({
        protocolVersion:
          (message.params as { protocolVersion?: string } | undefined)?.protocolVersion ??
          "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1" },
      });
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }

    if (message.method === "tools/list") {
      const resolved = store.resolve({
        threadId: threadIdFromMeta(message.params),
        generation: store.generation,
      });
      if (!resolved.ok) {
        // Advertise nothing rather than guessing whose tools to show. A wrong
        // guess here would leak one session's surface into another's prompt.
        //
        // Observed against real codex-cli 0.145.0: the FIRST `tools/list` of a
        // run carries no `_meta.threadId` at all (the thread does not exist
        // yet), so it necessarily lands here. Codex re-lists once the thread is
        // established and that second call routes normally — verified twice in
        // `docs/todo/evidence/e2e-codex-product-bridge.mjs`. An empty first
        // answer is therefore the correct, expected outcome and not a
        // misconfiguration.
        //
        // Consequence for §11.3: a shared bridge fundamentally cannot answer a
        // pre-thread `tools/list`. If a future Codex version stopped re-listing,
        // the model would never learn the tool exists — that is the point at
        // which §22.7 (one bridge per session, where the port itself identifies
        // the session) would have to be revisited.
        log("bridge.tools_list_refused", { reason: resolved.reason });
        reply({ tools: [] });
        return;
      }
      const tools = resolved.host.listTools().map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }));
      log("bridge.tools_list", {
        businessSessionId: resolved.host.businessSessionId,
        count: tools.length,
      });
      reply({ tools });
      return;
    }

    if (message.method === "tools/call") {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const threadId = threadIdFromMeta(message.params);
      const resolved = store.resolve({ threadId, generation: store.generation });
      if (!resolved.ok) {
        log("bridge.call_refused", {
          reason: resolved.reason,
          threadIdPrefix: threadId?.slice(0, 8),
        });
        reply({ content: [{ type: "text", text: missMessage(resolved.reason) }], isError: true });
        return;
      }
      const name = typeof params?.name === "string" ? params.name : "";
      const started = Date.now();
      // The host is the authorization boundary; the bridge only routes.
      const outcome = await resolved.host.execute({
        id: turnIdFromMeta(message.params) ?? `mcp-${randomBytes(6).toString("hex")}`,
        name,
        input: params?.arguments ?? {},
      });
      log("bridge.call", {
        businessSessionId: resolved.host.businessSessionId,
        threadIdPrefix: threadId?.slice(0, 8),
        toolName: name,
        resultStatus: outcome.isError ? "error" : "ok",
        durationMs: Date.now() - started,
      });
      reply({
        content: [{ type: "text", text: String(outcome.result ?? outcome.error ?? "") }],
        isError: Boolean(outcome.isError),
      });
      return;
    }

    reply({});
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    token,
    tokenEnvVar: CODEX_MCP_TOKEN_ENV_VAR,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return await new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        // Stop accumulating, but do NOT destroy the socket: the caller still has
        // to send 413. Tearing the connection down here surfaces as ECONNRESET,
        // which tells the client nothing about what went wrong.
        aborted = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (!aborted) resolve("");
    });
  });
}

/**
 * Codex CLI config flags that point a thread at this bridge. The token travels
 * by environment variable, never in argv (§12.2).
 */
export function codexBridgeConfigArgs(
  handle: McpBridgeHandle,
  serverName = "codeshell_tools",
): string[] {
  return [
    "-c",
    `mcp_servers.${serverName}.url="${handle.url}"`,
    "-c",
    `mcp_servers.${serverName}.bearer_token_env_var="${handle.tokenEnvVar}"`,
  ];
}
