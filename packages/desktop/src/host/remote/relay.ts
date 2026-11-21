import {
  createDeviceRelayConnector,
  type DeviceRelayConnectorOptions,
} from "@cjhyy/code-shell-server/remote-relay";
import type { PrivateHostPeer } from "../native-peer.js";

export type HostedRelayCredential = { state: "ok"; token: string } | { state: "unauthorized" };
export interface HostedRelayStart {
  id: string;
  relayOrigin: string;
  publicOrigin: string;
  hostId: string;
  localPort: number;
  rotating: boolean;
  pairing: boolean;
  credential?: string;
}

/** The only TCP target is the port of Main's already-listening relay Host on loopback. */
export class HostedRelay {
  private active?: {
    id: string;
    abort: AbortController;
    connector: ReturnType<typeof createDeviceRelayConnector>;
  };
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly create = createDeviceRelayConnector,
  ) {}
  async run(method: string, raw: unknown) {
    const req = raw as HostedRelayStart;
    if (!req || typeof req.id !== "string" || !/^[a-f0-9-]{36}$/.test(req.id))
      throw Error("Invalid relay generation");
    if (method === "relay/close") {
      if (this.active?.id === req.id) await this.close();
      return;
    }
    if (
      method !== "relay/start" ||
      this.active ||
      typeof req.rotating !== "boolean" ||
      typeof req.pairing !== "boolean" ||
      (req.pairing && !req.rotating)
    )
      throw Error("Relay unavailable");
    const abort = new AbortController(),
      peer = this.peer();
    const ask = <T>(method: string, input?: unknown, signal = abort.signal) =>
      peer.call<T>(method, { id: req.id, input }, signal);
    const options: DeviceRelayConnectorOptions = {
      hostId: req.hostId,
      relayOrigin: req.relayOrigin,
      publicOrigin: req.publicOrigin,
      ...(req.rotating
        ? {
            getCredential: async (signal: AbortSignal) => {
              const reply = await ask<HostedRelayCredential>(
                "relay/credential",
                undefined,
                AbortSignal.any([signal, abort.signal]),
              );
              if (reply?.state === "unauthorized")
                throw Object.assign(Error("Relay authorization expired"), { status: 401 });
              if (reply?.state !== "ok") throw Error("Relay credential unavailable");
              return reply.token;
            },
          }
        : { credential: req.credential }),
      ...(req.pairing && {
        issuePairing: () => ask<{ token: string; expiresAt: number }>("relay/pair"),
      }),
      localHost: {
        port: req.localPort,
        signal: abort.signal,
        setPublicBaseUrl: (url) => ask<void>("relay/bindOrigin", url),
      },
      onState: (state) => {
        if (!abort.signal.aborted) void ask("relay/state", state).catch(() => {});
      },
    };
    const connector = this.create(options);
    this.active = { id: req.id, abort, connector };
    try {
      connector.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    try {
      await active.connector.close();
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
