import { DesktopHostErrors, isRpcResponse, type RpcRequest } from "../shared/desktop-host-protocol";
import type { DesktopHostStatus, LocalLinkProviderView } from "./types";

type OfflineStatus = Extract<DesktopHostStatus, "reconnecting" | "unavailable">;
type Listener = (status: DesktopHostStatus) => void;

const providerMethod = "links/listLocalProviders";
const replyDeadlineMs = 15_000;

// Each migrated domain keeps its original IPC handler available for rollback.
export const desktopHostRoutes: Record<"localLinkProviders", "host" | "ipc"> = {
  localLinkProviders: "host",
};

type PendingReply = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
      if (this.port !== port || !isRpcResponse(data) || typeof data.id !== "number") return;
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(data.id);
      if (data.error) request.reject(rpcError(data.error.code, data.error.message));
      else request.resolve(data.result);
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

  private request(
    port: MessagePort,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = ++this.nextId;
    const request: RpcRequest = { jsonrpc: "2.0", id, method, ...(params && { params }) };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop Host request timed out: ${method}`));
      }, this.timeoutMs);
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
