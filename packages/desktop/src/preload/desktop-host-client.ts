import type { DesktopAgentMethod } from "../shared/desktop-agent-methods";
import {
  DesktopHostErrors,
  isRpcResponse,
  type RpcRequest,
  type RpcResponse,
} from "../shared/desktop-host-protocol";
import type { DesktopBusinessReads } from "../shared/desktop-business-contracts";
import type { TaskInboxApi, TaskInboxQuery } from "./task-inbox-api";
import { normalizeStreamEnvelope } from "../shared/stream-envelope";
import type { SessionSnapshot, StreamEventEnvelope } from "./session-stream-types";
import type { ApprovalRequestEnvelope } from "./types";
import type { DiskSessionListOptions } from "./session-transcript-api";
import type {
  CodeshellApi,
  DesktopHostStatus,
  LocalLinkProviderView,
  RpcResponse as AgentResponse,
} from "./types";

type OfflineStatus = Extract<DesktopHostStatus, "reconnecting" | "unavailable">;
type Listener = (status: DesktopHostStatus) => void;

const providerMethod = "links/listLocalProviders";
const replyDeadlineMs = 15_000;

// Each migrated domain keeps its original IPC handler available for rollback.
export const desktopHostRoutes: Record<
  "localLinkProviders" | "diskSessions" | "taskInbox" | "agentStream" | "configuration" | "agentCommands",
  "host" | "ipc"
> = {
  localLinkProviders: "host",
  diskSessions: "host",
  taskInbox: "host",
  configuration: "host",
  agentStream: "host",
  agentCommands: "host",
};

