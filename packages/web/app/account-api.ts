import { withAccountCookieLock } from "./account-cookie-lock.js";
export const ACCOUNT_WEB_PREFIX = "/api/v1/account/web";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export interface WebsiteAccount {
  id: string;
  username: string;
  displayName: string;
  role: "member" | "admin";
}
export interface CloudWebsiteTarget {
  cloudOrigin: string;
  accountOrigin: string;
  installationId: string;
}
export interface AccountWebSession {
  authenticated: boolean;
  csrfToken?: string;
  refreshRequired?: boolean;
  account?: WebsiteAccount;
  session?: { id: string; expiresAt: number };
  overview?: AccountOverview;
  cloudTarget: CloudWebsiteTarget | null;
}
export interface AccountOverview {
  account: WebsiteAccount;
  security: { hasPassword: boolean; githubLinked: boolean };
  capabilities: { sessions: boolean; passwordChange: boolean; admin: boolean; links: boolean };
  stats: { activeSessions: number; loginMethods: number };
}

const messages: Record<string, string> = {
  invalid_credentials: "用户名或密码不正确。",
  invalid_username: "用户名须为 3–64 位字母、数字、点、下划线或连字符。",
  username_unavailable: "这个用户名已被使用，请换一个。",
  invalid_display_name: "昵称须为 1–64 个字符，且不能包含控制字符。",
  invalid_password: "密码须为 12–1024 个字符。",
  incorrect_password: "当前密码不正确，请重新输入。",
  password_changed: "密码已在其他页面修改，请使用最新密码重试。",
  password_not_configured: "此账号尚未设置密码，请继续使用 GitHub 登录。",
  registration_disabled: "当前服务未开放注册，请使用已有账号登录。",
  authentication_required: "登录已过期，请重新登录。",
  invalid_session: "登录已过期，请重新登录。",
  invalid_web_session: "登录已过期，请重新登录。",
  csrf_required: "页面验证已过期，请刷新后重试。",
  invalid_csrf: "页面验证已过期，请刷新后重试。",
  github_login_failed: "GitHub 登录未完成，请重新发起登录。",
  github_login_denied: "GitHub 授权未完成，请重新发起。",
  invalid_github_receipt: "GitHub 授权请求已失效，请重新发起。",
  provider_already_linked: "这个 GitHub 身份已关联到其他账号，或当前账号已有不同的 GitHub 身份。",
  account_login_required: "登录已失效，请重新登录后关联 GitHub。",
  administrator_required: "当前账号没有管理员权限。",
  protected_administrator: "不能停用当前账号或其他管理员。",
  too_many_attempts: "操作过于频繁，请稍后再试。",
  too_many_account_sessions: "登录会话已达上限，请先退出其他设备。",
  account_not_found: "账号已不存在，请刷新列表。",
  session_not_found: "此登录会话已结束，请刷新列表。",
  link_management_disabled: "当前服务尚未开放数据连接管理。",
  link_management_unavailable: "数据连接服务暂时不可用，请稍后重试。",
  cloud_management_disabled: "当前服务尚未配置云端工作区。",
};

