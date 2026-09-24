import type { LinkAuthorization } from "@cjhyy/code-shell-link";
import { api } from "./auth.js";
import { apiUrl, type ApiScope } from "./api-context.js";

const STORAGE_KEY = "codeshell.remote-link.authorization.v1";
const ROOT = "/api/v1/links/authorizations/";
const ID = "[a-f0-9-]{36}";
const TARGET = new RegExp(`^(?:/p/${ID})?${ROOT}${ID}$`);
interface PendingLink {
  target: string;
  state: string;
  redirectUri: string;
  returnUrl: string;
  expiresAt: number;
}
export type LinkCallback =
  | { callbackUrl: string; pending: PendingLink; denied: boolean }
  | { error: string; home?: string };

function callbackHome(path: string): string | undefined {
  return path === "/link/callback"
    ? "/"
    : path === "/mobile/link/callback"
      ? "/mobile/"
      : undefined;
}

/** OAuth navigation is HTTPS in production; development permits only explicit loopback. */
export function remoteLinkAuthorizationUrl(value: string, issuer: string): URL {
  const url = new URL(value),
    server = new URL(issuer);
  if (
    url.origin !== server.origin ||
    url.pathname !== "/oauth/authorize" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("授权地址无效，请检查 Link 服务配置。");
  return url;
}

export function rememberRemoteLink(
  job: LinkAuthorization,
  issuer: string,
  scope: ApiScope,
  origin = window.location.origin,
  storage: Pick<Storage, "setItem"> = window.sessionStorage,
): string {
  if (!job.redirect || !new RegExp(`^${ID}$`).test(job.id)) throw new Error("授权请求无效。");
  const authorization = remoteLinkAuthorizationUrl(job.redirect.authorizationUrl, issuer);
  const state = authorization.searchParams.get("state"),
    redirectUri = authorization.searchParams.get("redirect_uri");
  const expiresAt = Date.parse(job.redirect.expiresAt);
  const home = redirectUri ? callbackHome(new URL(redirectUri, origin).pathname) : undefined;
  if (
    !state ||
    !redirectUri ||
    !home ||
    redirectUri !== `${origin}${home}link/callback` ||
    (home === "/mobile/" && scope.projectId !== null) ||
    authorization.searchParams.getAll("state").length !== 1 ||
    authorization.searchParams.getAll("redirect_uri").length !== 1 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw new Error("授权回调地址或有效期无效，请检查服务配置。");
  const target = apiUrl(ROOT + job.id, scope.workspace, scope.projectId);
  const params = new URLSearchParams({
    view: "links",
    ...(scope.projectId ? { project: scope.projectId } : {}),
    ...(home === "/mobile/" ? { workspace: scope.workspace } : {}),
  });
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      target,
      state,
      redirectUri,
      returnUrl: `${home}?${params}`,
      expiresAt,
    } satisfies PendingLink),
  );
  return authorization.href;
}

/** Run once before mounting React. Remove authorization codes from history immediately. */
export function takeLinkCallback(
  location: Pick<Location, "pathname" | "href" | "origin">,
  history: Pick<History, "replaceState" | "state">,
  storage: Pick<Storage, "getItem" | "removeItem">,
): LinkCallback | undefined {
  const home = callbackHome(location.pathname);
  if (!home) return undefined;
  const callbackUrl = location.href;
  history.replaceState(history.state, "", location.pathname);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
    const pending = JSON.parse(raw ?? "null") as PendingLink | null;
    if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now())
      throw new Error();
    const callback = new URL(callbackUrl),
      target = new URL(pending.target, location.origin),
      back = new URL(pending.returnUrl, location.origin);
    if (
      pending.redirectUri !== `${location.origin}${location.pathname}` ||
      callback.origin !== location.origin ||
      callback.hash ||
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.get("state") !== pending.state ||
      target.origin !== location.origin ||
      !TARGET.test(target.pathname) ||
      target.hash ||
      target.username ||
      target.password ||
      [...target.searchParams.keys()].some((key) => key !== "workspace") ||
      target.searchParams.getAll("workspace").length > 1 ||
      back.origin !== location.origin ||
      back.pathname !== home ||
      back.username ||
      back.password ||
      back.hash ||
      [...back.searchParams.keys()].some(
        (key) => !(home === "/mobile/" ? ["workspace", "view"] : ["project", "view"]).includes(key),
      ) ||
      back.searchParams.getAll("view").length !== 1 ||
      back.searchParams.get("view") !== "links" ||
      (home === "/mobile/" &&
        (!target.pathname.startsWith(ROOT) ||
          back.searchParams.getAll("workspace").length !== 1 ||
          back.searchParams.get("workspace") !== (target.searchParams.get("workspace") ?? "")))
    )
      throw new Error();
    return { callbackUrl, pending, denied: callback.searchParams.has("error") };
  } catch {
    return { error: "找不到匹配的授权，或授权已过期。请返回原项目重新连接。", home };
  }
}

export async function completeLinkCallback(
  callback: Exclude<LinkCallback, { error: string }>,
): Promise<LinkAuthorization> {
  if (callback.denied) {
    await api(callback.pending.target, { method: "DELETE" });
    return { id: "", providerId: "github", state: "cancelled" };
  }
  // Preserve the project's query on the callback endpoint. Never infer the target from the current view.
  const target = new URL(callback.pending.target, window.location.origin);
  target.pathname += "/complete";
  return api(target.pathname + target.search, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl: callback.callbackUrl }),
  });
}

/** Ordinary workbench startup must not depend on browser storage availability. */
export function readBrowserLinkCallback(): LinkCallback | undefined {
  const home = callbackHome(window.location.pathname);
  if (!home) return undefined;
  try {
    return takeLinkCallback(window.location, window.history, window.sessionStorage);
  } catch {
    window.history.replaceState(window.history.state, "", window.location.pathname);
    return { error: "浏览器无法读取原授权记录。请允许此站点保存临时数据后重新连接。", home };
  }
}
