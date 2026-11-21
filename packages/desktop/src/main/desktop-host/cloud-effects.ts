import { randomUUID } from "node:crypto";
import type {
  CloudAccountManager,
  CloudAccountStore,
  PreparedGitHubLink,
  SavedCloudAccount,
} from "@cjhyy/code-shell-server/account";
import { isRelayHostId, isRelayOrigin, isRelayToken } from "@cjhyy/code-shell-server/remote-relay";
import type { AccountIdentity, CloudAction } from "../../host/remote/cloud-account.js";

export type CloudEffects = Pick<
  ConstructorParameters<typeof CloudAccountManager>[0],
  "openExternal" | "prepareGitHubLink" | "changed" | "retireRelay" | "activateRelay"
> & { custody: ReturnType<typeof CloudAccountStore.custody> };
export type NativeCloudFlow = {
  op: CloudAction["op"];
  origin?: string;
  combineGitHub: boolean;
  current: () => boolean;
  signal: AbortSignal;
};
function identity(raw: unknown) {
  const id = raw as AccountIdentity;
  if (!id || !isRelayOrigin(id.origin) || !isRelayHostId(id.accountId))
    throw Error("Invalid cloud identity");
  return id;
}

export class NativeCloudEffects {
  private prepared?: { id: string; link: PreparedGitHubLink; current: () => boolean };
  constructor(private readonly deps: CloudEffects) {}
  clear() {
    const previous = this.prepared;
    this.prepared = undefined;
    previous?.link.cancel();
  }
  changed(status: Parameters<CloudEffects["changed"]>[0]) {
    this.deps.changed(status);
  }
  async handle(
    method: string,
    raw: unknown,
    flow: NativeCloudFlow | undefined,
    signal: AbortSignal,
  ) {
    if (method === "cloud/readSaved") return this.deps.custody.readSaved();
    if (method === "cloud/checkKeyring") return this.deps.custody.checkKeyring();
    if (method === "cloud/seal") {
      // Background refresh must retain its rotated grant. Interactive commits also need the original document after the OS prompt.
      const ownsDocument =
        flow && ["login", "register", "browser", "github", "profile"].includes(flow.op);
      if (ownsDocument && !flow.current()) throw Error("云账号操作已取消。");
      const bytes = await this.deps.custody.seal(raw as SavedCloudAccount);
      signal.throwIfAborted();
      if (ownsDocument && !flow.current()) throw Error("云账号操作已取消。");
      return bytes;
    }
    if (method === "cloud/retire") return this.deps.retireRelay?.(identity(raw));
    if (method === "cloud/cancelLink" || method === "cloud/continueLink") {
      const p = this.prepared,
        req = raw as { id: string; url?: string };
      if (!p || !req || p.id !== req.id) throw Error("GitHub Link 授权已取消。");
      if (method === "cloud/cancelLink") return this.clear();
      if (!p.current() || typeof req.url !== "string") throw Error("GitHub Link 授权已取消。");
      const url = new URL(req.url);
      if (
        url.origin !== new URL(p.link.authorizationUrl).origin ||
        url.protocol !== "https:" ||
        url.pathname !== "/oauth/account-link/claim" ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams].length !== 1 ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("ticket") ?? "")
      )
        throw Error("GitHub Link 授权地址无效。");
      return p.link.continue(url.href);
    }
    if (!flow || !flow.current() || signal.aborted) throw Error("云账号操作已取消。");
    const live = () => !signal.aborted && flow.current();
    if (
      method === "cloud/activate" &&
      ["resume", "login", "register", "browser", "github"].includes(flow.op)
    )
      return this.deps.activateRelay?.(identity(raw), live);
    if (
      method === "cloud/prepareLink" &&
      flow.op === "github" &&
      flow.combineGitHub &&
      this.deps.prepareGitHubLink
    ) {
      if (this.prepared) throw Error("GitHub Link 授权进行中。");
      const link = await this.deps.prepareGitHubLink(AbortSignal.any([flow.signal, signal]), live);
      if (!live()) {
        link.cancel();
        throw Error("GitHub Link 授权已取消。");
      }
      const id = randomUUID();
      this.prepared = { id, link, current: flow.current };
      return { id, authorizationUrl: link.authorizationUrl };
    }
    if (method === "cloud/openLogin" && typeof raw === "string" && raw.length <= 16384) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw Error("登录地址无效。");
      if (
        flow.op === "browser" &&
        url.origin === flow.origin &&
        url.pathname === "/desktop-login" &&
        [...url.searchParams].length === 1 &&
        isRelayToken(url.searchParams.get("request"))
      )
        return this.deps.openExternal(url.href);
      if (
        (flow.op === "github" || flow.op === "linkGitHub") &&
        url.origin === "https://github.com" &&
        url.pathname === "/login/oauth/authorize" &&
        url.searchParams.get("code_challenge_method") === "S256" &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") &&
        (url.searchParams.get("scope") ?? "")
          .split(" ")
          .filter(Boolean)
          .every((s) => s === "read:user" || (s === "repo" && !!this.prepared))
      )
        return this.deps.openExternal(url.href);
    }
    throw Error("Cloud native operation unavailable");
  }
}
