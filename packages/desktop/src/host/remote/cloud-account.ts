import { AsyncLocalStorage } from "node:async_hooks";
import {
  CloudAccountManager,
  CloudAccountStore,
  type CloudAccountBrowserLogin,
  type CloudAccountGitHubLogin,
  type CloudAccountLogin,
  type CloudAccountLinksRequest,
  type CloudAccountProfileRequest,
} from "@cjhyy/code-shell-server/account";
import type { PrivateHostPeer } from "../native-peer.js";

export type AccountIdentity = { origin: string; accountId: string };
export type CloudAuthority = ReturnType<CloudAccountManager["nativeAuthority"]>;
export type CloudAction =
  | { op: "initialize" | "resume" | "linkGitHub" | "cancel" | "logout" }
  | { op: "capabilities"; origin: string }
  | { op: "login" | "register"; input: CloudAccountLogin }
  | { op: "browser"; input: CloudAccountBrowserLogin }
  | { op: "github"; input: CloudAccountGitHubLogin }
  | { op: "links"; input: CloudAccountLinksRequest }
  | { op: "profile"; input: CloudAccountProfileRequest }
  | { op: "overview"; identity: AccountIdentity }
  | { op: "credential"; identity: AccountIdentity; generation: number }
  | {
      op: "ticket";
      identity: AccountIdentity;
      generation: number;
      targetOrigin: string;
      installationId: string;
    };
export interface NativeCloudRequest {
  flow: string;
  action: CloudAction;
}

export class HostedCloudAccount {
  readonly manager: CloudAccountManager;
  private readonly scopes = new AsyncLocalStorage<{ flow: string; signal: AbortSignal }>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly peer: () => PrivateHostPeer,
    grantFile: string,
    request?: ConstructorParameters<typeof CloudAccountManager>[0]["request"],
  ) {
    const native = <T>(method: string, input?: unknown, signal?: AbortSignal) =>
      peer().call<T>(
        "cloud/" + method,
        { flow: this.scopes.getStore()?.flow, input },
        signal ?? this.lifetime.signal,
      );
    const publish = () => {
      if (!this.lifetime.signal.aborted)
        void native("changed", this.manager.nativeAuthority()).catch(() => {});
    };
    this.manager = new CloudAccountManager({
      request,
      store: CloudAccountStore.hosted(grantFile, {
        readSaved: () => native("readSaved"),
        seal: (grant) => native("seal", grant),
        checkKeyring: () => native("checkKeyring"),
      }),
      changed: publish,
      authorityChanged: publish,
      openExternal: (url) => native("openLogin", url, this.scopes.getStore()?.signal),
      prepareGitHubLink: async (signal, authorized) => {
        if (!authorized()) throw Error("GitHub 授权已取消。");
        const prepared = await native<{ id: string; authorizationUrl: string }>(
          "prepareLink",
          undefined,
          signal,
        );
        return {
          authorizationUrl: prepared.authorizationUrl,
          continue: (url) => native("continueLink", { id: prepared.id, url }, signal),
          cancel: () => {
            void native("cancelLink", { id: prepared.id }).catch(() => {});
          },
        };
      },
      activateRelay: async (identity, allowed) => {
        const lease = this.manager.captureRootAccount(identity.origin, identity.accountId, allowed);
        const flow = this.scopes.getStore();
        if (!flow) throw Error("Account activation unavailable");
        lease.current();
        await native("activate", identity, AbortSignal.any([lease.signal, flow.signal]));
      },
      retireRelay: (identity) => native("retire", identity),
    });
  }
  captureRootAccount(...args: Parameters<CloudAccountManager["captureRootAccount"]>) {
    return this.manager.captureRootAccount(...args);
  }
  run(raw: unknown, signal: AbortSignal) {
    const req = raw as NativeCloudRequest | undefined;
    if (!req || typeof req.flow !== "string" || !/^[a-f0-9-]{36}$/.test(req.flow) || !req.action)
      throw Error("Invalid account action");
    const { action, flow } = req,
      m = this.manager;
    const scoped = AbortSignal.any([signal, this.lifetime.signal]);
    scoped.throwIfAborted();
    const current = () => !scoped.aborted;
    return this.scopes.run({ flow, signal: scoped }, async () => {
      switch (action.op) {
        case "initialize":
          return m.nativeAuthority();
        case "resume":
          return m.resume(current);
        case "capabilities":
          return m.capabilities(action.origin, scoped);
        case "login":
        case "register":
          return m.signIn(action.op, action.input, current);
        case "browser":
          return m.signInWithBrowser(action.input, current);
        case "github":
          return m.signInWithGitHub(action.input, current);
        case "linkGitHub":
          return m.linkGitHub(current);
        case "links":
          return m.manageLinks(action.input, current);
        case "profile":
          return m.profile(action.input, current);
        case "overview":
          return m.overview(action.identity, current, scoped);
        case "cancel":
          return m.cancelSignIn();
        case "logout":
          return m.logout();
        case "credential":
        case "ticket": {
          if (
            action.generation !== m.nativeAuthority().generation ||
            typeof action.identity?.accountId !== "string"
          )
            throw Error("账号已变更。");
          const { origin, accountId } = action.identity;
          const lease = m.captureRootAccount(origin, accountId, current);
          const result =
            action.op === "ticket"
              ? await lease.ticket(action.targetOrigin, action.installationId)
              : await m.getCredential(origin, accountId, scoped);
          lease.current();
          return result;
        }
        default:
          throw Error("Unknown account action");
      }
    });
  }
  close() {
    this.lifetime.abort();
    this.manager.dispose();
  }
}