export class AccountWebError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function accountError(value: unknown, status: number, path: string): AccountWebError {
  const body = value as { error?: unknown; reason?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  if (path === "/github/poll" && code === "github_login_failed") {
    if (body?.reason === "provider_timeout")
      return new AccountWebError("服务器连接 GitHub 超时，请重新发起授权。", status, code);
    if (body?.reason === "provider_unavailable")
      return new AccountWebError("服务器暂时无法访问 GitHub，请稍后重新发起授权。", status, code);
  }
  return new AccountWebError(
    code && Object.hasOwn(messages, code) ? messages[code]! : "操作未完成，请稍后重试。",
    status,
    code,
  );
}

export function canonicalWebsiteOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function validWebsiteAccount(value: unknown): value is WebsiteAccount {
  const account = value as WebsiteAccount | undefined;
  return (
    !!account &&
    UUID.test(account.id) &&
    typeof account.username === "string" &&
    /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(account.username) &&
    typeof account.displayName === "string" &&
    [...account.displayName].length >= 1 &&
    [...account.displayName].length <= 64 &&
    !/[\p{Cc}\p{Cs}]/u.test(account.displayName) &&
    ["member", "admin"].includes(account.role)
  );
}
export function validCloudTarget(value: unknown): value is CloudWebsiteTarget {
  const target = value as CloudWebsiteTarget | undefined;
  return (
    !!target &&
    canonicalWebsiteOrigin(target.cloudOrigin) &&
    canonicalWebsiteOrigin(target.accountOrigin) &&
    UUID.test(target.installationId)
  );
}
export function parseAccountSession(value: unknown): AccountWebSession {
  const raw = value as any;
  const result =
    raw &&
    ({ ...raw, cloudTarget: raw.cloudTarget?.enabled === false ? null : raw.cloudTarget } as
      | AccountWebSession
      | undefined);
  if (
    !result ||
    raw.accessToken !== undefined ||
    raw.refreshToken !== undefined ||
    typeof result.authenticated !== "boolean" ||
    ((result.authenticated || result.refreshRequired) && !OPAQUE.test(result.csrfToken ?? "")) ||
    (!result.authenticated && typeof result.refreshRequired !== "boolean") ||
    (result.cloudTarget !== null && !validCloudTarget(result.cloudTarget)) ||
    (result.authenticated &&
      (!validWebsiteAccount(result.account) ||
        !result.session ||
        !UUID.test(result.session.id) ||
        !Number.isSafeInteger(result.session.expiresAt) ||
        result.session.expiresAt <= Date.now())) ||
    (!result.authenticated && (result.account !== undefined || result.session !== undefined))
  )
    throw new AccountWebError("账号服务返回了无效的会话，请刷新后重试。");
  const overview = result.authenticated
    ? parseAccountOverview(result.overview, result.account!.id)
    : undefined;
  if (overview && overview.account.role !== result.account!.role)
    throw new AccountWebError("账号服务返回了不一致的权限，请刷新后重试。");
  return {
    authenticated: result.authenticated,
    ...(typeof result.csrfToken === "string" ? { csrfToken: result.csrfToken } : {}),
    ...(typeof result.refreshRequired === "boolean"
      ? { refreshRequired: result.refreshRequired }
      : {}),
    cloudTarget: result.cloudTarget
      ? {
          cloudOrigin: result.cloudTarget.cloudOrigin,
          accountOrigin: result.cloudTarget.accountOrigin,
          installationId: result.cloudTarget.installationId,
        }
      : null,
    ...(overview
      ? {
          account: {
            id: result.account!.id,
            username: result.account!.username,
            displayName: result.account!.displayName,
            role: result.account!.role,
          },
          overview,
          session: { id: result.session!.id, expiresAt: result.session!.expiresAt },
        }
      : {}),
  };
}
export function parseAccountOverview(value: unknown, accountId: string): AccountOverview {
  const result = value as AccountOverview | undefined;
  if (
    !result ||
    !validWebsiteAccount(result.account) ||
    result.account.id !== accountId ||
    typeof result.security?.hasPassword !== "boolean" ||
    typeof result.security?.githubLinked !== "boolean" ||
    ![
      result.capabilities?.sessions,
      result.capabilities?.passwordChange,
      result.capabilities?.admin,
      result.capabilities?.links,
    ].every((item) => typeof item === "boolean") ||
    result.capabilities.admin !== (result.account.role === "admin") ||
    ![result.stats?.activeSessions, result.stats?.loginMethods].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    )
  )
    throw new AccountWebError("账号服务返回了无效的资料，请刷新后重试。");
  return {
    account: {
      id: result.account.id,
      username: result.account.username,
      displayName: result.account.displayName,
      role: result.account.role,
    },
    security: {
      hasPassword: result.security.hasPassword,
      githubLinked: result.security.githubLinked,
    },
    capabilities: {
      sessions: result.capabilities.sessions,
      passwordChange: result.capabilities.passwordChange,
      admin: result.capabilities.admin,
      links: result.capabilities.links,
    },
    stats: { activeSessions: result.stats.activeSessions, loginMethods: result.stats.loginMethods },
  };
}

/** Cookie authority stays in its fixed Account path; no root grant reaches React or storage. */
export class AccountWebClient {
  private epoch = 0;
  private csrfToken = "";
  private requests = new Set<AbortController>();
  private rootId?: string;
  onSessionLost?: () => void;
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  setCsrf(value: string): void {
    this.csrfToken = value;
  }
  setSession(value: AccountWebSession): void {
    if (this.rootId !== value.session?.id) this.invalidate();
    this.csrfToken = value.csrfToken ?? "";
    this.rootId = value.session?.id;
  }

