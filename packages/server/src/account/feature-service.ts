import {
  accountPublicOrigin,
  readAccountFeatures,
  resolveAccountFeatures,
  type AccountFeatureId,
  type AccountFeatureMap,
  type AccountFeatureSnapshot,
  type ResolveAccountFeaturesInput,
} from "@cjhyy/code-shell-web/account";
import {
  DEFAULT_CLOUD_ACCOUNT_ORIGIN,
  type CloudAccountStatus,
  type CloudAccountCapabilities,
  type CloudAccountOverview,
} from "./types.js";

export interface AccountFeatureAuthority {
  status(): CloudAccountStatus;
  onStatus(listener: (status: CloudAccountStatus) => void): () => void;
  capabilities(origin: string, signal?: AbortSignal): Promise<CloudAccountCapabilities>;
  overview(
    identity: { origin: string; accountId: string },
    authorized?: () => boolean,
    signal?: AbortSignal,
  ): Promise<CloudAccountOverview>;
}
/** Host-owned cache, bound to an account generation. Snapshot reads never perform I/O. */
export class AccountFeatureService {
  private origin: string;
  private subject = "";
  private generation = 0;
  private deployment?: AccountFeatureMap;
  private account?: AccountFeatureMap;
  private reachable = false;
  private controller?: AbortController;
  private inFlight?: Promise<AccountFeatureSnapshot>;
  private lastAttempt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly listeners = new Set<(snapshot: AccountFeatureSnapshot) => void>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly deps: {
      account: AccountFeatureAuthority;
      origin?: string;
      supported: readonly AccountFeatureId[];
      local?: (status: CloudAccountStatus) => ResolveAccountFeaturesInput["local"];
      now?: () => number;
    },
  ) {
    this.origin = deps.origin ?? DEFAULT_CLOUD_ACCOUNT_ORIGIN;
    // Desktop composes this before Electron ready; keep OS credential loading lazy.
    this.unsubscribe = deps.account.onStatus(() => {
      this.synchronize();
      this.publish();
      if (!this.disposed) void this.refresh();
    });
  }
  private synchronize() {
    const status = this.deps.account.status();
    const origin = status.origin ?? this.origin;
    const subject = JSON.stringify([origin, status.account?.id, status.state]);
    if (subject !== this.subject) {
      ++this.generation;
      this.controller?.abort();
      this.inFlight = undefined;
      if (origin !== this.origin) this.deployment = undefined;
      this.origin = origin;
      this.subject = subject;
      this.account = undefined;
      this.reachable = false;
      this.lastAttempt = 0;
    }
    return status;
  }
  snapshot(): AccountFeatureSnapshot {
    if (this.disposed) return resolveAccountFeatures({ signedIn: false, supported: [] });
    const status = this.synchronize();
    return this.resolve(status, this.deps.local?.(status));
  }
  private resolve(status: CloudAccountStatus, local?: ResolveAccountFeaturesInput["local"]) {
    return resolveAccountFeatures({
      deployment: this.deployment,
      account: this.account,
      signedIn: status.state === "signed-in" && !!status.account,
      supported: this.deps.supported,
      reachable: this.reachable,
      storageError: status.state === "storage-error",
      local,
    });
  }
  onChanged(listener: (snapshot: AccountFeatureSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* One detached host cannot stop others. */
      }
    }
  }
  localChanged() {
    if (!this.disposed) this.publish();
  }
  /** Checks remote entitlement before a setup action, independent of its local prerequisite. */
  requireEntitled(id: AccountFeatureId) {
    if (this.disposed) throw new Error("账号功能服务已关闭。");
    const status = this.synchronize();
    this.requireView(this.resolve(status)[id].state);
  }
  requireReady(id: AccountFeatureId) {
    this.requireView(this.snapshot()[id].state);
  }
  private requireView(state: string) {
    if (this.disposed) throw new Error("账号功能服务已关闭。");
    if (state === "sign-in") throw new Error("请先登录 CodeShell 账号。");
    if (state === "pending") throw new Error("账号功能尚未准备好，请检查连接后重试。");
    if (state !== "ready") throw new Error("当前账号服务未开放此功能。");
  }
  refresh(origin?: string, minIntervalMs = 0): Promise<AccountFeatureSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot());
    let status = this.synchronize();
    if (origin !== undefined) {
      if (!accountPublicOrigin(origin)) return Promise.reject(new Error("无效的账号服务地址。"));
      if (status.origin && status.state === "signed-in" && origin !== status.origin)
        return Promise.reject(new Error("请先退出当前账号，再切换账号服务。"));
      if (origin !== this.origin) {
        this.origin = origin;
        this.deployment = undefined;
        this.subject = "";
        status = this.synchronize();
        this.publish();
      }
    }
    if (this.inFlight) return this.inFlight;
    const now = this.deps.now?.() ?? Date.now();
    if (minIntervalMs > 0 && this.lastAttempt && now - this.lastAttempt < minIntervalMs)
      return Promise.resolve(this.snapshot());
    this.lastAttempt = now;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, 600_000);
      this.timer.unref?.();
    }
    const generation = this.generation;
    const targetOrigin = this.origin;
    const controller = new AbortController();
    this.controller = controller;
    const current = () =>
      !this.disposed && !controller.signal.aborted && generation === this.generation;
    const pending = Promise.resolve().then(async () => {
      try {
        const publicValue = await this.deps.account.capabilities(targetOrigin, controller.signal);
        if (!current()) return this.snapshot();
        const deployment = readAccountFeatures(publicValue);
        this.deployment = deployment;
        if (status.state === "signed-in" && status.account) {
          const value = await this.deps.account.overview(
            { origin: targetOrigin, accountId: status.account.id },
            current,
            controller.signal,
          );
          if (!current()) return this.snapshot();
          this.account = readAccountFeatures(value);
        } else this.account = undefined;
        this.reachable = true;
      } catch {
        if (current()) this.reachable = false;
      } finally {
        if (current()) {
          this.inFlight = undefined;
          this.publish();
        }
      }
      return this.snapshot();
    });
    this.inFlight = pending;
    return pending;
  }
  dispose() {
    this.disposed = true;
    this.reachable = false;
    this.account = undefined;
    this.deployment = undefined;
    this.inFlight = undefined;
    ++this.generation;
    this.controller?.abort();
    clearInterval(this.timer);
    this.unsubscribe();
    this.listeners.clear();
  }
}
