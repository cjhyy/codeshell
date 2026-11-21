import { isDesktopAgentMethod } from "../../shared/desktop-agent-methods.js";
import { rendererDiskSessionQuery, type ListSessions } from "../../shared/disk-session-query.js";
import { CONTRACTS } from "@cjhyy/code-shell-core/contracts";
import {
  DesktopHostErrors,
  isRpcRequest,
  type DesktopHostIdentity,
  type RpcRequest,
} from "../../shared/desktop-host-protocol.js";
import {
  HostPortAuthority,
  HostRevokedError,
  HostSessionAuthority,
  type HostRequestContext,
} from "./authority.js";

interface HostPort {
  on(
    event: "message",
    listener: (event: { data: unknown; ports: { close(): void }[] }) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export interface DesktopHostMethod {
  /** Allows an unowned row only when run verifies current, visible disk history. */
  readonly historyRead?: boolean;
  readonly admission?: boolean;
  /** A session-scoped method derives its scope from its validated arguments. */
  sessionId?(params: RpcRequest["params"]): string | undefined;
  /** Configuration views can be user/project-scoped or refer to a session. */
  optionalSessionId?(params: RpcRequest["params"]): string | undefined;
  run(context: HostRequestContext, params: RpcRequest["params"]): unknown;
}

interface Connection {
  port: HostPort;
  authority: HostPortAuthority;
  initialized: boolean;
  commits: Set<Int32Array>;
  pending: Map<RpcRequest["id"], HostRequestContext>;
  compatibilityReads: number;
}

export class InvalidParams extends Error {}
export class WorkerCommandError extends Error {
  constructor(readonly rpcError: { code: number; message: string; data?: unknown }) {
    super(rpcError.message);
  }
}

const catalog: DesktopHostMethod = {
  async run(context, params) {
    if (params !== undefined && Object.keys(params).length) throw new InvalidParams();
    const { listDesktopLinkProviders } = await import("../link-provider-catalog.js");
    context.assertCurrent();
    return listDesktopLinkProviders();
  },
};

export function desktopHostMethods(list: ListSessions): ReadonlyMap<string, DesktopHostMethod> {
  return new Map<string, DesktopHostMethod>([
    ["links/listLocalProviders", catalog],
    [
      "sessions/listDisk",
      {
        run(_context, params) {
          let options: ReturnType<typeof rendererDiskSessionQuery>;
          try {
            options = rendererDiskSessionQuery(params);
          } catch (error) {
            throw new InvalidParams(error instanceof Error ? error.message : undefined);
          }
          return list(options);
        },
      },
    ],
  ]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendError(
  port: HostPort,
  id: string | number | null,
  code: number,
  message: string,
): void {
  port.postMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Renderer messages have no authority to bind ports or choose the window
 * identity. These mutation methods are wired only to the trusted parent port. */
export class DesktopHostServer {
  private readonly windows = new Map<number, Connection>();
  private readonly sessions = new HostSessionAuthority();

  constructor(
    private readonly version: string,
    private readonly methods: ReadonlyMap<string, DesktopHostMethod>,
    private readonly changed?: () => void,
  ) {}

  bind(identity: DesktopHostIdentity, port: HostPort): void {
    const previous = this.windows.get(identity.webContentsId);
    if (previous && previous.authority.identity.frameGeneration >= identity.frameGeneration) {
      port.close();
      return;
    }
    if (previous) this.detach(previous);
    const connection: Connection = {
      port,
      authority: new HostPortAuthority(identity, this.sessions),
      initialized: false,
      commits: new Set(),
      pending: new Map(),
      compatibilityReads: 0,
    };
    this.windows.set(identity.webContentsId, connection);
    port.on("close", () => this.detach(connection));
    port.on("message", (event) => {
      // Renderer requests never transfer ports. In particular these cannot
      // register another renderer or forward the window's authority.
      if (event.ports.length) {
        for (const unexpected of event.ports) unexpected.close();
        this.detach(connection);
        return;
      }
      void this.receive(connection, event.data).catch(() => this.detach(connection));
    });
    port.start();
  }

  revoke(identity: DesktopHostIdentity): void {
    const connection = this.windows.get(identity.webContentsId);
    if (!connection) return;
    const bound = connection.authority.identity;
    if (
      bound.frameGeneration === identity.frameGeneration &&
      bound.frameToken === identity.frameToken
    ) {
      this.detach(connection);
    }
  }

  captureOperation(identity: DesktopHostIdentity, sessionId: string) {
    const connection = this.windows.get(identity.webContentsId);
    if (
      !connection ||
      connection.authority.identity.frameToken !== identity.frameToken ||
      connection.authority.identity.frameGeneration !== identity.frameGeneration
    )
      throw new HostRevokedError();
    return connection.authority.captureHistoryRead(sessionId, "operation");
  }

  /** Only the private parent pipe can reserve a one-shot write for a bound document.
   * The storage thread acquires it inside the transaction, after lock acquisition. */
  reserveDocumentCommit(identity: DesktopHostIdentity) {
    const conn = this.windows.get(identity.webContentsId);
    const bound = conn?.authority.identity;
    if (
      !conn ||
      !bound ||
      bound.frameToken !== identity.frameToken ||
      bound.frameGeneration !== identity.frameGeneration ||
      conn.commits.size >= 128
    )
      throw new HostRevokedError();
    const permit = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    conn.commits.add(permit);
    return { permit, release: () => conn.commits.delete(permit) };
  }

  allows(sessionId: string, owner: number): boolean {
    return this.sessions.allows(sessionId, owner);
  }
  async readWorkbenchOutput(
    identity: DesktopHostIdentity,
    params: Record<string, unknown>,
    method = "agent/subscribe",
  ): Promise<unknown> {
    if (method !== "agent/subscribe" && !isDesktopAgentMethod(method)) throw new InvalidParams();
    const connection = this.windows.get(identity.webContentsId);
    const bound = connection?.authority.identity;
    const handler = this.methods.get(method);
    if (
      !connection ||
      bound?.frameToken !== identity.frameToken ||
      bound.frameGeneration !== identity.frameGeneration ||
      !handler
    )
      throw new HostRevokedError();
    const sessionId = handler.sessionId?.(params);
    if (!sessionId && !handler.admission) throw new InvalidParams();
    if (connection.pending.size + connection.compatibilityReads >= 128)
      throw new Error("Too many pending Desktop Host requests");
    const guard = sessionId
      ? connection.authority.captureHistoryRead(sessionId, handler.admission)
      : connection.authority.capture();
    connection.compatibilityReads++;
    try {
      const result = await handler.run(guard, params);
      guard.assertCurrent();
      return result;
    } finally {
      guard.release?.();
      connection.compatibilityReads--;
    }
  }

  setOwner(sessionId: string, owner: number | null): void {
    this.sessions.setOwner(sessionId, owner);
    this.rejectRevoked();
  }

  setStreamView(sessionId: string, enabled: boolean): void {
    this.sessions.setStreamView(sessionId, enabled);
    this.rejectRevoked();
  }

  setDeleting(sessionId: string, deleting: boolean): void {
    this.sessions.setDeleting(sessionId, deleting);
    this.rejectRevoked();
  }

  /** Push to the current session owner only. No session subscription is
   * retained on the connection after its window loses ownership. */
  notifySession(sessionId: string, method: string, params: Record<string, unknown>): void {
    for (const connection of this.windows.values()) {
      if (!connection.initialized) continue;
      try {
        if (method === "agent/streamEvent") connection.authority.assertStreamAccess(sessionId);
        else connection.authority.capture(sessionId);
        connection.port.postMessage({ jsonrpc: "2.0", method, params });
      } catch (error) {
        if (!(error instanceof HostRevokedError)) this.detach(connection);
      }
    }
  }

  private detach(connection: Connection): void {
    const id = connection.authority.identity.webContentsId;
    if (this.windows.get(id) !== connection) return;
    this.windows.delete(id);
    connection.authority.revoke();
    this.changed?.();
    for (const permit of connection.commits) Atomics.compareExchange(permit, 0, 0, -1);
    connection.commits.clear();
    try {
      for (const id of connection.pending.keys()) {
        sendError(
          connection.port,
          id,
          DesktopHostErrors.revoked,
          "Desktop Host authority was revoked",
        );
      }
    } catch {
      // The peer may already have closed this port.
    } finally {
      for (const guard of connection.pending.values()) guard.release?.();
      connection.pending.clear();
      connection.port.close();
    }
  }

  private rejectRevoked(): void {
    this.changed?.();
    for (const connection of this.windows.values()) {
      for (const [id, guard] of connection.pending) {
        try {
          guard.assertCurrent();
        } catch {
          connection.pending.delete(id);
          guard.release?.();
          try {
            sendError(
              connection.port,
              id,
              DesktopHostErrors.revoked,
              "Desktop Host authority was revoked",
            );
          } catch {
            this.detach(connection);
          }
        }
      }
    }
  }

  private async receive(connection: Connection, raw: unknown): Promise<void> {
    const { port, pending, authority } = connection;
    if (this.windows.get(authority.identity.webContentsId) !== connection) return;
    if (!isRpcRequest(raw)) {
      if (record(raw) && !Object.hasOwn(raw, "id") && typeof raw.method === "string") return;
      const id = record(raw) ? raw.id : undefined;
      sendError(
        port,
        typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)) ? id : null,
        -32600,
        "Invalid request",
      );
      return;
    }
    const { id, method, params } = raw;
    if (pending.has(id)) {
      this.detach(connection);
      return;
    }
    if (method === "initialize") {
      if (!Array.isArray(params?.protocolVersions) || !params.protocolVersions.includes("2.0")) {
        sendError(port, id, -32602, "Desktop Host requires protocol 2.0");
        return;
      }
      connection.initialized = true;
      port.postMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2.0",
          contracts: CONTRACTS,
          host: { kind: "electron", version: this.version },
          methods: [...this.methods.keys()],
        },
      });
      return;
    }
    if (!connection.initialized) {
      sendError(port, id, -32600, "Initialize the Desktop Host port first");
      return;
    }
    const handler = this.methods.get(method);
    if (!handler) {
      sendError(port, id, -32601, "Method not found");
      return;
    }
    if (pending.size + connection.compatibilityReads >= 128) {
      sendError(port, id, -32001, "Too many pending Desktop Host requests");
      return;
    }
    let guard: HostRequestContext | undefined;
    try {
      const sessionId = handler.sessionId?.(params) ?? handler.optionalSessionId?.(params);
      if (
        handler.sessionId &&
        !(handler.admission && sessionId === undefined) &&
        (typeof sessionId !== "string" || !sessionId)
      )
        throw new InvalidParams();
      guard =
        (handler.historyRead || handler.admission) && sessionId
          ? authority.captureHistoryRead(sessionId, handler.admission ? "admission" : "output")
          : authority.capture(sessionId);
      pending.set(id, guard);
      const result = await handler.run(guard, params);
      guard.assertCurrent();
      port.postMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      // Revocation already delivered the error, and the peer may have reused
      // this id for a new request while the old handler finished its awaits.
      if (guard && pending.get(id) !== guard) return;
      if (error instanceof HostRevokedError)
        sendError(port, id, DesktopHostErrors.revoked, error.message);
      else if (error instanceof WorkerCommandError)
        port.postMessage({ jsonrpc: "2.0", id, error: error.rpcError });
      else if (error instanceof InvalidParams)
        sendError(port, id, -32602, error.message || "Invalid params");
      else sendError(port, id, -32603, "Desktop Host request failed");
    } finally {
      guard?.release?.();
      if (pending.get(id) === guard) pending.delete(id);
    }
  }
}
