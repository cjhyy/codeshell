import React from "react";
import type {
  LinkAuthorization,
  LinkConnectionInput,
  LinkProviderView,
  LinkSnapshot,
  MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import { api, ApiError } from "./auth.js";
import { apiUrl, getApiWorkspace, getApiProject } from "./api-context.js";
import "./hub-links.css";

const ROOT = "/api/v1/links";
const statuses: Record<MaskedLinkConnection["status"], string> = {
  connected: "已连接",
  expired: "授权已过期",
  invalid: "需要重新连接",
  unavailable: "凭据不可用",
};
interface Editor {
  provider: LinkProviderView;
  methodId: string;
  label: string;
  token: string;
  original?: MaskedLinkConnection;
}
interface CliStatus {
  installed: boolean;
  authenticated: boolean;
  account?: string;
  message?: string;
}

export function safeLinkUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function HubLinks({
  onAuthLost,
  onDirtyChange,
  hostLabel = "服务端",
  configurationVersion = 0,
}: {
  onAuthLost: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  hostLabel?: string;
  configurationVersion?: number;
}) {
  const [snapshot, setSnapshot] = React.useState<LinkSnapshot>();
  const [editor, setEditor] = React.useState<Editor>();
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MaskedLinkConnection>();
  const [cli, setCli] = React.useState<CliStatus>();
  const [authorization, setAuthorization] = React.useState<LinkAuthorization>();
  const [reload, setReload] = React.useState(0);
  const mounted = React.useRef(false);
  const write = React.useRef<AbortController | undefined>(undefined);
  const authUrl = React.useRef<string | undefined>(undefined);
  const read = React.useRef<AbortController | undefined>(undefined);
  const callbacks = React.useRef({ onAuthLost, onDirtyChange });
  callbacks.current = { onAuthLost, onDirtyChange };
  const dirty =
    busy ||
    authorization?.state === "pending" ||
    Boolean(
      editor &&
      (editor.token || editor.label !== (editor.original?.label ?? editor.provider.displayName)),
    );

  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(cause instanceof Error ? cause.message : "连接操作失败，请重试。");
  }, []);

  React.useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty);
  }, [dirty]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callbacks.current.onDirtyChange?.(false);
      write.current?.abort();
      if (authUrl.current)
        void api(authUrl.current, { method: "DELETE", keepalive: true }).catch(() => {});
    };
  }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    void api<LinkSnapshot>(ROOT, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, configurationVersion, report]);

  React.useEffect(() => {
    if (authorization?.state !== "pending" || !authUrl.current) return;
    const url = authUrl.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<LinkAuthorization>(url, { signal: controller.signal });
        if (controller.signal.aborted || authUrl.current !== url) return;
        setAuthorization(next);
        if (next.state === "connected") {
          authUrl.current = undefined;
          setEditor(undefined);
          setNotice("授权完成，连接已保存。");
          setReload((value) => value + 1);
        } else if (next.state !== "pending") {
          authUrl.current = undefined;
          setError(
            next.state === "cancelled" ? "授权已取消。" : "授权未完成或已过期，请重新开始。",
          );
        } else timer = setTimeout(() => void poll(), 2_000);
      } catch (cause) {
        if (controller.signal.aborted || authUrl.current !== url) return;
        report(cause);
        if (cause instanceof ApiError && [401, 404].includes(cause.status)) {
          authUrl.current = undefined;
          setAuthorization((current) => (current ? { ...current, state: "failed" } : undefined));
        } else {
          timer = setTimeout(() => void poll(), 4_000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [authorization?.id, authorization?.state, report]);

  async function operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    accept: (result: T) => void,
  ) {
    if (write.current) return;
    const controller = new AbortController();
    write.current = controller;
    read.current?.abort();
    setBusy(true);
    setLoading(false);
    setError("");
    setNotice("");
    try {
      const result = await run(controller.signal);
      if (mounted.current && !controller.signal.aborted) accept(result);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        report(cause);
        if (cause instanceof ApiError && cause.status === 409) setReload((value) => value + 1);
      }
    } finally {
      if (write.current === controller) write.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }
  function mutate<T>(path: string, method: string, body: unknown, signal: AbortSignal) {
    return api<T>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }
  function input(): LinkConnectionInput {
    return {
      providerId: editor!.provider.id,
      methodId: editor!.methodId,
      label: editor!.label.trim(),
      expectedRevision: editor!.original?.revision ?? null,
      ...(editor!.original ? { connectionId: editor!.original.id } : {}),
    };
  }
  function saved() {
    setEditor(undefined);
    setCli(undefined);
    setNotice("连接已保存。");
    setReload((value) => value + 1);
  }
  function openEditor(provider: LinkProviderView, original?: MaskedLinkConnection) {
    if (busy || authorization?.state === "pending") return;
    if (dirty && !window.confirm("放弃当前未保存的连接修改？")) return;
    const method =
      provider.connectionMethods.find((item) => item.id === original?.methodId) ??
      provider.connectionMethods.find(
        (item) => item.executionRuntime === "local" && item.availability === "available",
      );
    if (!method) return;
    setEditor({
      provider,
      original,
      methodId: method.id,
      label: original?.label ?? provider.displayName,
      token: "",
    });
    setCli(undefined);
    setAuthorization(undefined);
    setError("");
    setNotice("");
  }
  async function cancelAuthorization() {
    if (!authUrl.current) return;
    const url = authUrl.current;
    await operation(
      (signal) => api(url, { method: "DELETE", signal }),
      () => {
        authUrl.current = undefined;
        setAuthorization(undefined);
        setNotice("授权已取消。");
      },
    );
  }
  function disconnect(connection: MaskedLinkConnection) {
    const pendingUrl =
      editor?.original?.id === connection.id && authorization?.state === "pending"
        ? authUrl.current
        : undefined;
    const target = apiUrl(`${ROOT}/connections/${encodeURIComponent(connection.id)}`);
    void operation(
      async (signal) => {
        if (pendingUrl) {
          try {
            await api(pendingUrl, { method: "DELETE", signal });
          } catch (cause) {
            if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
          }
          if (mounted.current && !signal.aborted && authUrl.current === pendingUrl) {
            authUrl.current = undefined;
            setAuthorization(undefined);
          }
        }
        return mutate(target, "DELETE", { expectedRevision: connection.revision }, signal);
      },
      () => {
        if (editor?.original?.id === connection.id) setEditor(undefined);
        setDeleting(undefined);
        setReload((value) => value + 1);
        setNotice("连接已断开。");
      },
    );
  }
  const method = editor?.provider.connectionMethods.find((item) => item.id === editor.methodId);
  const pending = authorization?.state === "pending";
  const unavailable = busy || pending;
  const needle = query.trim().toLowerCase();
  const providers = (snapshot?.providers ?? []).filter((provider) =>
    `${provider.displayName} ${provider.description.zh}`.toLowerCase().includes(needle),
  );
  const latest =
    editor &&
    snapshot?.connections.find((item) =>
      editor.original
        ? item.id === editor.original.id
        : item.id === `link-${editor.provider.id}-${editor.methodId}` &&
          item.providerId === editor.provider.id &&
          item.methodId === editor.methodId,
    );
  const conflict =
    editor &&
    snapshot &&
    (editor.original ? latest?.revision !== editor.original.revision : !!latest);

  return (
    <section className="hub-links">
      <header className="links-heading">
        <div>
          <h1>Link</h1>
          <p>连接你的工具与账号，让任务访问已授权的服务。</p>
        </div>
        <button
          onClick={() => {
            setError("");
            setReload((value) => value + 1);
          }}
          disabled={busy || loading}
        >
          刷新
        </button>
      </header>
      <p className="links-host">
        连接由{hostLabel}执行，凭据保存在{hostLabel}。CLI 使用这台机器上已有的登录。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="links-notice" role="status">
          {notice}
        </p>
      )}
      {loading && !snapshot && <p role="status">正在加载连接…</p>}
      <h2>已连接</h2>
      {snapshot && snapshot.connections.length === 0 && (
        <p className="links-muted">还没有连接。选择下面的服务开始。</p>
      )}
      <div className="links-connections">
        {snapshot?.connections.map((connection) => {
          const provider = snapshot.providers.find((item) => item.id === connection.providerId);
          return (
            <article key={connection.id} className="links-connection">
              <div>
                <strong>{connection.label}</strong>
                <p>
                  {provider?.displayName ?? connection.providerId} ·{" "}
                  {connection.account?.label ?? connection.account?.id ?? "已授权账号"}
                </p>
                <span className={`links-state ${connection.status === "connected" ? "ready" : ""}`}>
                  {statuses[connection.status]}
                </span>
                <small>
                  {connection.authSource === "cli-session"
                    ? "CLI 登录"
                    : connection.authSource === "browser-oauth"
                      ? "浏览器授权"
                      : "Token"}
                  {connection.expiresAt
                    ? ` · 到期 ${new Date(connection.expiresAt).toLocaleString()}`
                    : ""}
                </small>
                {connection.account?.resources.length ? (
                  <p>{connection.account.resources.join("、")}</p>
                ) : null}
              </div>
              <div className="links-actions">
                {connection.editable ? (
                  <>
                    <button
                      disabled={unavailable || !provider}
                      onClick={() => provider && openEditor(provider, connection)}
                    >
                      管理连接
                    </button>
                    <button disabled={busy} onClick={() => setDeleting(connection)}>
                      断开
                    </button>
                  </>
                ) : (
                  <small>项目配置管理</small>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {deleting && (
        <div className="links-confirm" role="alertdialog" aria-label="断开连接">
          <p>断开「{deleting.label}」后，后续任务将无法使用这个连接，正在执行的请求会尝试停止。</p>
          <button disabled={busy} onClick={() => disconnect(deleting)}>
            确认断开
          </button>
          <button disabled={busy} onClick={() => setDeleting(undefined)}>
            取消
          </button>
        </div>
      )}
      {editor && method && (
        <section className="links-editor" aria-label={`${editor.provider.displayName} 连接设置`}>
          <div className="links-heading">
            <h2>
              {editor.provider.displayName} · {editor.original ? "管理连接" : "添加连接"}
            </h2>
            <button
              disabled={unavailable}
              onClick={() => {
                if (!dirty || window.confirm("放弃未保存的连接修改？")) setEditor(undefined);
              }}
            >
              关闭
            </button>
          </div>
          <label>
            连接名称
            <input
              maxLength={100}
              value={editor.label}
              disabled={unavailable}
              onChange={(event) => setEditor({ ...editor, label: event.target.value })}
            />
          </label>
          {conflict && (
            <div className="links-conflict" role="alert">
              <p>这个连接已在其他设备创建、修改或删除。你的输入仍然保留，请先载入最新版本。</p>
              <button
                disabled={unavailable}
                onClick={() => setEditor({ ...editor, original: latest || undefined })}
              >
                载入最新版本，保留输入
              </button>
            </div>
          )}
          {method.browserAuth && (
            <div className="links-auth-option">
              <h3>浏览器授权</h3>
              {editor.provider.deviceAuth?.configured ? (
                <button
                  disabled={unavailable || !editor.label.trim() || !!conflict}
                  onClick={() => {
                    const workspace = getApiWorkspace() ?? "";
                    const projectId = getApiProject();
                    const target = apiUrl(`${ROOT}/authorizations/device`, workspace, projectId);
                    void operation(
                      (signal) => mutate<LinkAuthorization>(target, "POST", input(), signal),
                      (value) => {
                        authUrl.current = apiUrl(
                          `${ROOT}/authorizations/${encodeURIComponent(value.id)}`,
                          workspace,
                          projectId,
                        );
                        setAuthorization(value);
                      },
                    );
                  }}
                >
                  开始授权
                </button>
              ) : (
                <p className="links-muted">
                  这台{hostLabel}尚未配置此服务的浏览器授权，可使用下面的连接方式。
                </p>
              )}
              {pending && authorization.prompt && (
                <div className="links-device-code" role="status">
                  <p>在服务商页面输入验证码：</p>
                  <strong>{authorization.prompt.userCode}</strong>
                  <p>
                    {safeLinkUrl(
                      authorization.prompt.verificationUriComplete ??
                        authorization.prompt.verificationUri,
                    ) && (
                      <a
                        href={safeLinkUrl(
                          authorization.prompt.verificationUriComplete ??
                            authorization.prompt.verificationUri,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开授权页面 ↗
                      </a>
                    )}
                  </p>
                  <p>
                    完成后会自动保存。有效期至{" "}
                    {new Date(authorization.prompt.expiresAt).toLocaleTimeString()}。
                  </p>
                  <button disabled={busy} onClick={() => void cancelAuthorization()}>
                    取消授权
                  </button>
                </div>
              )}
            </div>
          )}
          {method.quickAuth && (
            <div className="links-auth-option">
              <h3>使用已登录的 CLI</h3>
              <p>
                {hostLabel}需要已安装并登录 {method.quickAuth.command}。
              </p>
              <button
                disabled={unavailable}
                onClick={() =>
                  void operation(
                    (signal) =>
                      api<CliStatus>(
                        `${ROOT}/providers/${encodeURIComponent(editor.provider.id)}/cli`,
                        { signal },
                      ),
                    setCli,
                  )
                }
              >
                检查登录状态
              </button>
              {cli && (
                <p role="status">
                  {cli.authenticated
                    ? `已登录${cli.account ? `：${cli.account}` : ""}`
                    : cli.installed
                      ? "已安装，尚未登录。请在运行服务的机器上登录。"
                      : "尚未安装。"}
                </p>
              )}
              {cli?.authenticated && (
                <button
                  disabled={unavailable || !editor.label.trim() || !!conflict}
                  onClick={() =>
                    void operation(
                      (signal) => mutate(`${ROOT}/connections/cli`, "POST", input(), signal),
                      saved,
                    )
                  }
                >
                  绑定这个登录
                </button>
              )}
            </div>
          )}
          <form
            className="links-auth-option"
            onSubmit={(event) => {
              event.preventDefault();
              if (unavailable || conflict) return;
              void operation(
                (signal) =>
                  editor.original && !editor.token.trim()
                    ? mutate(
                        `${ROOT}/connections/${encodeURIComponent(editor.original.id)}`,
                        "PATCH",
                        { label: editor.label.trim(), expectedRevision: editor.original.revision },
                        signal,
                      )
                    : mutate(
                        `${ROOT}/connections/token`,
                        "POST",
                        { ...input(), token: editor.token.trim() },
                        signal,
                      ),
                saved,
              );
            }}
          >
            <h3>{editor.original ? "名称与 Token" : "使用 Token"}</h3>
            {method.authGuide && (
              <>
                <p>{method.authGuide.summary.zh}</p>
                <div className="links-actions">
                  {safeLinkUrl(method.authGuide.createCredentialUrl) && (
                    <a
                      href={safeLinkUrl(method.authGuide.createCredentialUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      创建凭据 ↗
                    </a>
                  )}
                  {safeLinkUrl(method.authGuide.docsUrl) && (
                    <a
                      href={safeLinkUrl(method.authGuide.docsUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      授权说明 ↗
                    </a>
                  )}
                </div>
                <details>
                  <summary>所需权限与设置步骤</summary>
                  <ul>
                    {method.authGuide.permissions.map((permission) => (
                      <li key={permission.id}>
                        {permission.label}（{permission.level === "required" ? "必需" : "可选"}）
                        {permission.description ? `：${permission.description.zh}` : ""}
                      </li>
                    ))}
                  </ul>
                  <ol>
                    {method.authGuide.steps.map((step, index) => (
                      <li key={index}>{step.zh}</li>
                    ))}
                  </ol>
                </details>
              </>
            )}
            <label>
              {method.tokenLabel ?? editor.provider.tokenLabel}
              <input
                type="password"
                autoComplete="off"
                value={editor.token}
                disabled={unavailable}
                placeholder={
                  editor.original
                    ? "留空保留当前授权，仅修改名称"
                    : (method.tokenPlaceholder ?? editor.provider.tokenPlaceholder)
                }
                onChange={(event) => setEditor({ ...editor, token: event.target.value })}
                required={!editor.original}
                maxLength={16384}
              />
            </label>
            <button
              type="submit"
              className="send"
              disabled={unavailable || !!conflict || !editor.label.trim()}
            >
              {busy
                ? "正在验证并保存…"
                : editor.token.trim() || !editor.original
                  ? "验证并保存"
                  : "保存名称"}
            </button>
          </form>
          <details>
            <summary>可用操作（{editor.provider.actions.length}）</summary>
            <ul>
              {editor.provider.actions.map((action) => (
                <li key={action.id}>
                  <strong>{action.title}</strong>
                  {action.risk === "write" ? " · 执行前需要确认" : ""}
                  <p>{action.description}</p>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      <div className="links-heading">
        <h2>添加服务</h2>
        <input
          type="search"
          aria-label="搜索 Link 服务"
          placeholder="搜索服务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="links-providers">
        {providers.map((provider) => {
          const existing = snapshot?.connections.find(
            (connection) => connection.providerId === provider.id,
          );
          return (
            <article key={provider.id} className="links-provider">
              <div className={`links-brand accent-${provider.accent}`} aria-hidden="true">
                {provider.brandText}
              </div>
              <h3>{provider.displayName}</h3>
              <p>{provider.description.zh}</p>
              <small>{provider.actions.length} 项操作</small>
              <button
                disabled={unavailable || !!(existing && !existing.editable)}
                onClick={() => openEditor(provider, existing)}
              >
                {existing ? (existing.editable ? "管理连接" : "项目配置管理") : "添加连接"}
              </button>
            </article>
          );
        })}
      </div>
      {snapshot && providers.length === 0 && <p className="links-muted">没有匹配的服务。</p>}
    </section>
  );
}
