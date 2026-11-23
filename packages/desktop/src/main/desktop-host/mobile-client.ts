import { randomUUID } from "node:crypto";
import {
  isRelayOrigin,
  isRelayHostId,
  type RelayLocalTarget,
} from "@cjhyy/code-shell-server/remote-relay";
import type { GrantCustody } from "@cjhyy/code-shell-core/internal/storage";
import type { AccountRelayAccessProvider } from "@cjhyy/code-shell-server/mobile-remote";
import type { NativeCloudAccount } from "./cloud-client.js";
import type { PrivateHostPeer } from "../../host/native-peer.js";
import type { AccessIdentity, MobileAction, MobileOpened } from "../../host/remote/mobile.js";
import type { DesktopRelayEnrollment, DesktopRelayStatus } from "../../shared/device-relay.js";
import {
  localMobileGateway,
  type NativeGatewayResources,
  type MobileMode,
} from "../mobile-gateway.js";
import type { RelayRegistration } from "../device-relay-store.js";
import type { MobileRemoteOpenResult } from "../im-gateway-control-server.js";
import type { AccountIdentity } from "../../host/remote/cloud-account.js";

type Deps = NativeGatewayResources & {
  account: Pick<NativeCloudAccount, "status">;
  custody: GrantCustody<RelayRegistration>;
  changed: (status: DesktopRelayStatus) => void;
  listProjects?: AccountRelayAccessProvider["listProjects"];
};
type Scope = { action: MobileAction; signal: AbortSignal; current(): boolean };
export class NativeMobile {
  private readonly gateway;
  private saved: DesktopRelayStatus = { state: "unregistered", registered: false };
  private readonly scopes = new Map<string, Scope>();
  private lifetime = new AbortController();
  private active?: {
    id: string;
    mode: MobileMode;
    origin?: string;
    target?: RelayLocalTarget;
    access?: AccessIdentity;
  };
  private gatewayQueue: Promise<void> = Promise.resolve();
  private shutdown?: Promise<void>;
  private serializeGateway<T>(operation: () => Promise<T>) {
    const result = this.gatewayQueue.then(operation);
    this.gatewayQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly deps: Deps,
  ) {
    this.gateway = localMobileGateway(deps);
  }
  private gatewayStatus() {
    return this.gateway.status();
  }
  status() {
    const value = this.gatewayStatus();
    return value.mode === "relay"
      ? { ...value, url: this.saved.state === "ready" ? this.saved.publicOrigin : undefined }
      : value;
  }
  relayStatus() {
    return { ...this.saved };
  }
  changed(status: DesktopRelayStatus) {
    this.saved = status;
    try {
      this.deps.changed(this.relayStatus());
    } catch {
      // A closing window must not interrupt gateway retirement.
    }
  }
  async connect() {
    await this.call<DesktopRelayStatus>({ op: "initialize" });
    // Initialization also publishes after asynchronous decryption of the saved grant.
  }
  pairingUrl() {
    if (!this.status().url) throw Error("远程连接尚未就绪。");
    const pair = this.deps.host.createPairingUrl();
    return { pairingUrl: pair.url, expiresAt: pair.expiresAt };
  }
  private async call<T>(
    action: MobileAction,
    authorized = () => true,
    document?: AbortSignal,
  ): Promise<T> {
    const signal = document
      ? AbortSignal.any([this.lifetime.signal, document])
      : this.lifetime.signal;
    const current = () => !signal.aborted && authorized();
    if (!current()) throw Error("远程操作已取消。");
    const flow = randomUUID();
    this.scopes.set(flow, { action, signal, current });
    try {
      const result = await this.peer().call<T>(
        "mobile/request",
        { flow, action, snapshot: this.gatewayStatus() },
        signal,
      );
      if (!current()) throw Error("远程操作已取消。");
      return result;
    } finally {
      this.scopes.delete(flow);
    }
  }
  start(opts?: { mode?: MobileMode }, document?: AbortSignal) {
    return this.call<MobileRemoteOpenResult>(
      { op: "start", mode: opts?.mode ?? "lan" },
      undefined,
      document,
    );
  }
  stop() {
    return this.call<void>({ op: "stop" });
  }
  forget() {
    return this.call<void>({ op: "forget" });
  }
  enroll(input: DesktopRelayEnrollment, authorized: () => boolean, document?: AbortSignal) {
    return this.call<DesktopRelayStatus>({ op: "enroll", input }, authorized, document);
  }
  activateAccountRelay(identity: AccountIdentity, authorized: () => boolean) {
    return this.call<void>({ op: "activate", identity }, authorized);
  }
  retireAccountRelay(identity: AccountIdentity) {
    return this.call<void>({ op: "retire", identity });
  }
  private ownedAccount(access?: AccessIdentity) {
    const account = this.deps.account.status(),
      s = this.saved;
    return !!(
      access &&
      account.state === "signed-in" &&
      access.accountOrigin === account.origin &&
      access.accountId === account.account?.id &&
      s.registered &&
      s.hostId === access.hostId &&
      s.environmentId === access.environmentId &&
      s.accountId === access.accountId &&
      s.relayOrigin === account.origin
    );
  }
  async handle(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as { flow?: string; input?: any },
      scope = req?.flow ? this.scopes.get(req.flow) : undefined;
    const input = req?.input,
      lifetime = this.lifetime.signal;
    signal.throwIfAborted();
    if (method === "mobile/readSaved") return this.deps.custody.readSaved();
    if (method === "mobile/checkKeyring") return this.deps.custody.checkKeyring();
    if (method === "mobile/seal") {
      const check = () => {
        signal.throwIfAborted();
        lifetime.throwIfAborted();
        if (scope && !scope.current()) throw Error("远程操作已取消。");
      };
      check();
      const bytes = await this.deps.custody.seal(input);
      check();
      return bytes;
    }
    if (method === "mobile/open")
      return this.serializeGateway(async () => {
        lifetime.throwIfAborted();
        signal.throwIfAborted();
        const { mode, access, id, publicOrigin } = input ?? {};
        const explicit =
          scope?.action.op === "start" && scope.action.mode === mode && scope.current();
        const auto =
          mode === "relay" &&
          this.saved.remoteAccessEnabled === true &&
          this.ownedAccount(access) &&
          (!scope || scope.current());
        if (
          !["lan", "tunnel", "relay"].includes(mode) ||
          !isRelayHostId(id) ||
          !(explicit || auto) ||
          (access && !this.ownedAccount(access)) ||
          (mode === "relay" &&
            (!isRelayOrigin(publicOrigin) || this.saved.publicOrigin !== publicOrigin))
        )
          throw Error("本机网关启动权限无效。");
        const active: NonNullable<typeof this.active> = { id, mode, access, origin: publicOrigin };
        this.active = active;
        const peer = this.peer(),
          gate = AbortSignal.any([signal, lifetime, ...(scope ? [scope.signal] : [])]);
        const provider: AccountRelayAccessProvider | undefined = access && {
          hostId: access.hostId,
          environmentId: access.environmentId,
          accountId: access.accountId,
          accountOrigin: access.accountOrigin,
          listProjects: this.deps.listProjects ?? (async () => []),
          redeem: (handoff) => {
            if (this.active !== active || !this.ownedAccount(active.access))
              throw Error("设备中继授权已结束。");
            return peer.call("mobile/redeem", { id, handoff }, lifetime);
          },
        };
        try {
          await this.gateway.start(mode, provider, gate, publicOrigin);
          gate.throwIfAborted();
          if (this.active !== active || (scope && !scope.current()))
            throw Error("远程启动已取消。");
          if (mode === "relay") {
            const target = this.gateway.relayTarget();
            active.target = target;
            target.signal.addEventListener(
              "abort",
              () => peer.notify("mobile/targetEnded", { id }),
              {
                once: true,
              },
            );
          }
          return { status: this.gatewayStatus(), port: active.target?.port } satisfies MobileOpened;
        } catch (error) {
          if (this.active === active) this.active = undefined;
          await this.gateway.close();
          throw error;
        }
      });
    if (method === "mobile/closeLocal")
      return this.serializeGateway(async () => {
        lifetime.throwIfAborted();
        signal.throwIfAborted();
        const mode = this.gatewayStatus().mode;
        if (scope && !scope.current()) throw Error("远程操作已取消。");
        const explicit =
          scope && ["start", "stop", "forget", "enroll", "dispose"].includes(scope.action.op);
        if (mode && mode !== "relay" && !explicit && !this.shutdown)
          throw Error("需要本机工作台关闭此网关。");
        this.active = undefined;
        await this.gateway.close();
        return this.gatewayStatus();
      });
    const active = this.active;
    if (method === "mobile/withdraw") {
      if (active?.id === input?.id) {
        active!.access = undefined;
        this.gateway.withdraw();
      }
      return;
    }
    if (
      method === "mobile/bindOrigin" &&
      active?.target &&
      active.id === input?.id &&
      active.origin === input?.origin
    )
      return active.target.setPublicBaseUrl(active.origin!);
    if (method === "mobile/pair") {
      const explicit = scope?.action.op === "start" && scope.current();
      const automatic =
        active?.mode === "relay" &&
        this.ownedAccount(active.access) &&
        this.saved.state === "ready";
      if (
        (explicit || automatic) &&
        (active?.id === input?.id ||
          (scope?.action.op === "start" &&
            explicit &&
            this.gatewayStatus().mode === scope.action.mode))
      )
        return this.gateway.pair();
    }
    throw Error("Unknown or retired mobile gateway operation");
  }
  disconnect() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.scopes.clear();
    this.active = undefined;
    if (this.gatewayStatus().mode === "relay") {
      this.gateway.withdraw();
      void this.serializeGateway(() => this.gateway.close()).catch(() => {});
    }
    this.changed({ state: "disconnected", registered: false });
  }
  dispose() {
    return (this.shutdown ??= (async () => {
      try {
        await this.call<void>({ op: "dispose" });
      } finally {
        await this.serializeGateway(() => this.gateway.close());
      }
    })());
  }
}
