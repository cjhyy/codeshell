import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import { AccountWebError } from "./account-api.js";
import { WebsiteLogin } from "./WebsiteLogin.js";

/** This public request identifies a pending login; it is never a session credential. */
export function desktopLoginRequest(url: URL): string | undefined {
  const request = url.searchParams.getAll("request");
  if (
    !["/desktop-login", "/desktop-login/"].includes(url.pathname) ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "request") ||
    request.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(request[0])
  )
    return;
  return request[0];
}

function failure(cause: unknown): string {
  if (cause instanceof AccountWebError) {
    if ([404, 410].includes(cause.status))
      return "此电脑登录请求已过期或不存在，请返回 CodeShell 重新发起登录。";
    if (cause.status === 409)
      return "此电脑登录请求已结束，请返回 CodeShell 查看结果或重新发起登录。";
  }
  return cause instanceof Error ? cause.message : "电脑登录未完成，请返回 CodeShell 重试。";
}

export function DesktopLoginPage({ request }: { request?: string }) {
  const account = useAccountSession();
  if (!request)
    return (
      <main className="website-login">
        <section className="auth-card website-auth">
          <h1>电脑登录链接无效</h1>
          <p role="alert">请返回 CodeShell 重新发起登录。</p>
        </section>
      </main>
    );
  if (!account.session?.authenticated) return <WebsiteLogin desktopLogin />;
  const identity = `${account.session.account!.id}:${account.session.session!.id}`;
  return <DesktopLoginConfirmation key={`${identity}:${request}`} request={request} />;
}

function DesktopLoginConfirmation({ request }: { request: string }) {
  const account = useAccountSession();
  const user = account.session!.account!;
  const [details, setDetails] = React.useState<{ deviceName: string; expiresAt: number }>();
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [expired, setExpired] = React.useState(false);
  const [result, setResult] = React.useState<"approved" | "denied">();
  const [attempt, setAttempt] = React.useState(0);
  const working = React.useRef(false);
  const operation = React.useRef<AbortController | undefined>(undefined);
  const alive = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operation.current?.abort();
    };
  }, []);
  React.useEffect(() => {
    if (result === "approved") window.location.replace("/app");
  }, [result]);
  React.useEffect(() => {
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    setDetails(undefined);
    setLoading(true);
    setError("");
    setExpired(false);
    void account
      .request<unknown>(`/browser/request?request=${request}`, "GET", undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        const detail = value as { deviceName?: unknown; expiresAt?: unknown } | undefined;
        if (
          !detail ||
          typeof detail.deviceName !== "string" ||
          !detail.deviceName.trim() ||
          [...detail.deviceName].length > 100 ||
          /[\p{Cc}\p{Cs}]/u.test(detail.deviceName) ||
          typeof detail.expiresAt !== "number" ||
          !Number.isSafeInteger(detail.expiresAt) ||
          detail.expiresAt > Date.now() + 15 * 60_000
        )
          throw new Error("电脑登录请求信息无效，请返回 CodeShell 重新发起登录。");
        if (detail.expiresAt <= Date.now()) {
          setExpired(true);
          return;
        }
        setDetails({ deviceName: detail.deviceName, expiresAt: detail.expiresAt });
        expiry = setTimeout(() => setExpired(true), detail.expiresAt - Date.now());
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(failure(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      clearTimeout(expiry);
    };
  }, [account.request, request, attempt]);
  const decide = async (decision: "approve" | "deny") => {
    if (
      working.current ||
      account.busy ||
      !account.ready ||
      !details ||
      result ||
      expired ||
      details.expiresAt <= Date.now()
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await account.request<{ approved?: boolean; denied?: boolean }>(
        `/browser/${decision}`,
        "POST",
        { request },
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (decision === "approve" ? value?.approved !== true : value?.denied !== true)
        throw new Error("服务器尚未确认操作结果，请返回 CodeShell 查看登录状态。");
      setResult(decision === "approve" ? "approved" : "denied");
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(failure(cause));
    } finally {
      working.current = false;
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <main className="website-login website-desktop-login">
      <header className="website-brand">
        CodeShell <span>电脑登录</span>
      </header>
      <section className="auth-card website-auth" aria-labelledby="desktop-login-title">
        <h1 id="desktop-login-title">
          {result === "approved"
            ? "已确认，正在打开远程工作台"
            : result === "denied"
              ? "已取消电脑登录"
              : "确认登录这台电脑"}
        </h1>
        <p className="website-muted">当前网页账号</p>
        <p>
          <strong>{user.displayName}</strong> · @{user.username}
        </p>
        {details ? (
          <p>
            电脑：<strong>{details.deviceName}</strong>
          </p>
        ) : null}
        {result ? (
          <>
            <p role="status">
              {result === "approved"
                ? "电脑端将继续完成登录。你也可以在远程工作台选择云端工作区或账号下的电脑。"
                : "此请求已取消，网页账号保持登录。"}
            </p>
            <a className="website-button primary" href="/app">
              进入远程工作台
            </a>
          </>
        ) : (
          <>
            <p className="website-hint">
              仅在你刚刚从这台电脑的 CodeShell 发起登录时确认。GitHub 仓库访问权限另行选择。
            </p>
            {loading ? <p role="status">正在读取电脑登录请求…</p> : null}
            {expired ? (
              <p role="alert">此电脑登录请求已过期，请返回 CodeShell 重新发起登录。</p>
            ) : null}
            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            {!loading && !details && !expired ? (
              <button className="website-button" onClick={() => setAttempt((value) => value + 1)}>
                重试读取请求
              </button>
            ) : null}
            {details && !expired ? (
              <div className="website-action-row">
                <button
                  className="website-button primary"
                  disabled={busy || account.busy || !account.ready}
                  onClick={() => void decide("approve")}
                >
                  {busy ? "正在确认…" : "登录这台电脑"}
                </button>
                <button
                  className="website-button"
                  disabled={busy || account.busy || !account.ready}
                  onClick={() => void decide("deny")}
                >
                  取消电脑登录
                </button>
              </div>
            ) : null}
            <button
              className="ghost"
              disabled={busy || account.busy}
              onClick={() => void account.logout()}
            >
              换个账号登录
            </button>
            {account.error ? <p role="alert">{account.error}</p> : null}
            {!account.ready && !account.busy ? (
              <button className="website-button" onClick={() => void account.restore()}>
                重新读取账号状态
              </button>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
