import { createHash, randomBytes } from "node:crypto";
import { isRelayOrigin, isRelayToken } from "@cjhyy/code-shell-server/remote-relay";
import type { CloudAccountLogin, CloudAccountStatus } from "../shared/cloud-account.js";
import {
  CloudAccountStore,
  validCloudAccountGrant,
  type SavedCloudAccount,
} from "./cloud-account-store.js";
import {
  CloudAccountHttpError,
  createCloudAccountTransport,
  type CloudAccountTransport,
} from "./cloud-account-http.js";

function requireOrigin(origin: unknown): asserts origin is string {
  if (!isRelayOrigin(origin) || origin.length > 2048)
    throw new Error("请输入完整的 HTTPS 云服务地址。");
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("云账号操作已取消。"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Optional cloud identity. Construction/status never initiate network activity. */
export class CloudAccountManager {
  private loaded = false;
  private saved?: SavedCloudAccount;
  private state: CloudAccountStatus["state"] = "signed-out";
  private generation = 0;
  private operation = new AbortController();
  private refresh?: Promise<string>;
  private refreshResponse?: Promise<unknown>;
  private readonly revocationResponses = new WeakSet<Promise<unknown>>();
  private readonly request: CloudAccountTransport;
  constructor(
    private readonly deps: {
      store: CloudAccountStore;
      request?: CloudAccountTransport;
      openExternal: (url: string) => Promise<void>;
      changed: (status: CloudAccountStatus) => void;
      /** Retire only this account's remote access; never local work or LAN. */
      retireRelay?: (identity: { origin: string; accountId: string }) => Promise<void>;
      now?: () => number;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    },
  ) {
    this.request = deps.request ?? createCloudAccountTransport();
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.saved = this.deps.store.load();
      this.state = this.saved ? "signed-in" : "signed-out";
    } catch {
      this.state = "storage-error";
    }
  }
  status(): CloudAccountStatus {
    this.load();
    return {
      state: this.state,
      ...(this.saved ? { origin: this.saved.origin, account: { ...this.saved.account } } : {}),
    };
  }
  private publish(state: CloudAccountStatus["state"]) {
    this.state = state;
    try {
      this.deps.changed(this.status());
    } catch {
      // A closing renderer cannot keep cloud authority alive.
    }
  }
  private invalidate() {
    this.generation++;
    this.operation.abort();
    this.operation = new AbortController();
    this.refresh = undefined;
    this.refreshResponse = undefined;
  }
  private current(generation: number, authorized: () => boolean) {
    if (generation !== this.generation || this.operation.signal.aborted || !authorized())
      throw new Error("云账号操作已取消。");
  }
  private async retire(saved?: SavedCloudAccount) {
    if (saved) await this.deps.retireRelay?.({ origin: saved.origin, accountId: saved.account.id });
  }
  private validGrant(value: unknown, origin: string): asserts value is SavedCloudAccount {
    if (
      !validCloudAccountGrant(value) ||
      value.kind === "device" ||
      (value.audience !== undefined && value.audience !== origin) ||
      value.accessTokenExpiresAt <= this.now() ||
      value.refreshTokenExpiresAt <= this.now()
    )
      throw new Error("云服务返回了无效的账号授权。");
  }
  private async complete(
    value: unknown,
    origin: string,
    generation: number,
    authorized: () => boolean,
  ) {
    this.validGrant(value, origin);
    try {
      this.current(generation, authorized);
    } catch (error) {
      void this.revoke({ ...value, origin });
      throw error;
    }
    const previous = this.saved;
    const next = { ...value, origin };
    try {
      this.deps.store.save(next);
    } catch (error) {
      void this.revoke(next);
      throw error;
    }
    this.saved = next;
    this.publish("signed-in");
    if (previous && previous.sessionId !== next.sessionId) void this.revoke(previous);
    return this.status();
  }
  private async revoke(
    saved: SavedCloudAccount,
    inFlightRefresh?: Promise<unknown>,
  ): Promise<boolean> {
    if (saved.refreshTokenExpiresAt <= this.now()) return true;
    try {
      let token = saved.accessToken;
      if (inFlightRefresh || saved.accessTokenExpiresAt <= this.now()) {
        const refreshed = await (inFlightRefresh ??
          this.request({
            origin: saved.origin,
            path: "/api/v1/account/refresh",
            body: { refreshToken: saved.refreshToken },
          }));
        this.validGrant(refreshed, saved.origin);
        if (refreshed.sessionId !== saved.sessionId || refreshed.account.id !== saved.account.id)
          return false;
        token = refreshed.accessToken;
      }
      await this.request({ origin: saved.origin, path: "/api/v1/account/logout", token, body: {} });
      return true;
    } catch {
      return false;
    }
  }
  private async prepare(origin: string) {
    requireOrigin(origin);
    this.load();
    this.deps.store.preflight();
    this.invalidate();
    const generation = this.generation;
    const signal = this.operation.signal;
    this.publish("signing-in");
    try {
      await this.retire(this.saved);
      this.current(generation, () => true);
      return { generation, signal };
    } catch (error) {
      if (generation === this.generation) this.publish(this.saved ? "signed-in" : "signed-out");
      throw error;
    }
  }
  async signIn(
    kind: "login" | "register",
    input: CloudAccountLogin,
    authorized: () => boolean = () => true,
  ): Promise<CloudAccountStatus> {
    if (
      !input ||
      typeof input.username !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(input.username.trim()) ||
      input.username.length > 128 ||
      typeof input.password !== "string" ||
      input.password.length < 12 ||
      input.password.length > 1024 ||
      (input.deviceName !== undefined &&
        (typeof input.deviceName !== "string" || input.deviceName.length > 100))
    )
      throw new Error("请填写账号名称和至少 12 位密码。");
    if (!authorized()) throw new Error("云账号操作已取消。");
    const { generation, signal } = await this.prepare(input.origin);
    try {
      const grant = await this.request({
        origin: input.origin,
        path: `/api/v1/account/${kind}`,
        body: {
          username: input.username.trim(),
          password: input.password,
          ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        },
        signal,
      });
      return await this.complete(grant, input.origin, generation, authorized);
    } finally {
      if (generation === this.generation && this.state === "signing-in")
        this.publish(this.saved ? "signed-in" : "signed-out");
    }
  }
  async linkGitHub(authorized: () => boolean = () => true): Promise<CloudAccountStatus> {
    this.load();
    const saved = this.saved;
    if (!saved || this.state !== "signed-in" || !authorized()) throw new Error("请先登录云账号。");
    const token = await this.getCredential(saved.origin, saved.account.id);
    if (!this.saved || this.saved.sessionId !== saved.sessionId || !authorized())
      throw new Error("云账号操作已取消。");
    return this.github({ origin: saved.origin }, authorized, { saved: this.saved, token });
  }
  signInWithGitHub(
    input: { origin: string; deviceName?: string },
    authorized: () => boolean = () => true,
  ) {
    return this.github(input, authorized);
  }
  private async github(
    input: { origin: string; deviceName?: string },
    authorized: () => boolean,
    link?: { saved: SavedCloudAccount; token: string },
  ): Promise<CloudAccountStatus> {
    if (!input || !authorized()) throw new Error("云账号操作已取消。");
    requireOrigin(input.origin);
    if (link) this.invalidate();
    const { generation, signal } = link
      ? { generation: this.generation, signal: this.operation.signal }
      : await this.prepare(input.origin);
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    let receipt: string | undefined;
    try {
      const status = (await this.request({
        origin: input.origin,
        path: "/api/v1/account/github/status",
        method: "GET",
        signal,
      })) as { enabled?: boolean };
      if (status?.enabled !== true) throw new Error("此云服务尚未配置 GitHub 登录。");
      const flow = (await this.request({
        origin: input.origin,
        path: "/api/v1/account/github/start",
        body: { codeChallenge, ...(link ? { mode: "link" } : {}) },
        ...(link ? { token: link.token } : {}),
        signal,
      })) as {
        authorizationUrl: string;
        receipt: string;
        expiresAt: number;
        pollIntervalMs: number;
      };
      const url = new URL(flow.authorizationUrl);
      if (
        url.origin !== "https://github.com" ||
        url.pathname !== "/login/oauth/authorize" ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("code_challenge") !== codeChallenge ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !isRelayToken(flow.receipt) ||
        !Number.isSafeInteger(flow.expiresAt) ||
        flow.expiresAt <= this.now() ||
        flow.expiresAt > this.now() + 15 * 60_000
      )
        throw new Error("GitHub 登录地址无效。");
      receipt = flow.receipt;
      this.current(generation, authorized);
      await this.deps.openExternal(url.href);
      while (this.now() < flow.expiresAt) {
        this.current(generation, authorized);
        const result = await this.request({
          origin: input.origin,
          path: "/api/v1/account/github/poll",
          body: {
            receipt,
            codeVerifier,
            ...(input.deviceName ? { deviceName: input.deviceName } : {}),
          },
          signal,
        });
        if ((result as { status?: string })?.status !== "pending") {
          if (link) {
            this.current(generation, authorized);
            const linked = result as { linked?: boolean; account?: { id?: string } };
            if (
              linked?.linked !== true ||
              linked.account?.id !== link.saved.account.id ||
              this.saved?.sessionId !== link.saved.sessionId
            )
              throw new Error("GitHub 关联未完成。");
            return this.status();
          }
          return await this.complete(result, input.origin, generation, authorized);
        }
        await (this.deps.sleep ?? wait)(
          Math.min(10_000, Math.max(1000, flow.pollIntervalMs || 1000)),
          signal,
        );
      }
      throw new Error("GitHub 登录已超时，请重试。");
    } finally {
      if (receipt)
        void this.request({
          origin: input.origin,
          path: "/api/v1/account/github/cancel",
          body: { receipt, codeVerifier },
        }).catch(() => {});
      if (generation === this.generation && this.state === "signing-in")
        this.publish(this.saved ? "signed-in" : "signed-out");
    }
  }
  cancelSignIn() {
    this.load();
    this.invalidate();
    this.publish(this.saved ? "signed-in" : "signed-out");
  }
  async logout() {
    this.load();
    const previous = this.saved;
    const inFlightRefresh = this.refreshResponse;
    if (inFlightRefresh) this.revocationResponses.add(inFlightRefresh);
    this.invalidate();
    this.saved = undefined;
    try {
      this.deps.store.forget();
      this.publish("signed-out");
    } catch {
      this.publish("storage-error");
    }
    let retireError: unknown;
    try {
      await this.retire(previous);
    } catch (error) {
      retireError = error;
    }
    const confirmed = previous ? await this.revoke(previous, inFlightRefresh) : true;
    if (retireError) throw retireError;
    if (this.state === "storage-error") throw new Error("无法移除账号登记，请检查文件权限后重试。");
    if (!confirmed)
      throw new Error("本机已退出；服务端未确认撤销，请联网后在账号会话管理中撤销此设备。");
  }
  /** Returns credentials only to main callers, for one exact service/account. */
  async getCredential(origin: string, accountId?: string, signal?: AbortSignal): Promise<string> {
    requireOrigin(origin);
    this.load();
    const saved = this.saved;
    if (
      this.state !== "signed-in" ||
      !saved ||
      saved.origin !== origin ||
      (accountId !== undefined && accountId !== saved.account.id)
    )
      throw new Error("请先登录此云服务的账号。");
    signal?.throwIfAborted();
    if (saved.refreshTokenExpiresAt <= this.now()) {
      await this.logout();
      throw new Error("云账号授权已过期，请重新登录。");
    }
    if (saved.accessTokenExpiresAt > this.now() + 30_000) return saved.accessToken;
    if (!this.refresh) {
      const generation = this.generation;
      const operationSignal = this.operation.signal;
      // A logout can await this one response to revoke the rotated token without
      // persisting it. Client cancellation fences use, not the bounded request.
      const response = this.request({
        origin,
        path: "/api/v1/account/refresh",
        body: { refreshToken: saved.refreshToken },
      });
      this.refreshResponse = response;
      const pending = (async () => {
        try {
          const grant = await response;
          this.validGrant(grant, origin);
          try {
            this.current(generation, () => this.saved === saved && !operationSignal.aborted);
          } catch (error) {
            if (!this.revocationResponses.has(response)) void this.revoke({ ...grant, origin });
            throw error;
          }
          if (grant.account.id !== saved.account.id || grant.sessionId !== saved.sessionId)
            throw new Error("云账号授权发生变化，请重新登录。");
          const next = { ...grant, origin };
          try {
            this.deps.store.save(next);
          } catch (error) {
            this.saved = undefined;
            this.publish("storage-error");
            await this.retire(saved);
            void this.revoke(next);
            throw error;
          }
          this.saved = next;
          this.publish("signed-in");
          return next.accessToken;
        } catch (error) {
          if (
            generation === this.generation &&
            error instanceof CloudAccountHttpError &&
            (error.status === 401 || error.status === 403)
          )
            await this.logout();
          throw error;
        }
      })();
      this.refresh = pending;
      void pending
        .finally(() => {
          if (this.refresh === pending) this.refresh = undefined;
          if (this.refreshResponse === response) this.refreshResponse = undefined;
        })
        .catch(() => {});
    }
    const token = await this.refresh;
    signal?.throwIfAborted();
    return token;
  }
}
