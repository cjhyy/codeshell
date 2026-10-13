import React from "react";
import {
  AccountWebClient,
  AccountWebError,
  parseAccountSession,
  type AccountWebSession,
} from "./account-api.js";

interface OAuthFlow {
  mode: "login" | "link";
  verifier: string;
  popup: Window;
  receipt?: string;
  cancelled: boolean;
  accountId?: string;
  rootId?: string;
  cleanup?: Promise<void>;
}
interface AccountSessionContext {
  session: AccountWebSession | null;
  ready: boolean;
  busy: boolean;
  error: string;
  status: string;
  registrationAllowed: boolean;
  githubEnabled: boolean;
  oauthPending: boolean;
  restore: () => Promise<void>;
  signIn: (
    mode: "login" | "register",
    values: { username: string; password: string; displayName?: string },
  ) => Promise<boolean>;
  logout: () => Promise<boolean>;
  github: (mode: "login" | "link") => Promise<void>;
  cancelGithub: () => void;
  clearError: () => void;
  workspaceActive: (identity: string) => boolean;
  request: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
}
const AccountContext = React.createContext<AccountSessionContext | null>(null);

export function useAccountSession(): AccountSessionContext {
  const value = React.useContext(AccountContext);
  if (!value) throw new Error("Account session provider is missing");
  return value;
}

