import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import { WebsiteLogin } from "./WebsiteLogin.js";
import {
  requirePasskey,
  passkeyFailure,
  PASSKEY_EXPLANATION,
  PASSKEY_SETTINGS_URL,
} from "./passkey-browser.js";

export function desktopRemoteAccessRequest(url: URL): string | undefined {
  const values = url.searchParams.getAll("request");
  if (
    !["/remote-access", "/remote-access/"].includes(url.pathname) ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "request") ||
    values.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(values[0])
  )
    return;
  return values[0];
}
interface AccessRequest {
  deviceName: string;
  target: { hostId: string; environmentId: string; name: string };
  expiresAt: number;
}
const uuid = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const label = (value: unknown) =>
  typeof value === "string" &&
  value.trim() &&
  [...value].length <= 100 &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
export function parseDesktopRemoteAccess(value: unknown): AccessRequest {
  const detail = value as AccessRequest | undefined;
  if (
    !detail ||
    !label(detail.deviceName) ||
    !label(detail.target?.name) ||
    !uuid(detail.target.hostId) ||
    !uuid(detail.target.environmentId) ||
    !Number.isSafeInteger(detail.expiresAt) ||
    detail.expiresAt > Date.now() + 15 * 60000
  )
    throw new Error("远程访问请求信息无效，请返回 CodeShell 重新发起。");
  return detail;
}
export function DesktopRemoteAccessPage({ request }: { request?: string }) {
  const account = useAccountSession();
  if (!request)
    return (
      <main className="website-login">
        <section className="auth-card website-auth">
          <h1>远程访问链接无效</h1>
          <p role="alert">请返回 CodeShell 重新发起连接。</p>
        </section>
      </main>
    );
  if (!account.session?.authenticated) return <WebsiteLogin remoteAccess />;
  return (
    <RemoteConfirmation
      key={`${account.session.account!.id}:${account.session.session!.id}:${request}`}
      request={request}
    />
  );
}
function RemoteConfirmation({ request }: { request: string }) {
  const account = useAccountSession();
  const [detail, setDetail] = React.useState<AccessRequest>();
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [expired, setExpired] = React.useState(false);
  const [result, setResult] = React.useState<"approved" | "denied">();
  const [retry, setRetry] = React.useState(0);
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => pending.current?.abort(), []);
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setDetail(undefined);
    setError("");
    setExpired(false);
    void account
      .request(`/remote-access/request?request=${request}`, "GET", undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        const next = parseDesktopRemoteAccess(value);
        setDetail(next);
        setExpired(next.expiresAt <= Date.now());
        timer = setTimeout(() => setExpired(true), Math.max(0, next.expiresAt - Date.now()));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(passkeyFailure(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account.request, request, retry]);
  const decide = async (decision: "approve" | "deny") => {
    if (
      pending.current ||
      account.busy ||
      !account.ready ||
      !detail ||
      detail.expiresAt <= Date.now() ||
      result
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const proof =
        decision === "approve"
          ? await requirePasskey(
              account.request,
              "desktop-remote-access",
              request,
              controller.signal,
            )
          : undefined;
      controller.signal.throwIfAborted();
      const value = await account.request<{ approved?: boolean; denied?: boolean }>(
        `/remote-access/${decision}`,
        "POST",
        { request, ...(proof ? { stepUpToken: proof.stepUpToken } : {}) },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (decision === "approve" ? value.approved !== true : value.denied !== true)
        throw new Error("服务器尚未确认结果，请返回 CodeShell 查看状态。");
      setResult(decision === "approve" ? "approved" : "denied");
    } catch (cause) {
      if (!controller.signal.aborted) setError(passkeyFailure(cause));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };
  return (
    <main className="website-login website-desktop-login">
      <header className="website-brand">
        CodeShell <span>远程访问</span>
      </header>
      <section className="auth-card website-auth" aria-labelledby="remote-request-title">
        <h1 id="remote-request-title">
          {result === "approved"
            ? "已确认远程访问"
            : result === "denied"
              ? "已取消远程访问"
              : "确认连接这台电脑"}
        </h1>
        <p>
          当前账号：<strong>{account.session!.account!.displayName}</strong> · @
          {account.session!.account!.username}
        </p>
        {detail ? (
          <>
            <p>
              从 <strong>{detail.deviceName}</strong>
            </p>
            <p>
              连接 <strong>{detail.target.name}</strong>
            </p>
          </>
        ) : null}
        {result ? (
          <>
            <p role="status">
              {result === "approved"
                ? "回到 CodeShell，连接会自动继续。"
                : "此请求已取消，网页账号保持登录。"}
            </p>
            <a className="website-button" href="/app">
              进入远程工作台
            </a>
          </>
        ) : (
          <>
            <p className="website-hint">
              仅在你刚刚从 CodeShell 发起此连接时确认。{PASSKEY_EXPLANATION}
            </p>
            <a href={PASSKEY_SETTINGS_URL} target="_blank" rel="noreferrer">
              在新页面设置 Passkey
            </a>
            {loading ? <p role="status">正在读取远程访问请求…</p> : null}
            {expired ? <p role="alert">请求已过期，请返回 CodeShell 重新连接。</p> : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {!loading && !detail ? (
              <button className="website-button" onClick={() => setRetry((value) => value + 1)}>
                重试读取请求
              </button>
            ) : null}
            {detail && !expired ? (
              <div className="website-action-row">
                <button
                  className="website-button primary"
                  disabled={busy || account.busy || !account.ready}
                  onClick={() => void decide("approve")}
                >
                  {busy ? "等待系统验证…" : "用 Passkey 确认连接"}
                </button>
                <button
                  className="website-button"
                  disabled={busy || account.busy || !account.ready}
                  onClick={() => void decide("deny")}
                >
                  取消连接
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
          </>
        )}
      </section>
    </main>
  );
}
