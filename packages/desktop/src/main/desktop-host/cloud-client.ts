import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  CloudAccountManager,
  CloudAccountStatus,
  CloudAccountOverview,
  CloudAccountLogin,
  CloudAccountGitHubLogin,
  CloudAccountBrowserLogin,
  CloudAccountLinksRequest,
  CloudAccountProfileRequest,
  CloudAccountLinksResult,
  CloudAccountCapabilities,
  CloudAccountLogoutResult,
  CloudManagementTicket,
} from "@cjhyy/code-shell-server/account";
import type { PrivateHostPeer } from "../../host/native-peer.js";
import type {
  CloudAuthority,
  CloudAction,
  AccountIdentity,
} from "../../host/remote/cloud-account.js";
import { NativeCloudEffects, type CloudEffects, type NativeCloudFlow } from "./cloud-effects.js";

export class NativeCloudAccount {
  private readonly documents = new AsyncLocalStorage<AbortSignal>();
  private readonly listeners = new Set<(status: CloudAccountStatus) => void>();
  private readonly flows = new Map<string, NativeCloudFlow>();
  private readonly effects: NativeCloudEffects;
  private lifetime = new AbortController();
  private authority = new AbortController();
  private view?: CloudAuthority;
  constructor(
    private readonly peer: () => PrivateHostPeer,
    dependencies: CloudEffects,
  ) {
    this.effects = new NativeCloudEffects(dependencies);
  }
  withDocument<T>(signal: AbortSignal, callback: () => T) {
    signal.throwIfAborted();
    return this.documents.run(signal, callback);
  }
  async connect() {
    const signal = this.lifetime.signal;
    const state = await this.call<CloudAuthority>({ op: "initialize" });
    if (!signal.aborted) this.publish(state);
  }
  disconnect() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.authority.abort();
    this.authority = new AbortController();
    this.effects.clear();
    this.flows.clear();
    this.view = undefined;
    this.notify();
  }
  private notify() {
    const status = this.status();
    // A closing workbench may drop a notification while account state has already advanced.
    for (const notify of [() => this.effects.changed(status), ...this.listeners]) {
      try {
        notify(status);
      } catch {
        /* Other listeners still receive the transition. */
      }
    }
  }
  private publish(next: CloudAuthority) {
    if (!next || !Number.isSafeInteger(next.generation) || !Number.isSafeInteger(next.revision))
      throw Error("Invalid cloud status");
    if (this.view && this.view.revision >= next.revision) return;
    if (
      this.view?.generation !== next.generation ||
      this.view?.status.state !== next.status.state
    ) {
      this.authority.abort();
      this.authority = new AbortController();
    }
    this.view = next;
    this.notify();
  }
  async handle(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as { flow?: string; input?: unknown } | null;
    if (!req) throw Error("Invalid cloud callback");
    signal.throwIfAborted();
    if (method === "cloud/changed") return this.publish(req.input as CloudAuthority);
    if (method === "cloud/activate") {
      const expected = this.view?.status,
        requested = req.input as AccountIdentity | undefined;
      if (
        !expected ||
        expected.state !== "signed-in" ||
        !requested ||
        expected.origin !== requested.origin ||
        expected.account?.id !== requested.accountId
      )
        throw Error("账号已变更。");
    }
    return this.effects.handle(
      method,
      req.input,
      req.flow ? this.flows.get(req.flow) : undefined,
      signal,
    );
  }
  private async call<T>(
    action: CloudAction,
    allowed = () => true,
    extra?: AbortSignal,
  ): Promise<T> {
    const doc = this.documents.getStore();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(doc ? [doc] : []),
      ...(extra ? [extra] : []),
    ]);
    const current = () => !signal.aborted && allowed();
    if (!current()) throw Error("云账号操作已取消。");
    const flow = randomUUID();
    this.flows.set(flow, {
      op: action.op,
      origin: action.op === "browser" ? action.input.origin : undefined,
      combineGitHub: action.op === "github" && action.input.connectGitHub === true,
      current,
      signal,
    });
    try {
      const result = await this.peer().call<T>("cloud/account", { flow, action }, signal);
      if (!current()) throw Error("云账号操作已取消。");
      return result;
    } finally {
      this.flows.delete(flow);
    }
  }
  status(): CloudAccountStatus {
    return this.view ? structuredClone(this.view.status) : { state: "signed-out" };
  }
  onStatus(listener: (status: CloudAccountStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  capabilities(origin: string, signal?: AbortSignal) {
    return this.call<CloudAccountCapabilities>({ op: "capabilities", origin }, undefined, signal);
  }
  overview(identity: AccountIdentity, authorized?: () => boolean, signal?: AbortSignal) {
    return this.call<CloudAccountOverview>({ op: "overview", identity }, authorized, signal);
  }
  resume(authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op: "resume" }, authorized);
  }
  signIn(op: "login" | "register", input: CloudAccountLogin, authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op, input }, authorized);
  }
  signInWithBrowser(input: CloudAccountBrowserLogin, authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op: "browser", input }, authorized);
  }
  signInWithGitHub(input: CloudAccountGitHubLogin, authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op: "github", input }, authorized);
  }
  linkGitHub(authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op: "linkGitHub" }, authorized);
  }
  manageLinks(input: CloudAccountLinksRequest, authorized?: () => boolean) {
    return this.call<CloudAccountLinksResult>({ op: "links", input }, authorized);
  }
  profile(input: CloudAccountProfileRequest, authorized?: () => boolean) {
    return this.call<CloudAccountStatus>({ op: "profile", input }, authorized);
  }
  cancelSignIn() {
    this.authority.abort();
    this.authority = new AbortController();
    return this.call<void>({ op: "cancel" });
  }
  logout() {
    this.authority.abort();
    this.authority = new AbortController();
    return this.call<CloudAccountLogoutResult>({ op: "logout" });
  }
  captureRootAccount(
    origin: string,
    accountId: string,
    authorized: () => boolean,
  ): ReturnType<CloudAccountManager["captureRootAccount"]> {
    const signal = this.authority.signal;
    const generation = this.view?.generation;
    const current = () => {
      const view = this.view;
      if (
        signal.aborted ||
        !authorized() ||
        !view ||
        view.generation !== generation ||
        view.expiresAt <= Date.now() ||
        view.status.state !== "signed-in" ||
        view.status.origin !== origin ||
        view.status.account?.id !== accountId
      )
        throw Error("请先登录此云服务的账号。");
    };
    current();
    return {
      current,
      signal,
      ticket: async (targetOrigin, installationId) => {
        current();
        const result = await this.call<CloudManagementTicket>(
          {
            op: "ticket",
            identity: { origin, accountId },
            generation: generation!,
            targetOrigin,
            installationId,
          },
          authorized,
          signal,
        );
        current();
        return result;
      },
    };
  }
  async getCredential(origin: string, accountId: string, signal?: AbortSignal) {
    const lease = this.captureRootAccount(origin, accountId, () => true);
    const result = await this.call<string>(
      { op: "credential", identity: { origin, accountId }, generation: this.view!.generation },
      undefined,
      signal ? AbortSignal.any([signal, lease.signal]) : lease.signal,
    );
    lease.current();
    return result;
  }
  dispose() {
    this.disconnect();
    this.listeners.clear();
  }
}