type PendingReply = {
  resolve: (value: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

function rpcError(code: number, message: string): Error {
  // contextBridge preserves the message even when a custom Error property is lost.
  return Object.assign(new Error(`${message} (${code})`), { code });
}

function supportsProviderCatalog(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const capabilities = result as Record<string, unknown>;
  const host = capabilities.host;
  return (
    capabilities.protocolVersion === "2.0" &&
    typeof host === "object" &&
    host !== null &&
    "kind" in host &&
    host.kind === "electron" &&
    "version" in host &&
    typeof host.version === "string" &&
    Array.isArray(capabilities.methods) &&
    capabilities.methods.includes(providerMethod)
  );
}

// The instance and its MessagePort live exclusively in the isolated preload world.
export class DesktopHostClient {
  private port?: MessagePort;
  private readonly methods = new Set<string>();
  private readonly negotiatedMethods = new Set<string>();
  private approvalRead = 0;
  private approvals?: { epoch: string; stateVersion: number; pending: ApprovalRequestEnvelope[] };
  private readonly streams = new Set<(envelope: StreamEventEnvelope) => void>();
  private status: DesktopHostStatus = "connecting";
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<number, PendingReply>();
  private nextId = 0;
  private initialPort?: Promise<MessagePort | undefined>;
  private finishStartup?: (port?: MessagePort) => void;
  private readonly startupTimeout: ReturnType<typeof setTimeout>;

  constructor(private readonly timeoutMs = replyDeadlineMs) {
    this.initialPort = new Promise((resolve) => {
      this.finishStartup = resolve;
    });
    this.startupTimeout = setTimeout(() => this.disconnect("unavailable"), timeoutMs);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async attach(port: MessagePort): Promise<void> {
    if (this.port) this.disconnect("reconnecting", DesktopHostErrors.revoked);
    else if (this.status === "unavailable") this.publish("reconnecting");
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (this.port !== port) return;
      if (
        this.status === "ready" &&
        this.methods.has("agent/subscribe") &&
        data &&
        typeof data === "object" &&
        "jsonrpc" in data &&
        data.jsonrpc === "2.0" &&
        !("id" in data) &&
        "method" in data &&
        data.method === "agent/streamEvent" &&
        "params" in data
      ) {
        const envelope = normalizeStreamEnvelope(data.params);
        if (envelope?.sessionId)
          for (const listener of this.streams) listener(envelope as StreamEventEnvelope);
        return;
      }
      if (!isRpcResponse(data) || typeof data.id !== "number") return;
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(data.id);
      request.resolve(data);
    };
    port.addEventListener("close", this.onPortLost);
    port.addEventListener("messageerror", this.onPortLost);
    port.start();

    try {
      const result = await this.request(port, "initialize", { protocolVersions: ["2.0"] });
      if (this.port !== port) return;
      if (!supportsProviderCatalog(result)) {
        this.disconnect("unavailable");
        return;
      }
      for (const method of (result as { methods: string[] }).methods) {
        this.methods.add(method);
        this.negotiatedMethods.add(method);
      }
      this.publish("ready");
    } catch {
      if (this.port === port) this.disconnect("unavailable");
    }
  }

  private readonly onPortLost = (event: Event): void => {
    if (this.port === event.currentTarget) this.disconnect("reconnecting");
  };

  disconnect(status: OfflineStatus, code: number = DesktopHostErrors.reconnecting): void {
    const port = this.port;
    this.port = undefined;
    this.methods.clear();
    if (code === DesktopHostErrors.revoked) this.approvals = undefined;
    if (port) {
      port.onmessage = null;
      port.removeEventListener("close", this.onPortLost);
      port.removeEventListener("messageerror", this.onPortLost);
      port.close();
    }
    const error = rpcError(code, `Desktop Host ${status}: connection closed`);
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    this.publish(status);
  }

  private publish(status: DesktopHostStatus): void {
    if (this.finishStartup) {
      clearTimeout(this.startupTimeout);
      this.finishStartup(status === "ready" ? this.port : undefined);
      this.finishStartup = undefined;
      this.initialPort = undefined;
    }
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        /* A detached page listener cannot interrupt the transport. */
      }
    }
  }

  async listLocalProviders(): Promise<LocalLinkProviderView[]> {
    // Calls made while the first document is loading may precede the initial port.
    // Once that attempt completes a disconnected call fails immediately, without replay.
    const port = this.initialPort ? await this.initialPort : this.port;
    if (!port || port !== this.port || this.status !== "ready") {
      throw rpcError(DesktopHostErrors.reconnecting, `Desktop Host ${this.status}`);
    }
    return (await this.request(port, providerMethod)) as LocalLinkProviderView[];
  }

  async listDiskSessions(
    options: DiskSessionListOptions,
    readIpc: CodeshellApi["listDiskSessions"],
  ) {
    return this.read("sessions/listDisk", { ...options }, () => readIpc(options));
  }

  listTasks(query: TaskInboxQuery | undefined, readIpc: TaskInboxApi["list"]) {
    return this.read("tasks/list", { ...query }, () => readIpc(query));
  }

  getTask(taskKey: string, readIpc: TaskInboxApi["get"]) {
    return this.read("tasks/get", { taskKey }, () => readIpc(taskKey));
  }

  onStreamEvent(listener: (envelope: StreamEventEnvelope) => void): () => void {
    this.streams.add(listener);
    return () => {
      this.streams.delete(listener);
    };
  }

  private async agentPort(
    method: "agent/subscribe" | "agent/pendingApprovals" | DesktopAgentMethod,
  ): Promise<MessagePort | undefined> {
    // Historical v1 Main handlers are a compatibility path for a Host that
    // never offered this capability. Once negotiated, keep its document grant.
    if (this.initialPort) await this.initialPort;
    if (this.status === "ready" && this.methods.has(method) && this.port) return this.port;
    if (this.negotiatedMethods.has(method))
      throw rpcError(DesktopHostErrors.reconnecting, `Desktop Host ${this.status}`);
    return undefined;
  }

  async agentCommand(
    method: DesktopAgentMethod,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    responseId: string,
    sendIpc: () => Promise<AgentResponse>,
  ): Promise<AgentResponse> {
    const port = await this.agentPort(method);
    if (!port) return sendIpc();
    const response = await this.exchange(port, method, params, timeoutMs);
    const error = response.error;
    if (
      error &&
      (error.code === DesktopHostErrors.revoked || error.code === DesktopHostErrors.reconnecting)
    )
      throw rpcError(error.code, error.message);
    return { ...response, id: responseId };
  }

  async subscribeSession(
    sessionId: string,
    sinceSeq: number | undefined,
    readIpc: () => Promise<SessionSnapshot>,
  ) {
    const port = await this.agentPort("agent/subscribe");
    if (!port) return readIpc();
    return (await this.request(port, "agent/subscribe", {
      sessionId,
      ...(sinceSeq === undefined ? {} : { sinceSeq }),
    })) as SessionSnapshot;
  }

  async pendingApprovals(
    readIpc: () => Promise<ApprovalRequestEnvelope[]>,
  ): Promise<ApprovalRequestEnvelope[]> {
    const port = await this.agentPort("agent/pendingApprovals");
    if (!port) return readIpc();
    const generation = ++this.approvalRead;
    const previous = this.approvals;
    const since = previous
      ? { epoch: previous.epoch, stateVersion: previous.stateVersion }
      : undefined;
    // External runtime approvals remain owned by their existing Main controller.
    const [state, legacy] = await Promise.all([
      this.request(port, "agent/pendingApprovals", since ? { since } : {}) as Promise<{
        epoch: string;
        stateVersion: number;
        pending?: ApprovalRequestEnvelope[];
      }>,
      readIpc(),
    ]);
    if (port !== this.port)
      throw rpcError(DesktopHostErrors.revoked, "Desktop Host approval state superseded");
    if (
      !state ||
      typeof state !== "object" ||
      typeof state.epoch !== "string" ||
      !state.epoch ||
      !Number.isSafeInteger(state.stateVersion) ||
      state.stateVersion < 0
    )
      throw new Error("Invalid Desktop Host approval revision");
    if (state.pending !== undefined && !Array.isArray(state.pending))
      throw new Error("Invalid Desktop Host approval snapshot");
    const pending = Array.isArray(state.pending)
      ? state.pending
      : previous?.epoch === state.epoch && previous.stateVersion === state.stateVersion
        ? previous.pending
        : undefined;
    if (
      !pending ||
      pending.some(
        (entry) => !entry || entry.source || typeof entry.requestId !== "string" || !entry.request,
      )
    )
      throw new Error("Invalid Desktop Host approval snapshot");
    const newest = this.approvals;
    if (
      this.approvalRead === generation &&
      (!newest || state.epoch !== newest.epoch || state.stateVersion >= newest.stateVersion)
    )
      this.approvals = { epoch: state.epoch, stateVersion: state.stateVersion, pending };
    return [...pending, ...legacy.filter((entry) => entry.source === "external-runtime")];
  }

  async readBusiness<K extends keyof DesktopBusinessReads>(
    method: K,
    params: DesktopBusinessReads[K]["params"],
    fallback: () => Promise<DesktopBusinessReads[K]["result"]>,
  ): Promise<DesktopBusinessReads[K]["result"]> {
    if (this.status === "ready" && this.port && this.methods.has(method))
      return (await this.request(this.port, method, params)) as DesktopBusinessReads[K]["result"];
    if (this.negotiatedMethods.has(method))
      throw rpcError(DesktopHostErrors.reconnecting, `Desktop Host ${this.status}`);
    return fallback();
  }

  private async read<T>(
    method: "sessions/listDisk" | "tasks/list" | "tasks/get",
    params: Record<string, unknown>,
    readIpc: () => Promise<T>,
  ): Promise<T> {
    if (this.status !== "ready" || !this.port || !this.methods.has(method)) return readIpc();
    try {
      return (await this.request(this.port, method, params)) as T;
    } catch (error) {
      // Keep the original session catalog's fallback for older Hosts. Revocation,
      // validation and application errors from the task Host are authoritative.
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === DesktopHostErrors.reconnecting ||
          (method === "sessions/listDisk" && error.code === -32601))
      )
        return readIpc();
      throw error;
    }
  }

  private async request(
    port: MessagePort,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.exchange(port, method, params, this.timeoutMs);
    if (response.error) throw rpcError(response.error.code, response.error.message);
    return response.result;
  }

  private exchange(
    port: MessagePort,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<RpcResponse> {
    const id = ++this.nextId;
    const request: RpcRequest = { jsonrpc: "2.0", id, method, ...(params && { params }) };
    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs <= 0
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(
                rpcError(
                  DesktopHostErrors.reconnecting,
                  `Desktop Host request timed out: ${method}`,
                ),
              );
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }
}

export function routeLocalProviders(
  client: DesktopHostClient | undefined,
  invokeIpc: () => Promise<LocalLinkProviderView[]>,
  route = desktopHostRoutes.localLinkProviders,
): () => Promise<LocalLinkProviderView[]> {
  return client && route === "host" ? () => client.listLocalProviders() : invokeIpc;
}
