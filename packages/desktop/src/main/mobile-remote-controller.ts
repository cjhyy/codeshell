import type {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  createDeviceRelayConnector,
  environmentIdentity,
  type DeviceRelayConnector,
} from "@cjhyy/code-shell-server/remote-relay";
import type {
  DesktopRelayEnrollment,
  DesktopRelayState,
  DesktopRelayStatus,
} from "../shared/device-relay.js";
import type {
  MobileRemoteGatewayStatus,
  MobileRemoteOpenResult,
} from "./im-gateway-control-server.js";
import {
  enrollRelayComputer,
  enrollAccountRelayComputer,
  validateRelayEnrollment,
} from "./device-relay-enrollment.js";
import { DeviceRelayStore, type RelayRegistration } from "./device-relay-store.js";
import type { CloudAccountManager } from "./cloud-account-manager.js";
import {
  CloudAccountHttpError,
  createCloudAccountTransport,
  type CloudAccountTransport,
} from "./cloud-account-http.js";
import { validCloudAccountGrant } from "./cloud-account-store.js";

/** One owner for all three transports. Stop fences pending starts/enrollment immediately. */
export class MobileRemoteController {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private operation = new AbortController();
  private connector?: DeviceRelayConnector;
  private registration?: RelayRegistration;
  private loaded = false;
  private loadFailed = false;
  private state: DesktopRelayState = "unregistered";
  private disposed = false;
  private deviceRefresh?: Promise<string>;
  private deviceRefreshResponse?: Promise<unknown>;
  private deviceAuthority = 0;
  private accountEnrollment?: { origin: string; accountId: string };
  constructor(
    private readonly deps: {
      host: RemoteHostManager;
      tunnel: TunnelManager;
      binary: CloudflaredBinary;
      passcode: AccessPasscode;
      store: DeviceRelayStore;
      environmentDir: string;
      changed: (status: DesktopRelayStatus) => void;
      account?: CloudAccountManager;
      accountRequest?: CloudAccountTransport;
      connectorFactory?: typeof createDeviceRelayConnector;
    },
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  private load() {
    if (this.loaded && !this.loadFailed) return;
    this.loaded = true;
    try {
      this.registration = this.deps.store.load();
      this.loadFailed = false;
      this.state = this.registration ? "stopped" : "unregistered";
    } catch {
      this.loadFailed = true;
      this.state = "storage-error";
    }
  }
  relayStatus(): DesktopRelayStatus {
    this.load();
    const data = this.registration;
    return {
      state: this.state,
      registered: !!data,
      ...(data
        ? {
            relayOrigin: data.relayOrigin,
            publicOrigin: data.publicOrigin,
            hostId: data.hostId,
            name: data.name,
            ...(data.accountId ? { accountId: data.accountId } : {}),
          }
        : {}),
    };
  }
  private publish(state: DesktopRelayState) {
    this.state = state;
    try {
      this.deps.changed(this.relayStatus());
    } catch {
      // Renderer shutdown cannot retain transport or credential authority.
    }
  }
  private invalidate() {
    this.generation++;
    this.operation.abort();
    this.operation = new AbortController();
    // close() fences before awaiting its owned sockets; Host stop aborts its target too.
    void this.connector?.close().catch(() => {});
  }
  private async closeTransport() {
    const connector = this.connector;
    this.connector = undefined;
    await connector?.close();
    await Promise.all([this.deps.tunnel.stop(), this.deps.host.stop()]);
    if (this.registration && this.state !== "storage-error") this.publish("stopped");
  }
  enroll(input: DesktopRelayEnrollment, authorized: () => boolean): Promise<DesktopRelayStatus> {
    validateRelayEnrollment(input);
    this.deviceAuthority++;
    this.deviceRefresh = undefined;
    this.deviceRefreshResponse = undefined;
    this.invalidate();
    const generation = this.generation;
    const signal = this.operation.signal;
    return this.serial(async () => {
      if (this.disposed || generation !== this.generation || !authorized())
        throw new Error("登记已取消。");
      await this.closeTransport();
      this.load();
      this.deps.store.preflight();
      const environmentId = await environmentIdentity(this.deps.environmentDir);
      if (signal.aborted || !authorized()) throw new Error("登记已取消。");
      // Re-enrollment rotates the server credential. Forget the old value before
      // sending; an ambiguous response must never resurrect invalid authority.
      this.deps.store.forget();
      this.registration = undefined;
      this.publish("unregistered");
      let result: RelayRegistration | undefined;
      try {
        if (input.authorization === "account") {
          const account = this.deps.account?.status();
          if (
            account?.state !== "signed-in" ||
            !account.account ||
            account.origin !== input.relayOrigin
          )
            throw new Error("请先登录同一云服务的账号。");
          this.accountEnrollment = { origin: account.origin, accountId: account.account.id };
          const token = await this.deps.account!.getCredential(
            account.origin,
            account.account.id,
            signal,
          );
          result = await enrollAccountRelayComputer(
            input,
            environmentId,
            token,
            account.account.id,
            signal,
            this.deps.accountRequest ?? createCloudAccountTransport(),
          );
        } else result = await enrollRelayComputer(input, environmentId, signal);
        if (signal.aborted || !authorized()) throw new Error("登记已取消。");
        this.deps.store.save(result);
        this.registration = result;
        this.publish("stopped");
        return this.relayStatus();
      } catch {
        if (result?.accountId) void this.revokeAccountDevice(result);
        throw new Error(
          input.authorization === "account"
            ? "电脑登记未保存，请检查云账号和网络后重新登记；连接已停止。"
            : "登记未保存。请在目录页面生成新票据并重新登记；当前电脑连接已停止。",
        );
      } finally {
        this.accountEnrollment = undefined;
      }
    });
  }
  forget(): Promise<void> {
    const previous = this.registration;
    const refresh = this.deviceRefreshResponse;
    this.deviceAuthority++;
    this.deviceRefresh = undefined;
    this.deviceRefreshResponse = undefined;
    this.invalidate();
    return this.serial(async () => {
      await this.closeTransport();
      this.registration = undefined;
      this.loaded = true;
      this.loadFailed = false;
      try {
        this.deps.store.forget();
        this.publish("unregistered");
      } catch {
        this.publish("storage-error");
        throw new Error("无法移除本机登记，请检查文件权限后重试。");
      } finally {
        if (previous?.accountId) void this.revokeAccountDevice(previous, refresh);
      }
    });
  }
  start(opts?: { mode?: "lan" | "tunnel" | "relay" }): Promise<MobileRemoteOpenResult> {
    const mode = opts?.mode ?? "lan";
    if (!["lan", "tunnel", "relay"].includes(mode))
      return Promise.reject(new Error("无效的远程连接方式。"));
    const generation = this.generation;
    const signal = this.operation.signal;
    return this.serial(async () => {
      if (this.disposed || signal.aborted || generation !== this.generation)
        throw new Error("远程启动已取消。");
      this.load();
      const existing = this.status();
      if (existing.running && existing.mode === mode && existing.url) {
        return { url: existing.url, ...this.pairingUrl(), mode };
      }
      await this.closeTransport();
      if (signal.aborted) throw new Error("远程启动已取消。");
      try {
        if (mode !== "lan" && !this.deps.passcode.isSet())
          throw new Error("请先设置访问口令，再开启公网连接。");
        if (mode === "tunnel") {
          await this.deps.binary.ensureBinary();
          if (signal.aborted) throw new Error("远程启动已取消。");
        }
        if (mode === "relay" && !this.registration) throw new Error("请先登记这台电脑。");
        await this.deps.host.start(
          mode === "lan"
            ? { host: "lan", port: 0 }
            : {
                mode,
                host: "127.0.0.1",
                port: 0,
                passcode: this.deps.passcode,
              },
        );
        if (signal.aborted) throw new Error("远程启动已取消。");
        if (mode === "tunnel") {
          const started = await this.deps.tunnel.start(this.deps.host.status()!.port);
          if (signal.aborted) throw new Error("远程启动已取消。");
          this.deps.host.setPublicBaseUrl(started.url);
        } else if (mode === "relay") {
          await this.connectRelay(generation, signal);
        }
        return { url: this.status().url!, ...this.pairingUrl(), mode };
      } catch (error) {
        await this.closeTransport();
        throw error;
      }
    });
  }
  private connectRelay(generation: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("远程启动已取消。"));
      const timer = setTimeout(
        () => finish(new Error("目录暂时不可用，请检查连接后重试。")),
        15_000,
      );
      signal.addEventListener("abort", abort, { once: true });
      this.connector = (this.deps.connectorFactory ?? createDeviceRelayConnector)({
        ...this.registration!,
        ...(this.registration?.accountId
          ? {
              getCredential: (credentialSignal: AbortSignal) =>
                this.accountDeviceCredential(credentialSignal),
            }
          : {}),
        localHost: this.deps.host.relayTarget(),
        onState: (state) => {
          if (generation !== this.generation || state === "closed") return;
          this.publish(state);
          if (state === "ready") finish();
          if (state === "unauthorized") {
            this.registration = undefined;
            try {
              this.deps.store.forget();
            } catch {
              this.publish("storage-error");
            }
            this.publish(this.state === "storage-error" ? "storage-error" : "unauthorized");
            finish(new Error("电脑登记已被撤销或替换，请使用新票据重新登记。"));
            // Running connections have already resolved start: retire their Host
            // without queuing behind that earlier start promise.
            void this.stop().catch(() => this.publish("disconnected"));
          }
        },
      });
      this.connector.start();
    });
  }
  /** Account logout must not stop an unrelated LAN/tunnel Host or local tasks. */
  retireAccountRelay(identity: { origin: string; accountId: string }): Promise<void> {
    this.load();
    const matches =
      this.registration?.relayOrigin === identity.origin &&
      this.registration?.accountId === identity.accountId;
    const enrolling =
      this.accountEnrollment?.origin === identity.origin &&
      this.accountEnrollment?.accountId === identity.accountId;
    if (!matches && !enrolling) return Promise.resolve();
    this.deviceAuthority++;
    this.deviceRefresh = undefined;
    this.deviceRefreshResponse = undefined;
    if (enrolling || this.deps.host.status()?.mode === "relay") this.invalidate();
    return this.serial(async () => {
      if (this.deps.host.status()?.mode === "relay") await this.closeTransport();
      if (
        this.registration?.relayOrigin !== identity.origin ||
        this.registration?.accountId !== identity.accountId
      )
        return;
      this.registration = undefined;
      try {
        this.deps.store.forget();
        this.publish("unregistered");
      } catch {
        this.publish("storage-error");
        throw new Error("无法移除账号的电脑授权，请检查文件权限。");
      }
    });
  }
  private async accountDeviceCredential(signal: AbortSignal): Promise<string> {
    const registration = this.registration;
    const account = this.deps.account?.status();
    if (
      !registration?.accountId ||
      account?.state !== "signed-in" ||
      account.origin !== registration.relayOrigin ||
      account.account?.id !== registration.accountId
    )
      throw new CloudAccountHttpError(401);
    signal.throwIfAborted();
    if (registration.credentialExpiresAt! > Date.now() + 30_000) return registration.credential;
    if (!this.deviceRefresh) {
      const authority = this.deviceAuthority;
      // A transport stop fences use but keeps a committed rotation recoverable.
      // Forget, account logout and re-enrollment retire this authority separately.
      const response = (this.deps.accountRequest ?? createCloudAccountTransport())({
        origin: registration.relayOrigin,
        path: "/api/v1/account/refresh",
        body: { refreshToken: registration.refreshToken },
      });
      this.deviceRefreshResponse = response;
      const pending = (async () => {
        const result = await response;
        if (
          !validCloudAccountGrant(result) ||
          result.kind !== "device" ||
          result.account.id !== registration.accountId ||
          result.hostId !== registration.hostId ||
          (result.audience !== undefined && result.audience !== registration.relayOrigin) ||
          result.accessTokenExpiresAt <= Date.now()
        )
          throw new CloudAccountHttpError(401);
        const next = {
          ...registration,
          credential: result.accessToken,
          refreshToken: result.refreshToken,
          credentialExpiresAt: result.accessTokenExpiresAt,
        };
        const current = this.deps.account?.status();
        if (
          authority !== this.deviceAuthority ||
          this.registration !== registration ||
          current?.state !== "signed-in" ||
          current.origin !== registration.relayOrigin ||
          current.account?.id !== registration.accountId
        ) {
          void this.revokeAccountDevice(next);
          throw new Error("电脑授权刷新已取消。");
        }
        try {
          this.deps.store.save(next);
        } catch {
          void this.revokeAccountDevice(next);
          throw new CloudAccountHttpError(401);
        }
        this.registration = next;
        return next.credential;
      })();
      this.deviceRefresh = pending;
      void pending
        .finally(() => {
          if (this.deviceRefresh === pending) this.deviceRefresh = undefined;
          if (this.deviceRefreshResponse === response) this.deviceRefreshResponse = undefined;
        })
        .catch(() => {});
    }
    const credential = await this.deviceRefresh;
    signal.throwIfAborted();
    return credential;
  }
  private async revokeAccountDevice(registration: RelayRegistration, refresh?: Promise<unknown>) {
    if (!registration.accountId) return;
    const request = this.deps.accountRequest ?? createCloudAccountTransport();
    try {
      let credential = registration.credential;
      if (refresh || registration.credentialExpiresAt! <= Date.now()) {
        const grant = await (refresh ??
          request({
            origin: registration.relayOrigin,
            path: "/api/v1/account/refresh",
            body: { refreshToken: registration.refreshToken },
          }));
        if (
          !validCloudAccountGrant(grant) ||
          grant.kind !== "device" ||
          grant.account.id !== registration.accountId ||
          grant.hostId !== registration.hostId
        )
          return;
        credential = grant.accessToken;
      }
      await request({
        origin: registration.relayOrigin,
        path: "/api/v1/account/logout",
        token: credential,
        body: {},
      });
    } catch {
      /* Local authority is already retired; server revocation/expiry remains authoritative. */
    }
  }
  stop(): Promise<void> {
    this.invalidate();
    return this.serial(async () => {
      await this.closeTransport();
      this.load();
      this.publish(this.registration ? "stopped" : this.state);
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    await this.deviceRefresh?.catch(() => {});
  }
  pairingUrl(): { pairingUrl: string; expiresAt: number } {
    if (!this.status().url) throw new Error("远程连接尚未就绪。");
    const pairing = this.deps.host.createPairingUrl();
    return { pairingUrl: pairing.url, expiresAt: pairing.expiresAt };
  }
  status(): MobileRemoteGatewayStatus {
    const status = this.deps.host.status();
    return {
      running: !!status,
      mode: status?.mode,
      url:
        status?.mode === "relay"
          ? this.state === "ready"
            ? this.registration?.publicOrigin
            : undefined
          : status?.mode === "tunnel"
            ? this.deps.tunnel.isConnected()
              ? this.deps.tunnel.publicUrl()
              : undefined
            : status?.url,
      tunnelRunning: this.deps.tunnel.isRunning(),
      tunnelConnected: this.deps.tunnel.isConnected(),
      passcodeSet: this.deps.passcode.isSet(),
      onlineDeviceCount: this.deps.host.onlineDeviceIds().length,
    };
  }
}
