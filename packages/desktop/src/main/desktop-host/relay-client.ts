import { randomUUID } from "node:crypto";
import type {
  DeviceRelayConnector,
  DeviceRelayConnectorOptions,
  DeviceRelayState,
} from "@cjhyy/code-shell-server/remote-relay";
import type { PrivateHostPeer } from "../../host/native-peer.js";
import type { HostedRelayCredential, HostedRelayStart } from "../../host/remote/relay.js";

export class NativeRelayConnector {
  private active?: {
    id: string;
    options: DeviceRelayConnectorOptions;
    gone(): void;
    close(): Promise<void>;
  };
  constructor(private readonly peer: () => PrivateHostPeer) {}
  readonly create = (options: DeviceRelayConnectorOptions): DeviceRelayConnector => {
    let running: { id: string; peer: PrivateHostPeer; connected: boolean } | undefined;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      if (!running) return Promise.resolve();
      const entry = running;
      running = undefined;
      options.localHost.signal.removeEventListener("abort", abort);
      if (this.active?.id === entry.id) this.active = undefined;
      const stopped = entry.connected
        ? entry.peer.call<void>("relay/close", { id: entry.id })
        : Promise.resolve();
      closing = stopped.finally(() => {
        closing = undefined;
        options.onState?.("closed");
      });
      return closing;
    };
    const abort = () => {
      void close().catch(() => {});
    };
    return {
      start: () => {
        options.localHost.signal.throwIfAborted();
        if (running) return;
        if (this.active || closing) throw Error("Relay already running or closing");
        const entry = { id: randomUUID(), peer: this.peer(), connected: true };
        running = entry;
        this.active = {
          id: entry.id,
          options,
          close,
          gone: () => {
            entry.connected = false;
          },
        };
        options.localHost.signal.addEventListener("abort", abort, { once: true });
        const input: HostedRelayStart = {
          id: entry.id,
          hostId: options.hostId,
          relayOrigin: options.relayOrigin,
          publicOrigin: options.publicOrigin,
          localPort: options.localHost.port,
          rotating: !!options.getCredential,
          pairing: !!options.issuePairing,
          ...(!options.getCredential && { credential: options.credential }),
        };
        void entry.peer.call("relay/start", input).catch(() => {
          if (running === entry) options.onState?.("disconnected");
        });
      },
      close,
    };
  };
  async handle(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as { id?: string; input?: unknown } | null;
    const entry = this.active;
    if (!req || !entry || req.id !== entry.id) throw Error("Relay no longer active");
    const { options } = entry;
    const live = () => {
      signal.throwIfAborted();
      options.localHost.signal.throwIfAborted();
      if (this.active !== entry) throw Error("Relay no longer active");
    };
    live();
    if (method === "relay/state") {
      if (
        !["connecting", "disconnected", "unauthorized", "ready", "closed"].includes(
          String(req.input),
        )
      )
        throw Error("Invalid relay state");
      options.onState?.(req.input as DeviceRelayState);
      return;
    }
    if (method === "relay/bindOrigin" && req.input === options.publicOrigin)
      return options.localHost.setPublicBaseUrl(options.publicOrigin);
    if (method === "relay/credential" && options.getCredential) {
      try {
        const token = await options.getCredential(
          AbortSignal.any([signal, options.localHost.signal]),
        );
        live();
        return { state: "ok", token } satisfies HostedRelayCredential;
      } catch (error) {
        live();
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403)
          return { state: "unauthorized" } satisfies HostedRelayCredential;
        throw Error("Relay credential unavailable", { cause: error });
      }
    }
    if (method === "relay/pair" && options.issuePairing) {
      const issued = await options.issuePairing();
      live();
      return issued;
    }
    throw Error("Unknown relay callback");
  }
  disconnect() {
    const entry = this.active;
    this.active = undefined;
    if (!entry) return false;
    entry.gone();
    entry.options.onState?.("disconnected");
    void entry.close().catch(() => {});
    return true;
  }
}