  /** A root grant exists only in the current native login operation, then is rotated into HttpOnly cookies. */
  async nativeRequest<T>(
    path: string,
    body?: unknown,
    beforeFence?: (value: T) => void,
  ): Promise<T> {
    if (!/^\/(?:login|register|github\/(?:start|poll|cancel))$/.test(path))
      throw new AccountWebError("登录请求地址无效。");
    const epoch = this.epoch;
    const timeout = AbortSignal.timeout(path === "/github/poll" ? 20000 : 10000);
    try {
      const response = await this.fetcher("/api/v1/account" + path, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: timeout,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      beforeFence?.(value);
      if (epoch !== this.epoch) {
        if (value?.accessToken) void this.revokeTransient(value);
        throw new AccountWebError("账号状态已改变。");
      }
      if (!response.ok) throw accountError(value, response.status, path);
      return value;
    } catch (cause) {
      if (cause instanceof AccountWebError) throw cause;
      throw new AccountWebError(
        path === "/github/poll" && (timeout.aborted || (cause as Error)?.name === "TimeoutError")
          ? "等待 GitHub 登录验证超时，请重新发起授权。"
          : "无法连接账号服务，请检查网络后重试。",
      );
    }
  }
  async revokeTransient(value: any): Promise<void> {
    if (!OPAQUE.test(value?.accessToken ?? "")) return;
    await this.fetcher("/api/v1/account/logout", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + value.accessToken },
      body: "{}",
    }).catch(() => {});
  }
  async exchangeGrant(value: any, live: () => boolean): Promise<AccountWebSession> {
    const expectedRoot = this.rootId;
    if (
      !OPAQUE.test(value?.accessToken ?? "") ||
      !OPAQUE.test(value?.refreshToken ?? "") ||
      !UUID.test(value?.account?.id ?? "") ||
      !UUID.test(value?.sessionId ?? "") ||
      !Number.isSafeInteger(value?.accessTokenExpiresAt) ||
      value.accessTokenExpiresAt <= Date.now()
    )
      throw new AccountWebError("登录授权结果无效，请重新发起。");
    return withAccountCookieLock(async () => {
      if (!live()) {
        await this.revokeTransient(value);
        throw new AccountWebError("账号状态已改变。");
      }
      let current: AccountWebSession;
      try {
        current = parseAccountSession(await this.request("/session"));
      } catch (cause) {
        if (
          !(cause instanceof AccountWebError && cause.status === 401 && expectedRoot === undefined)
        )
          throw cause;
        current = { authenticated: false, refreshRequired: false, cloudTarget: null };
      }
      if (current.refreshRequired)
        current = parseAccountSession(
          await this.cookieRequest("/refresh", "POST", {}, current.csrfToken),
        );
      if ((current.authenticated ? current.session?.id : undefined) !== expectedRoot) {
        await this.revokeTransient(value);
        throw new AccountWebError("其他页面已切换账号，请刷新后重新发起登录。");
      }
      if (!live()) {
        await this.revokeTransient(value);
        throw new AccountWebError("账号状态已改变。");
      }
      const response = await this.fetcher(ACCOUNT_WEB_PREFIX + "/session", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + value.accessToken,
        },
        body: JSON.stringify({ refreshToken: value.refreshToken }),
      });
      const body = await response.json();
      if (!response.ok) throw accountError(body, response.status, "/session");
      const result = parseAccountSession(body);
      if (
        !result.authenticated ||
        result.account?.id !== value.account.id ||
        result.session?.id !== value.sessionId
      )
        throw new AccountWebError("账号登录结果不一致，请重新登录。");
      if (!live()) {
        this.setSession(result);
        await this.cookieRequest("/logout", "POST", {});
        this.setSession({
          authenticated: false,
          refreshRequired: false,
          cloudTarget: result.cloudTarget,
        });
        throw new AccountWebError("账号状态已改变。");
      }
      this.setSession(result);
      return result;
    });
  }
  async restoreSession(renewWindowMs = 5000): Promise<AccountWebSession> {
    return withAccountCookieLock(async () => {
      let next = parseAccountSession(await this.request("/session"));
      if (
        next.refreshRequired ||
        (next.authenticated && next.session!.expiresAt <= Date.now() + renewWindowMs)
      ) {
        next = parseAccountSession(
          await this.cookieRequest("/refresh", "POST", {}, next.csrfToken),
        );
      }
      return next;
    });
  }
  async logoutSession(): Promise<AccountWebSession> {
    const expectedRoot = this.rootId;
    return withAccountCookieLock(async () => {
      let next = parseAccountSession(await this.request("/session"));
      if (next.refreshRequired) {
        if (next.csrfToken !== this.csrfToken)
          throw new AccountWebError("其他页面已切换账号，请刷新后确认。");
        next = parseAccountSession(
          await this.cookieRequest("/refresh", "POST", {}, next.csrfToken),
        );
      }
      if (next.authenticated && next.session?.id !== expectedRoot)
        throw new AccountWebError("其他页面已切换账号，请刷新后确认。");
      this.setSession(next);
      if (next.authenticated) {
        const result = await this.cookieRequest<{ ok: boolean }>("/logout", "POST", {});
        if (result.ok !== true) throw new AccountWebError("服务端尚未确认退出，请重试。");
      }
      return { authenticated: false, refreshRequired: false, cloudTarget: next.cloudTarget };
    });
  }
  private async cookieRequest<T>(
    path: string,
    method: string,
    body?: unknown,
    csrfToken = this.csrfToken,
  ): Promise<T> {
    const response = await this.fetcher(ACCOUNT_WEB_PREFIX + path, {
      method,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-CodeShell-CSRF": csrfToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw accountError(value, response.status, path);
    if (value?.accessToken !== undefined || value?.refreshToken !== undefined)
      throw new AccountWebError("账号服务返回了不支持的授权结果。");
    return value;
  }
  invalidate(): void {
    this.epoch++;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    beforeFence?: (value: T) => void,
    attempt = 0,
  ): Promise<T> {
    if (!/^\/[A-Za-z0-9/?=&_-]+$/.test(path) || path.startsWith("//"))
      throw new AccountWebError("账号请求地址无效。");
    if (method !== "GET" && !this.csrfToken)
      throw new AccountWebError("页面验证尚未完成，请刷新后重试。");
    if (method === "DELETE" && /^\/sessions\/[0-9a-f-]{36}$/.test(path)) {
      const expectedRoot = this.rootId;
      return withAccountCookieLock(async () => {
        const next = parseAccountSession(await this.request("/session"));
        if (!next.authenticated || next.session?.id !== expectedRoot)
          throw new AccountWebError("账号状态已改变，请刷新后重试。");
        this.setSession(next);
        return this.cookieRequest<T>(path, method);
      });
    }
    const epoch = this.epoch;
    const requestRoot = this.rootId;
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = AbortSignal.timeout(path === "/github/poll" ? 20000 : 10000);
    try {
      const response = await this.fetcher(ACCOUNT_WEB_PREFIX + path, {
        method,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.csrfToken ? { "X-CodeShell-CSRF": this.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      beforeFence?.(value);
      if (epoch !== this.epoch || signal?.aborted) throw new AccountWebError("账号状态已改变。");
      if (value?.accessToken !== undefined || value?.refreshToken !== undefined)
        throw new AccountWebError("账号服务返回了不支持的授权结果。");
      if (!response.ok) {
        if (
          response.status === 401 &&
          attempt === 0 &&
          path !== "/session" &&
          path !== "/refresh" &&
          !path.startsWith("/github/")
        ) {
          const expectedRoot = requestRoot;
          try {
            const refreshed = await this.restoreSession();
            if (
              refreshed.authenticated &&
              refreshed.session?.id === expectedRoot &&
              epoch === this.epoch &&
              this.rootId === requestRoot
            ) {
              this.setSession(refreshed);
              return await this.request<T>(path, method, body, signal, beforeFence, 1);
            }
          } catch {
            /* An expired root cannot be restored or retried as another account. */
          }
        }
        if (epoch !== this.epoch || requestRoot !== this.rootId)
          throw new AccountWebError("账号状态已改变。");
        if (
          response.status === 401 &&
          path !== "/session" &&
          path !== "/refresh" &&
          !path.startsWith("/github/")
        )
          this.onSessionLost?.();
        throw accountError(value, response.status, path);
      }
      return value as T;
    } catch (error) {
      if (error instanceof AccountWebError) throw error;
      if (epoch !== this.epoch || signal?.aborted || controller.signal.aborted)
        throw new AccountWebError("账号状态已改变。");
      throw new AccountWebError(
        path === "/github/poll" && (timeout.aborted || (error as Error)?.name === "TimeoutError")
          ? "等待 GitHub 登录验证超时，请重新发起授权。"
          : "无法连接账号服务，请检查网络后重试。",
      );
    } finally {
      this.requests.delete(controller);
    }
  }
}
