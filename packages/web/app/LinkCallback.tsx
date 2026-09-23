import React from "react";
import type { LinkAuthorization } from "@cjhyy/code-shell-link";
import { api, ApiError } from "./auth.js";
import { completeLinkCallback, type LinkCallback } from "./remote-link-authorization.js";

export function LinkCallbackPage({ callback }: { callback: LinkCallback }) {
  const operation = React.useRef<Promise<LinkAuthorization> | undefined>(undefined);
  const [result, setResult] = React.useState<LinkAuthorization>();
  const [error, setError] = React.useState("error" in callback ? callback.error : "");
  const [checking, setChecking] = React.useState(false);
  const report = (cause: unknown) =>
    setError(
      cause instanceof ApiError && cause.status === 401
        ? "原登录已失效。请返回工作台登录，并重新发起授权。"
        : cause instanceof Error
          ? cause.message
          : "无法确认授权结果，请检查结果或返回项目重新连接。",
    );
  React.useEffect(() => {
    if ("error" in callback) return;
    let current = true;
    // React StrictMode may mount effects twice; one callback must never exchange twice.
    operation.current ??= completeLinkCallback(callback);
    void operation.current.then(
      (value) => {
        if (current) setResult(value);
      },
      (cause) => {
        if (current) report(cause);
      },
    );
    return () => {
      current = false;
    };
  }, [callback]);
  const pending = !result && !error;
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Link 授权</h1>
        {pending && <p role="status">正在确认授权并保存到原项目…</p>}
        {result?.state === "connected" && (
          <p role="status">
            已连接 {result.connection?.account?.label ?? "GitHub"}，授权已保存到原项目。
          </p>
        )}
        {result?.previousGrantRevocationPending && (
          <p role="alert">新连接已保存，但旧授权尚未撤销。请在 Link 服务中撤销旧授权。</p>
        )}
        {result?.state === "cancelled" && <p role="status">授权已取消，没有新增连接。</p>}
        {result?.state === "failed" && <p role="alert">授权未完成。请返回原项目重新连接。</p>}
        {result?.state === "pending" && (
          <p role="status">服务端尚未确认完成。可以稍后检查结果，或返回项目重新发起授权。</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!("error" in callback) && (error || result?.state === "pending") && (
          <button
            disabled={checking}
            onClick={() => {
              if (checking) return;
              setChecking(true);
              void api<LinkAuthorization>(callback.pending.target)
                .then((value) => {
                  setResult(value);
                  setError("");
                }, report)
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "正在查询…" : "检查授权结果"}
          </button>
        )}
        {!pending && (
          <a href={"error" in callback ? "/" : callback.pending.returnUrl}>返回原项目</a>
        )}
      </section>
    </main>
  );
}
