import { hostname } from "node:os";
import type {
  AccessPasscode,
  AccountRelayBinding,
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
import type { RelayRegistration } from "./device-relay-store.js";
import type { GrantStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { CloudAccountManager } from "./cloud-account-manager.js";
import {
  CloudAccountHttpError,
  createCloudAccountTransport,
  type CloudAccountTransport,
} from "./cloud-account-http.js";
import { validCloudAccountGrant } from "./cloud-account-store.js";
import { dlog } from "./desktop-logger.js";

/** One owner for all three transports. Stop fences pending starts/enrollment immediately. */
export class MobileRemoteController {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private operation = new AbortController();
  private connector?: DeviceRelayConnector;
  private registration?: RelayRegistration;
  private loaded = false;
  private loading?: Promise<void>;
  private grantWrites: Promise<void> = Promise.resolve();
  private loadFailed = false;
  private state: DesktopRelayState = "unregistered";
  private disposed = false;
  private deviceRefresh?: Promise<string>;
  private deviceRefreshResponse?: Promise<unknown>;
  private deviceAuthority = 0;
  private autoActivation?: Promise<void>;
  private availabilityMessage?: string;
  private autoRetry?: ReturnType<typeof setTimeout>;
  private accountEnrollment?: { origin: string; accountId: string };
  private pairingIssued: number[] = [];
  constructor(
    private readonly deps: {
      host: RemoteHostManager;
      tunnel: TunnelManager;
      binary: CloudflaredBinary;
      passcode: AccessPasscode;
      store: GrantStorage<RelayRegistration>;
      environmentDir: string;
      changed: (status: DesktopRelayStatus) => void;
      account?: CloudAccountManager;
      accountRequest?: CloudAccountTransport;
      connectorFactory?: typeof createDeviceRelayConnector;
      autoRetryDelayMs?: number;
      listProjects?: () => Promise<Array<{ id: string; name: string; path: string }>>;
      now?: () => number;
    },
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  private load(): Promise<void> | undefined {
    if (this.loading || (this.loaded && !this.loadFailed)) return this.loading;
    this.loaded = true;
    const receive = (registration: RelayRegistration | undefined) => {
      this.registration = registration;
      this.loadFailed = false;
      this.state = registration ? "stopped" : "unregistered";
    };
    const fail = () => {
      this.loadFailed = true;
      this.state = "storage-error";
    };
    try {
      const initial = this.deps.store.load();
      if (initial instanceof Promise) {
        this.loading = initial.then(receive, fail).finally(() => {
          if (!this.disposed) this.publish(this.state);
          this.loading = undefined;
        });
        return this.loading;
      }
      receive(initial);
    } catch {
      fail();
    }
  }

  private writeGrant(assertCurrent: () => void, build: () => RelayRegistration) {
    const write = this.grantWrites.then(async () => {
      assertCurrent();
      const next = build();
      await this.deps.store.save(next, assertCurrent);
      assertCurrent();
      this.registration = next;
      return next;
    });
    this.grantWrites = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  relayStatus(): DesktopRelayStatus {
    this.load();
    return this.relaySnapshot();
  }
  private relaySnapshot(): DesktopRelayStatus {
    const data = this.registration;
    return {
      state: this.state,
      registered: !!data,
      ...(this.availabilityMessage ? { message: this.availabilityMessage } : {}),
      ...(data
        ? {
            relayOrigin: data.relayOrigin,
            publicOrigin: data.publicOrigin,
            hostId: data.hostId,
            environmentId: data.environmentId,
            name: data.name,
            ...(data.accountId
              ? {
                  accountId: data.accountId,
                  remoteAccessEnabled: data.remoteAccessEnabled === true,
                }
              : {}),
          }
        : {}),
    };
  }
  private publish(state: DesktopRelayState) {
    this.state = state;
    try {
      this.deps.changed(this.relaySnapshot());
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
    clearTimeout(this.autoRetry);
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
      await this.load();
      await this.deps.store.preflight();
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
        await this.writeGrant(
          () => {
            if (signal.aborted || !authorized()) throw new Error("登记已取消。");
          },
          () => result!,
        );
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
  /** Login/resume binds this computer. Only the separately saved opt-in permits remote access. */
  activateAccountRelay(
    identity: { origin: string; accountId: string },
    authorized: () => boolean,
  ): Promise<void> {
    if (this.autoActivation)
      return this.autoActivation.then(() => {
        if (authorized()) return this.activateAccountRelay(identity, authorized);
      });
    const pending = this.activateAccountRelayOnce(identity, authorized);
    this.autoActivation = pending;
    void pending
      .finally(() => {
        if (this.autoActivation === pending) this.autoActivation = undefined;
      })
      .catch(() => {});
    return pending;
  }
  private async activateAccountRelayOnce(
    identity: { origin: string; accountId: string },
    authorized: () => boolean,
  ) {
    clearTimeout(this.autoRetry);
    const account = this.deps.account;
    const current = () => {
      const actual = account?.status();
      return (
        authorized() &&
        actual?.state === "signed-in" &&
        actual.origin === identity.origin &&
        actual.account?.id === identity.accountId
      );
    };
    if (!account || !current()) return;
    const activationGeneration = this.generation;
    let retryNetworkFailure = false;
    await this.load();
    if (this.disposed || activationGeneration !== this.generation || !current()) return;
    // Focus/account refresh may run while the connector is retrying. Its Host
    // and short-lived viewer grants remain valid; replacing them here would
    // turn a transient transport failure into a new authorization requirement.
    if (
      this.registration?.relayOrigin === identity.origin &&
      this.registration.accountId === identity.accountId &&
      this.registration.remoteAccessEnabled === true &&
      this.connector &&
      this.deps.host.status()?.mode === "relay" &&
      ["ready", "connecting", "disconnected"].includes(this.state)
    )
      return;
    this.availabilityMessage = undefined;
    try {
      retryNetworkFailure = true;
      const capabilities = await account.capabilities(identity.origin);
      retryNetworkFailure = false;
      if (!current()) return;
      if (!capabilities.relay?.enabled || capabilities.relay.directoryOrigin !== identity.origin) {
        this.availabilityMessage = "当前账号服务尚未提供设备中继，请升级服务；本地工作仍可使用。";
        this.publish("unavailable");
        throw new Error(this.availabilityMessage);
      }
      const environmentId = await environmentIdentity(this.deps.environmentDir);
      if (!current()) return;
      const saved = this.registration;
      if (
        saved &&
        (saved.relayOrigin !== identity.origin || saved.accountId !== identity.accountId)
      ) {
        // Login has already retired the previous account; never silently overwrite legacy authority.
        if (!saved.accountId) throw new Error("本机已有独立中继登记，请先移除后使用账号协作。");
        await this.retireAccountRelay({ origin: saved.relayOrigin, accountId: saved.accountId });
      }
      if (!current()) return;
      if (!this.registration) {
        await this.deps.store.preflight();
        if (!current() || activationGeneration !== this.generation) return;
        this.accountEnrollment = identity;
        const generation = this.generation;
        const signal = this.operation.signal;
        retryNetworkFailure = true;
        const credential = await account.getCredential(identity.origin, identity.accountId, signal);
        const result = await enrollAccountRelayComputer(
          {
            relayOrigin: identity.origin,
            authorization: "account",
            name: hostname().slice(0, 80) || "我的电脑",
          },
          environmentId,
          credential,
          identity.accountId,
          signal,
          this.deps.accountRequest ?? createCloudAccountTransport(),
          true,
        );
        retryNetworkFailure = false;
        if (!current() || generation !== this.generation || signal.aborted) {
          void this.revokeAccountDevice(result);
          return;
        }
        try {
          await this.writeGrant(
            () => {
              if (!current() || generation !== this.generation || signal.aborted)
                throw new Error("登记已取消。");
            },
            () => result,
          );
        } catch (error) {
          void this.revokeAccountDevice(result);
          throw error;
        }
        this.publish("stopped");
      }
      if (this.registration?.environmentId !== environmentId)
        throw new Error("本机设备身份与已有登记不匹配。");
      if (!current()) return;
      if (this.registration.remoteAccessEnabled !== true) {
        this.publish("stopped");
        return;
      }
      // Do not replace a running LAN/tunnel server when the user explicitly selected that transport.
      const active = this.deps.host.status();
      if (active && active.mode !== "relay") {
        this.availabilityMessage =
          "账号已登录；请先停止当前局域网或临时公网连接，再开启账号远程访问。";
        this.publish("unavailable");
        throw new Error(this.availabilityMessage);
      }
      retryNetworkFailure = true;
      await this.start({ mode: "relay" });
    } catch (error) {
      const unauthorized =
        this.state === "unauthorized" ||
        (error instanceof CloudAccountHttpError && [401, 403].includes(error.status));
      if (current()) {
        this.availabilityMessage ??=
          "暂时无法连接账号服务，正在自动重试。请检查网络和系统安全存储。";
        this.publish(
          this.loadFailed ? "storage-error" : unauthorized ? "unauthorized" : "unavailable",
        );
      }
      if (
        current() &&
        !this.disposed &&
        activationGeneration === this.generation &&
        retryNetworkFailure &&
        (!this.registration || this.registration.accountId === identity.accountId) &&
        !unauthorized &&
        (!(error instanceof CloudAccountHttpError) ||
          error.status === 429 ||
          error.status >= 500) &&
        !this.loadFailed
      ) {
        this.autoRetry = setTimeout(
          () => {
            if (current() && !this.disposed)
              void this.activateAccountRelay(identity, authorized).catch(() => {});
          },
          Math.max(1, this.deps.autoRetryDelayMs ?? 30_000),
        );
        this.autoRetry.unref?.();
      }
      throw error;
    } finally {
      if (this.accountEnrollment === identity) this.accountEnrollment = undefined;
    }
  }
  /** Main-only source proof binds dispatch rights to this registered computer as well as the root account. */
  async accountRelaySource(identity: { origin: string; accountId: string }, signal: AbortSignal) {
    await this.load();
    const saved = this.registration;
    if (!saved || saved.relayOrigin !== identity.origin || saved.accountId !== identity.accountId)
      throw new Error("正在同步这台电脑的账号，请稍后重试。联网后会自动完成。");
    const sourceDeviceCredential = await this.accountDeviceCredential(signal);
    signal.throwIfAborted();
    if (this.registration?.hostId !== saved.hostId) throw new Error("本机设备授权已更换。");
    return { sourceHostId: saved.hostId, sourceDeviceCredential };
  }
  private configureAccountAccess() {
    const registration = this.registration;
    if (!registration?.accountId) {
      this.deps.host.setAccountRelayAccess?.(undefined);
      return;
    }
    this.deps.host.setAccountRelayAccess?.({
      hostId: registration.hostId,
      environmentId: registration.environmentId,
      accountId: registration.accountId,
      accountOrigin: registration.relayOrigin,
      listProjects: this.deps.listProjects ?? (async () => []),
      redeem: async (handoff) => {
        try {
          const signal = this.operation.signal;
          const credential = await this.accountDeviceCredential(signal);
          const value = await (this.deps.accountRequest ?? createCloudAccountTransport())({
            origin: registration.relayOrigin,
            path: "/api/v1/remote-hosts/handoffs/redeem",
            token: credential,
            body: {
              handoff,
              hostId: registration.hostId,
              environmentId: registration.environmentId,
            },
            signal,
          });
          signal.throwIfAborted();
          if (this.registration?.hostId !== registration.hostId)
            throw new Error("设备授权已更换。");
          const binding =
            value && typeof value === "object"
              ? (value as Partial<AccountRelayBinding>)
              : undefined;
          // Only timing and a target-match boolean; never persist handoffs,
          // credentials, binding identifiers, response bodies, or error text.
          dlog("main", "mobile.account_relay.redeem_received", {
            ...(Number.isSafeInteger(binding?.expiresAt)
              ? { expiresInMs: binding!.expiresAt! - Date.now() }
              : {}),
            targetMatches:
              binding?.hostId === registration.hostId &&
              binding?.environmentId === registration.environmentId &&
              binding?.accountId === registration.accountId,
          });
          return value as AccountRelayBinding;
        } catch (error) {
          dlog("main", "mobile.account_relay.redeem_failed", {
            ...(error instanceof CloudAccountHttpError &&
            Number.isInteger(error.status) &&
            error.status >= 100 &&
            error.status <= 599
              ? { status: error.status }
              : {}),
          });
          throw error;
        }
      },
    });
  }
  forget(): Promise<void> {
    // A cold process still owns a persisted device grant. Unreadable storage
    // leaves no credential to revoke, but must not prevent deleting local state.
    const loading = this.load();
    const refresh = this.deviceRefreshResponse;
    clearTimeout(this.autoRetry);
    this.deviceAuthority++;
    this.deviceRefresh = undefined;
    this.deviceRefreshResponse = undefined;
    this.invalidate();
    return this.serial(async () => {
      if (loading) await loading;
      const previous = this.registration;
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
      await this.load();
      signal.throwIfAborted();
      await this.saveRemoteAccessPreference(mode === "relay", signal);
      signal.throwIfAborted();
      const existing = this.status();
      if (existing.running && existing.mode === mode && existing.url) {
        return { url: existing.url, ...this.pairingUrl(), mode };
      }
      await this.closeTransport();
      if (signal.aborted) throw new Error("远程启动已取消。");
      try {
        if (
          mode !== "lan" &&
          !(mode === "relay" && this.registration?.accountId) &&
          !this.deps.passcode.isSet()
        )
          throw new Error("请先设置访问口令，再开启公网连接。");
        if (mode === "tunnel") {
          await this.deps.binary.ensureBinary();
          if (signal.aborted) throw new Error("远程启动已取消。");
        }
        if (mode === "relay" && !this.registration)
          throw new Error("正在同步这台电脑的账号，请稍后重试。联网后会自动完成。");
        if (mode === "relay") this.configureAccountAccess();
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
        // Relay readiness is published by its connector. LAN and tunnel starts
        // must announce the running gateway too, or settings views in other
        // windows keep showing it closed until they remount.
        if (mode !== "relay") this.publish(this.state);
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
        ...(this.registration?.accountId ? { issuePairing: () => this.issueAccountPairing() } : {}),
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
            void this.stop().then(
              () => this.publish("unauthorized"),
              () => this.publish("unauthorized"),
            );
          }
        },
      });
      this.connector.start();
    });
  }
  /** Account logout must not stop an unrelated LAN/tunnel Host or local tasks. */
  retireAccountRelay(identity: { origin: string; accountId: string }): Promise<void> {
    const loading = this.load();
    if (loading) return loading.then(() => this.retireLoadedAccountRelay(identity));
    return this.retireLoadedAccountRelay(identity);
  }
  private retireLoadedAccountRelay(identity: { origin: string; accountId: string }): Promise<void> {
    const matches =
      this.registration?.relayOrigin === identity.origin &&
      this.registration?.accountId === identity.accountId;
    const enrolling =
      this.accountEnrollment?.origin === identity.origin &&
      this.accountEnrollment?.accountId === identity.accountId;
    if (!matches && !enrolling) return Promise.resolve();
    clearTimeout(this.autoRetry);
    this.deviceAuthority++;
    this.deviceRefresh = undefined;
    this.deviceRefreshResponse = undefined;
    if (enrolling || this.deps.host.status()?.mode === "relay") this.invalidate();
    this.deps.host.setAccountRelayAccess?.(undefined);
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
        const current = () => {
          const account = this.deps.account?.status();
          if (
            authority !== this.deviceAuthority ||
            this.registration?.credential !== registration.credential ||
            account?.state !== "signed-in" ||
            account.origin !== registration.relayOrigin ||
            account.account?.id !== registration.accountId
          )
            throw new Error("电脑授权刷新已取消。");
        };
        const rotated = {
          credential: result.accessToken,
          refreshToken: result.refreshToken,
          credentialExpiresAt: result.accessTokenExpiresAt,
        };
        let next: RelayRegistration;
        try {
          next = await this.writeGrant(current, () => ({ ...this.registration!, ...rotated }));
        } catch {
          void this.revokeAccountDevice({ ...registration, ...rotated });
          current();
          throw new CloudAccountHttpError(401);
        }
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
  /**
   * Pairing requested by the account relay for a phone its owner signed in on.
   * The phone still passes the computer passcode; this only replaces the QR scan.
   */
  private issueAccountPairing(): { token: string; expiresAt: number } {
    const registration = this.registration;
    const account = this.deps.account?.status();
    if (
      !registration?.accountId ||
      account?.state !== "signed-in" ||
      account.origin !== registration.relayOrigin ||
      account.account?.id !== registration.accountId ||
      this.state !== "ready"
    )
      throw new Error("account pairing unavailable");
    const now = this.deps.now?.() ?? Date.now();
    this.pairingIssued = this.pairingIssued.filter((at) => now - at < ACCOUNT_PAIRING_WINDOW_MS);
    if (this.pairingIssued.length >= ACCOUNT_PAIRING_LIMIT)
      throw new Error("account pairing rate limited");
    const pairing = this.deps.host.createPairingUrl();
    this.pairingIssued.push(now);
    return { token: pairing.token, expiresAt: pairing.expiresAt };
  }
  private async saveRemoteAccessPreference(enabled: boolean, signal: AbortSignal) {
    const saved = this.registration;
    if (!saved?.accountId || saved.remoteAccessEnabled === enabled) return;
    const authority = this.deviceAuthority;
    await this.writeGrant(
      () => {
        signal.throwIfAborted();
        if (authority !== this.deviceAuthority || this.registration?.hostId !== saved.hostId)
          throw new Error("电脑授权已变更。");
      },
      () => ({ ...this.registration!, remoteAccessEnabled: enabled }),
    );
    this.publish(this.state);
  }
  stop(preserveAccountPreference = false): Promise<void> {
    clearTimeout(this.autoRetry);
    this.invalidate();
    const signal = this.operation.signal;
    return this.serial(async () => {
      await this.closeTransport();
      const loading = this.load();
      if (loading) await loading;
      if (!preserveAccountPreference && !signal.aborted) {
        try {
          await this.saveRemoteAccessPreference(false, signal);
        } catch (error) {
          if (signal.aborted) return;
          const saved = this.registration;
          this.registration = undefined;
          try {
            this.deps.store.forget();
          } finally {
            this.publish("storage-error");
            if (saved) await this.revokeAccountDevice(saved, this.deviceRefreshResponse);
          }
          throw error;
        }
      }
      this.publish(this.registration ? "stopped" : this.state);
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop(true);
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

const ACCOUNT_PAIRING_LIMIT = 6;
const ACCOUNT_PAIRING_WINDOW_MS = 60_000;