export function AccountSessionProvider({ children }: { children: React.ReactNode }) {
  const client = React.useRef<AccountWebClient | null>(null);
  client.current ??= new AccountWebClient();
  const api = client.current;
  const [session, setSession] = React.useState<AccountWebSession | null>(null);
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [capabilities, setCapabilities] = React.useState({
    registrationAllowed: false,
    githubEnabled: false,
  });
  const [oauthPending, setOAuthPending] = React.useState(false);
  const pending = React.useRef<OAuthFlow | null>(null);
  const revision = React.useRef(0);
  const mounted = React.useRef(false);
  const active = (epoch: number) => mounted.current && epoch === revision.current;
  const setWorking = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "请求失败，请稍后重试。");
  const accept = (value: unknown) => {
    const next = parseAccountSession(value);
    api.setSession(next);
    setSession(next);
    sessionRef.current = next;
    setReady(true);
  };
  const cleanup = (flow: OAuthFlow): Promise<void> => {
    flow.popup.close();
    if (
      flow.mode === "link" &&
      (flow.accountId !== sessionRef.current?.account?.id ||
        flow.rootId !== sessionRef.current?.session?.id)
    )
      return Promise.resolve();
    if (flow.receipt && !flow.cleanup)
      flow.cleanup = (
        flow.mode === "login"
          ? api.nativeRequest("/github/cancel", {
              receipt: flow.receipt,
              codeVerifier: flow.verifier,
            })
          : api.request("/github/cancel", "POST", {
              receipt: flow.receipt,
              codeVerifier: flow.verifier,
            })
      ).then(
        () => {},
        () => {},
      );
    return flow.cleanup ?? Promise.resolve();
  };
  const cancelGithub = () => {
    const flow = pending.current;
    if (!flow) return;
    flow.cancelled = true;
    pending.current = null;
    if (flow.mode === "login") revision.current++;
    void cleanup(flow);
    setOAuthPending(false);
    setWorking(false);
    setError("");
    setStatus(flow.mode === "link" ? "已取消关联流程，可刷新连接状态确认。" : "已取消登录。");
  };
  const restore = React.useCallback(async () => {
    if (busyRef.current) return;
    const epoch = ++revision.current;
    setWorking(true);
    setError("");
    try {
      const value = await api.restoreSession();
      if (active(epoch)) accept(value);
    } catch (cause) {
      if (active(epoch)) {
        if (cause instanceof AccountWebError && cause.status === 401) {
          accept({ authenticated: false, refreshRequired: false, cloudTarget: null });
        } else setReady(false);
        report(cause);
      }
    } finally {
      if (active(epoch)) setWorking(false);
    }
  }, [api]);
  React.useEffect(() => {
    mounted.current = true;
    api.onSessionLost = () => {
      revision.current++;
      api.invalidate();
      const previous = sessionRef.current;
      if (previous) {
        const cleared: AccountWebSession = {
          authenticated: false,
          refreshRequired: false,
          csrfToken: previous.csrfToken,
          cloudTarget: previous.cloudTarget,
        };
        setSession(cleared);
        sessionRef.current = cleared;
      }
      setStatus("");
      setError("登录已过期，请重新登录。");
      setWorking(false);
    };
    void restore();
    const controller = new AbortController();
    void fetch("/api/v1/account/status", {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("登录方式暂时无法读取。");
        const value = await response.json();
        if (
          typeof value.registrationAllowed !== "boolean" ||
          typeof value.githubEnabled !== "boolean"
        )
          throw new Error("登录方式数据无效。");
        if (!controller.signal.aborted) setCapabilities(value);
      })
      .catch(() => {});
    const focus = () => {
      if (!pending.current) void restore();
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      revision.current++;
      busyRef.current = false;
      if (pending.current) {
        pending.current.cancelled = true;
        void cleanup(pending.current);
        pending.current = null;
      }
      api.invalidate();
      controller.abort();
      window.removeEventListener("focus", focus);
    };
  }, [api, restore]);
  React.useEffect(() => {
    if (!session?.authenticated || !session.session) return;
    let timer: ReturnType<typeof setTimeout>;
    const renew = async () => {
      if (busyRef.current) {
        timer = setTimeout(renew, 1000);
        return;
      }
      const epoch = revision.current;
      try {
        const value = await api.restoreSession(60000);
        if (active(epoch)) accept(value);
      } catch (cause) {
        if (active(epoch)) report(cause);
      }
    };
    timer = setTimeout(renew, Math.max(1000, session.session.expiresAt - Date.now() - 60000));
    return () => clearTimeout(timer);
  }, [api, session]);

  const signIn: AccountSessionContext["signIn"] = async (mode, values) => {
    if (busyRef.current || !ready) return false;
    const epoch = ++revision.current;
    api.invalidate();
    setWorking(true);
    setError("");
    setStatus("");
    try {
      const grant = await api.nativeRequest<any>("/" + mode, {
        ...values,
        deviceName: "CodeShell 网站",
      });
      if (!active(epoch)) {
        void api.revokeTransient(grant);
        return false;
      }
      try {
        const value = await api.exchangeGrant(grant, () => active(epoch));
        if (!active(epoch)) return false;
        accept(value);
      } catch (cause) {
        void api.revokeTransient(grant);
        throw cause;
      }
      return true;
    } catch (cause) {
      if (active(epoch)) report(cause);
      return false;
    } finally {
      if (active(epoch)) setWorking(false);
    }
  };
  const logout = async () => {
    cancelGithub();
    const epoch = ++revision.current;
    api.invalidate();
    setWorking(true);
    setError("");
    setStatus("");
    const previous = sessionRef.current;
    if (previous) {
      const cleared: AccountWebSession = {
        authenticated: false,
        refreshRequired: false,
        csrfToken: previous.csrfToken,
        cloudTarget: previous.cloudTarget,
      };
      setSession(cleared);
      sessionRef.current = cleared;
    }
    try {
      const value = await api.logoutSession();
      if (active(epoch)) accept(value);
      return true;
    } catch (cause) {
      if (active(epoch)) {
        setReady(false);
        report(cause);
      }
      return false;
    } finally {
      if (active(epoch)) setWorking(false);
    }
  };
  const github: AccountSessionContext["github"] = async (mode) => {
    if (
      busyRef.current ||
      !ready ||
      !capabilities.githubEnabled ||
      (mode === "link" && !sessionRef.current?.authenticated)
    )
      return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setError("请允许此页打开 GitHub 授权窗口后重试。");
      return;
    }
    popup.opener = null;
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const flow: OAuthFlow = {
      popup,
      mode,
      verifier: encode(crypto.getRandomValues(new Uint8Array(32))),
      cancelled: false,
      accountId: sessionRef.current?.account?.id,
      rootId: sessionRef.current?.session?.id,
    };
    pending.current = flow;
    const accountId = sessionRef.current?.account?.id;
    const epoch = mode === "login" ? ++revision.current : revision.current;
    const live = () =>
      active(epoch) &&
      pending.current === flow &&
      !flow.cancelled &&
      (mode !== "link" || sessionRef.current?.account?.id === accountId);
    setWorking(true);
    setOAuthPending(true);
    setError("");
    setStatus(
      mode === "link"
        ? "请在 GitHub 页面确认要关联的身份。"
        : "请在 GitHub 页面完成登录，最终结果会显示在这里。",
    );
    try {
      const codeChallenge = encode(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier)),
        ),
      );
      if (!live()) return;
      type Start = {
        authorizationUrl: string;
        receipt: string;
        expiresAt: number;
        pollIntervalMs: number;
      };
      const beforeFence = (value: Start) => {
        if (/^[A-Za-z0-9_-]{43}$/.test(value?.receipt)) flow.receipt = value.receipt;
        if (flow.cancelled) void cleanup(flow);
      };
      const start =
        mode === "login"
          ? await api.nativeRequest<Start>("/github/start", { codeChallenge }, beforeFence)
          : await api.request<Start>(
              "/github/start",
              "POST",
              { codeChallenge, mode },
              undefined,
              beforeFence,
            );
      if (!live()) return;
      const url = new URL(start.authorizationUrl);
      if (
        url.origin !== "https://github.com" ||
        url.pathname !== "/login/oauth/authorize" ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("code_challenge") !== codeChallenge ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("scope") !== "read:user" ||
        !flow.receipt ||
        !Number.isSafeInteger(start.expiresAt) ||
        start.expiresAt <= Date.now() ||
        start.expiresAt > Date.now() + 900000
      )
        throw new AccountWebError("GitHub 授权请求无效，请重新发起。");
      popup.location.href = url.href;
      while (Date.now() < start.expiresAt && live()) {
        const proof = {
          receipt: start.receipt,
          codeVerifier: flow.verifier,
          deviceName: "CodeShell 网站",
        };
        const result =
          mode === "login"
            ? await api.nativeRequest<any>("/github/poll", proof)
            : await api.request<any>("/github/poll", "POST", proof);
        if (!live()) {
          if (result?.accessToken) void api.revokeTransient(result);
          return;
        }
        if (result.status !== "pending") {
          if (mode === "link") {
            if (result.linked !== true || result.account?.id !== accountId)
              throw new AccountWebError("GitHub 关联结果无效，请刷新后重试。");
            setStatus("GitHub 登录身份已关联，数据授权保持独立。");
          } else {
            try {
              const next = await api.exchangeGrant(result, live);
              if (live()) {
                accept(next);
                setStatus("");
              }
            } catch (cause) {
              void api.revokeTransient(result);
              throw cause;
            }
          }
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10000, Math.max(1000, start.pollIntervalMs || 1000))),
        );
      }
      if (live()) throw new AccountWebError("GitHub 授权已超时，请重新发起。");
    } catch (cause) {
      if (live()) {
        setStatus("");
        report(cause);
      }
    } finally {
      await cleanup(flow);
      if (pending.current === flow) {
        pending.current = null;
        setOAuthPending(false);
        if (active(epoch)) setWorking(false);
      }
    }
  };
  const request = React.useCallback<AccountSessionContext["request"]>(
    (...args) => api.request(...args),
    [api],
  );
  return (
    <AccountContext.Provider
      value={{
        session,
        ready,
        busy,
        error,
        status,
        ...capabilities,
        oauthPending,
        restore,
        signIn,
        logout,
        github,
        cancelGithub,
        clearError: () => setError(""),
        workspaceActive: (identity) =>
          !busyRef.current &&
          sessionRef.current?.authenticated === true &&
          `${sessionRef.current.account!.id}:${sessionRef.current.session!.id}` === identity,
        request,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}
