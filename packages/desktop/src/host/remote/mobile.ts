import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { custodiedGrantStore } from "@cjhyy/code-shell-core/internal/storage";
import type { CloudAccountManager } from "@cjhyy/code-shell-server/account";
import type { AccountRelayAccessProvider } from "@cjhyy/code-shell-server/mobile-remote";
import type { RelayLocalTarget } from "@cjhyy/code-shell-server/remote-relay";
import { MobileRemoteController } from "../../main/mobile-remote-controller.js";
import type { MobileGateway, MobilePair, MobileMode } from "../../main/mobile-gateway.js";
import type { MobileRemoteGatewayStatus } from "../../main/im-gateway-control-server.js";
import { validRegistration } from "../../main/device-relay-store.js";
import type { DesktopRelayEnrollment } from "../../shared/device-relay.js";
import type { PrivateHostPeer } from "../native-peer.js";
import type { AccountIdentity } from "./cloud-account.js";

export type MobileAction =
  | { op: "initialize" | "forget" | "stop" | "dispose" }
  | { op: "enroll"; input: DesktopRelayEnrollment }
  | { op: "start"; mode: MobileMode }
  | { op: "activate" | "retire"; identity: AccountIdentity };
export type AccessIdentity = Pick<
  AccountRelayAccessProvider,
  "accountId" | "accountOrigin" | "hostId" | "environmentId"
>;
export interface MobileOpened {
  status: MobileRemoteGatewayStatus;
  port?: number;
}
export const emptyGateway: MobileRemoteGatewayStatus = {
  running: false,
  tunnelRunning: false,
  tunnelConnected: false,
  passcodeSet: false,
  onlineDeviceCount: 0,
};

/** The Host owns the entire device grant, its rotation queue, and every outgoing relay socket. */
export class HostedMobile {
  readonly controller: MobileRemoteController;
  private readonly scopes = new AsyncLocalStorage<{ flow: string; signal: AbortSignal }>();
  private snapshot = emptyGateway;
  private active?: {
    id: string;
    gate: AbortController;
    access?: AccountRelayAccessProvider;
    port?: number;
    origin?: string;
  };
  private closing?: Promise<void>;
  constructor(
    private readonly peer: () => PrivateHostPeer,
    grantFile: string,
    environmentDir: string,
    account: CloudAccountManager,
  ) {
    const ask = <T>(method: string, input?: unknown, signal?: AbortSignal) =>
      peer().call<T>("mobile/" + method, { flow: this.scopes.getStore()?.flow, input }, signal);
    const gateway: MobileGateway = {
      status: () => this.snapshot,
      start: async (mode, access, signal, publicOrigin) => {
        const id = randomUUID(),
          active = {
            id,
            gate: new AbortController(),
            access,
            origin: publicOrigin,
            port: undefined as number | undefined,
          };
        this.active = active;
        try {
          const result = await ask<MobileOpened>(
            "open",
            {
              id,
              mode,
              publicOrigin,
              access: access && {
                hostId: access.hostId,
                environmentId: access.environmentId,
                accountId: access.accountId,
                accountOrigin: access.accountOrigin,
              },
            },
            signal,
          );
          signal.throwIfAborted();
          if (this.active !== active) throw Error("本机网关已结束。");
          active.port = result.port;
          this.snapshot = result.status;
        } catch (error) {
          this.end(id);
          throw error;
        }
      },
      close: async () => {
        this.end(this.active?.id);
        this.snapshot = await ask<MobileRemoteGatewayStatus>("closeLocal");
      },
      withdraw: () => {
        const active = this.active;
        if (!active) return;
        active.access = undefined;
        void ask("withdraw", { id: active.id }).catch(() => {});
      },
      relayTarget: () => {
        const active = this.active;
        if (!active?.port) throw Error("本机中继网关尚未启动。");
        return {
          port: active.port,
          signal: active.gate.signal,
          setPublicBaseUrl: (origin) => {
            if (origin !== active.origin) throw Error("设备中继地址已更换。");
            return ask<void>("bindOrigin", { id: active.id, origin }, active.gate.signal);
          },
        } satisfies RelayLocalTarget;
      },
      pair: () => ask<MobilePair>("pair", { id: this.active?.id }),
    };
    this.controller = new MobileRemoteController({
      account,
      environmentDir,
      gateway,
      store: custodiedGrantStore(
        grantFile,
        {
          readSaved: () => ask("readSaved"),
          seal: (grant) => ask("seal", grant),
          checkKeyring: () => ask("checkKeyring"),
        },
        validRegistration,
      ),
      changed: (status) => peer().notify("mobile/status", status),
    });
  }
  targetEnded(id?: string) {
    if (!id || this.active?.id !== id) return;
    this.end(id);
    // The native listener closed independently of a Host stop. Fence its connector
    // immediately; a saved account opt-in remains eligible on a later activation.
    void this.controller.stop(true).catch(() => {});
  }
  private end(id?: string) {
    if (!this.active || this.active.id !== id) return;
    this.active.gate.abort();
    this.active = undefined;
  }
  run(method: string, raw: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (method === "mobile/redeem") {
      const req = raw as { id: string; handoff: string };
      if (
        !this.active?.access ||
        req?.id !== this.active.id ||
        typeof req.handoff !== "string" ||
        req.handoff.length > 4096
      )
        throw Error("中继授权已结束。");
      return this.active.access.redeem(req.handoff);
    }
    const req = raw as { flow: string; snapshot: MobileRemoteGatewayStatus; action: MobileAction };
    if (
      method !== "mobile/request" ||
      !req?.action ||
      !req.snapshot ||
      typeof req.flow !== "string"
    )
      throw Error("Invalid mobile operation");
    this.snapshot = req.snapshot;
    const action = req.action,
      m = this.controller,
      current = () => !signal.aborted;
    return this.scopes.run({ flow: req.flow, signal }, async () => {
      switch (action.op) {
        case "initialize":
          return m.relayStatus();
        case "activate":
          return m.activateAccountRelay(action.identity, current);
        case "retire":
          return m.retireAccountRelay(action.identity);
        case "enroll":
          return m.enroll(action.input, current);
        case "start":
          return m.start({ mode: action.mode }, signal);
        case "stop":
          return m.stop();
        case "forget":
          return m.forget();
        case "dispose":
          return this.close();
        default:
          throw Error("Unknown mobile operation");
      }
    });
  }
  close() {
    return (this.closing ??= this.controller.dispose());
  }
}
