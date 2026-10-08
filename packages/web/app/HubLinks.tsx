import { rememberRemoteLink } from "./remote-link-authorization.js";
import React from "react";
import { flushSync } from "react-dom";
import type {
  LinkAuthMode,
  LinkAuthorization,
  LinkConnectionInput,
  LinkProviderView,
  LinkSnapshot,
  MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import {
  LinkAuthorizationController,
  LinkAuthorizationStepView,
  getLinkAuthorizationStep,
  selectPreferredLinkAuthMode,
} from "../src/index.js";
import { api, ApiError } from "./auth.js";
import {
  apiUrl,
  captureApiScope,
  getApiWorkspace,
  getApiProject,
  type ApiScope,
} from "./api-context.js";
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
  const [authModeId, setAuthModeId] = React.useState<string>();
  const attemptTargets = React.useRef(new Map<string, { target: string; scope: ApiScope }>());
  const handoffs = React.useRef(new Set<string>());
  const controller = React.useMemo(
    () =>
      new LinkAuthorizationController({
        begin: async (connectionInput, modeId) => {
          const scope = captureApiScope();
          const { workspace, projectId } = scope;
          const value = await api<LinkAuthorization>(
            apiUrl(`${ROOT}/authorizations`, workspace, projectId),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...connectionInput, authModeId: modeId }),
            },
            scope,
          );
          attemptTargets.current.set(value.id, {
            target: apiUrl(
              `${ROOT}/authorizations/${encodeURIComponent(value.id)}`,
              workspace,
              projectId,
            ),
            scope,
          });
          return value;
        },
        status: (id) => {
          const attempt = attemptTargets.current.get(id)!;
          return api<LinkAuthorization>(attempt.target, {}, attempt.scope);
        },
        respond: (id, response) => {
          const attempt = attemptTargets.current.get(id)!;
          const target = new URL(attempt.target, window.location.origin);
          target.pathname += "/responses";
          return api<LinkAuthorization>(
            target.pathname + target.search,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            },
            attempt.scope,
          );
        },
        cancel: async (id) => {
          if (handoffs.current.has(id)) return;
          const attempt = attemptTargets.current.get(id);
          if (!attempt) return;
          await api(attempt.target, { method: "DELETE", keepalive: true }, attempt.scope);
          attemptTargets.current.delete(id);
        },
      }),
    [],
  );
  const flow = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const generic =
    snapshot?.capabilities.authorizationSteps === 1 && Boolean(editor?.provider.authModes);
  const genericPending = generic && flow.authorization?.state === "pending";
  const [reload, setReload] = React.useState(0);
  const mounted = React.useRef(false);
  const lifecycle = React.useRef(0);
  const editorElement = React.useRef<HTMLElement>(null);
  const write = React.useRef<AbortController | undefined>(undefined);
  const authUrl = React.useRef<string | undefined>(undefined);
  const authScope = React.useRef<ApiScope | undefined>(undefined);
  const read = React.useRef<AbortController | undefined>(undefined);
  const callbacks = React.useRef({ onAuthLost, onDirtyChange });
  callbacks.current = { onAuthLost, onDirtyChange };
  const dirty =
    busy ||
    flow.busy ||
    genericPending ||
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
    if (!editor) return;
    const previous = document.activeElement as HTMLElement | null;
    editorElement.current
      ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")
      ?.focus();
    return () => previous?.focus?.();
  }, [Boolean(editor)]);

  React.useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty);
  }, [dirty]);
  React.useEffect(() => {
    mounted.current = true;
    const instance = ++lifecycle.current;
    return () => {
      mounted.current = false;
      callbacks.current.onDirtyChange?.(false);
      write.current?.abort();
      // StrictMode reattaches this same effect synchronously.
      queueMicrotask(() => {
        if (lifecycle.current === instance) controller.dispose();
      });
      if (authUrl.current)
        void api(authUrl.current, { method: "DELETE", keepalive: true }, authScope.current).catch(
          () => {},
        );
    };
  }, [controller]);
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
    if (!generic) return;
    if (flow.error) report(flow.error);
    if (flow.authorization?.state === "connected" && flow.authorization.connection) {
      setEditor(undefined);
      setNotice("授权完成，连接已保存。");
      setReload((value) => value + 1);
    }
  }, [generic, flow.authorization, flow.error, report]);

  React.useEffect(() => {
    if (!snapshot?.remoteCleanupPending) return;
    const timer = setInterval(() => setReload((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [snapshot?.remoteCleanupPending]);

  React.useEffect(() => {
    if (authorization?.state !== "pending" || !authUrl.current) return;
    const url = authUrl.current;
    const scope = authScope.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<LinkAuthorization>(url, { signal: controller.signal }, scope);
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
        if (cause instanceof ApiError && [409, 503].includes(cause.status))
          setReload((value) => value + 1);
      }
    } finally {
      if (write.current === controller) write.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }
  function mutate<T>(
    path: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
    scope?: ApiScope,
  ) {
    return api<T>(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      scope,
    );
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
    if (busy || flow.busy || genericPending || authorization?.state === "pending") return;
    if (dirty && !window.confirm("放弃当前未保存的连接修改？")) return;
    controller.reset();
    // A new connection follows the provider default across all methods. Managing
    // an existing connection keeps its explicit credential/runtime method.
    const preferred = original
      ? selectPreferredLinkAuthMode(provider, original.methodId)
      : selectPreferredLinkAuthMode(provider);
    const method = original
      ? provider.connectionMethods.find((item) => item.id === original.methodId)
      : (provider.connectionMethods.find((item) => item.id === preferred?.methodId) ??
        provider.connectionMethods.find(
          (item) => item.executionRuntime === "local" && item.availability === "available",
        ));
    if (!method) {
      setError("当前环境未提供此连接的授权方式，请检查服务器连接设置。");
      return;
    }
    const next: Editor = {
      provider,
      original,
      methodId: method.id,
      label: original?.label ?? provider.displayName,
      token: "",
    };
    setEditor(next);
    setCli(undefined);
    setAuthorization(undefined);
    setAuthModeId(preferred?.id);
    setError("");
    setNotice("");
    if (!original && snapshot?.capabilities.authorizationSteps === 1 && preferred)
      void beginGeneric(next, preferred);
  }
  async function beginGeneric(next: Editor, mode: LinkAuthMode) {
    if (!mode.available || !next.label.trim()) return;
    if (controller.getSnapshot().authorization?.state === "pending") {
      await controller.cancel();
      if (controller.getSnapshot().authorization?.state === "pending") return;
    }
    setError("");
    setAuthModeId(mode.id);
    setEditor({ ...next, methodId: mode.methodId });
    const scope = { workspace: getApiWorkspace() ?? "", projectId: getApiProject() };
    const value = await controller.begin(
      {
        providerId: next.provider.id,
        methodId: mode.methodId,
        label: next.label.trim(),
        expectedRevision: next.original?.revision ?? null,
        ...(next.original ? { connectionId: next.original.id } : {}),
      },
      mode.id,
    );
    if (value?.state !== "pending" || getLinkAuthorizationStep(value)?.kind !== "redirect") return;
    try {
      const issuer = snapshot?.remoteServer?.issuer;
      if (!issuer) throw new Error("当前 Host 尚未配置授权服务。");
      const url = rememberRemoteLink(value, issuer, scope);
      handoffs.current.add(value.id);
      flushSync(() => {
        setEditor(undefined);
        callbacks.current.onDirtyChange?.(false);
      });
      window.location.assign(url);
    } catch (cause) {
      await controller.cancel();
      report(cause);
    }
  }
  async function cancelAuthorization() {
    if (genericPending) {
      await controller.cancel();
      if (controller.getSnapshot().authorization?.state === "cancelled") setNotice("授权已取消。");
      return;
    }
    if (!authUrl.current) return;
    const url = authUrl.current;
    const scope = authScope.current;
    await operation(
      (signal) => api(url, { method: "DELETE", signal }, scope),
      () => {
        authUrl.current = undefined;
        setAuthorization(undefined);
        setNotice("授权已取消。");
      },
    );
  }
  function closeEditor() {
    if (generic) {
      void controller.cancel().then(() => {
        if (controller.getSnapshot().authorization?.state !== "pending") setEditor(undefined);
      });
    } else if (!unavailable && (!dirty || window.confirm("放弃未保存的连接修改？")))
      setEditor(undefined);
  }
  function disconnect(connection: MaskedLinkConnection, scope = captureApiScope()) {
    if (
      generic &&
      controller.getSnapshot().authorization?.state === "pending" &&
      editor?.original?.id === connection.id
    ) {
      void controller.cancel().then(() => {
        if (controller.getSnapshot().authorization?.state !== "pending")
          disconnect(connection, scope);
      });
      return;
    }
    const pendingUrl =
      editor?.original?.id === connection.id && authorization?.state === "pending"
        ? authUrl.current
        : undefined;
    const target = apiUrl(
      `${ROOT}/connections/${encodeURIComponent(connection.id)}`,
      scope.workspace,
      scope.projectId,
    );
    const pendingScope = authScope.current;
    void operation(
      async (signal) => {
        if (pendingUrl) {
          try {
            await api(pendingUrl, { method: "DELETE", signal }, pendingScope);
          } catch (cause) {
            if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
          }
          if (mounted.current && !signal.aborted && authUrl.current === pendingUrl) {
            authUrl.current = undefined;
            setAuthorization(undefined);
          }
        }
        return mutate(target, "DELETE", { expectedRevision: connection.revision }, signal, scope);
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
  const unavailable = busy || flow.busy || pending || genericPending;
  const needle = query.trim().toLowerCase();
  const providers = (snapshot?.providers ?? []).filter(
    (provider) =>
      (snapshot?.capabilities.authorizationSteps !== 1 ||
        provider.authModes?.some((mode) => mode.available)) &&
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
      {!!snapshot?.remoteCleanupPending && (
        <p role="status" className="links-muted">
          有 {snapshot.remoteCleanupPending} 项遗留授权等待撤销。项目所在环境
          会自动重试，重启后仍会继续；也可在 Link 服务中撤销。
        </p>
      )}
      <p className="links-host">
        连接由当前项目所属的{hostLabel}管理，授权后只访问你允许的服务与资源。
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
                  {connection.authSource === "remote-link"
                    ? "独立 Link 授权"
                    : connection.authSource === "cli-session"
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
        <>
          <div className="links-editor-backdrop" aria-hidden="true" />
          <section
            className="links-editor"
            ref={editorElement}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeEditor();
              }
              if (event.key !== "Tab") return;
              const controls = editorElement.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), a[href], summary",
              );
              if (!controls?.length) return;
              const first = controls[0],
                last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`${editor.provider.displayName} 连接设置`}
          >
            <div className="links-heading">
              <h2>
                {editor.provider.displayName} · {editor.original ? "管理连接" : "添加连接"}
              </h2>
              <button disabled={!generic && unavailable} onClick={closeEditor}>
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
            {generic ? (
              <div className="links-authorization">
                <p className="links-muted">
                  {method.executionRuntime === "server"
                    ? "由 Link 服务保存授权并访问已选择的资源。"
                    : `连接保存到当前项目所属的${hostLabel}。`}
                </p>
                {flow.authorization ? (
                  <LinkAuthorizationStepView
                    authorization={flow.authorization}
                    busy={flow.busy || !!conflict}
                    onRespond={(response) => {
                      void controller.respond(response);
                    }}
                    onOpenUrl={(url) => {
                      window.open(url, "_blank", "noopener,noreferrer");
                    }}
                    onCopy={(value) => {
                      void navigator.clipboard?.writeText(value).catch(report);
                    }}
                  />
                ) : (
                  <button
                    disabled={flow.busy || !!conflict || !editor.label.trim()}
                    onClick={() => {
                      const selected =
                        editor.provider.authModes?.find(
                          (mode) => mode.id === authModeId && mode.available,
                        ) ?? selectPreferredLinkAuthMode(editor.provider, editor.methodId);
                      if (selected) void beginGeneric(editor, selected);
                    }}
                  >
                    {flow.busy ? "正在连接…" : editor.original ? "重新连接" : "开始连接"}
                  </button>
                )}
                <div className="links-actions">
                  {genericPending && (
                    <button disabled={flow.busy} onClick={() => void cancelAuthorization()}>
                      取消授权
                    </button>
                  )}
                  {flow.authorization && flow.authorization.state !== "pending" && (
                    <button
                      disabled={flow.busy || !!conflict || !editor.label.trim()}
                      onClick={() => {
                        const selected = editor.provider.authModes?.find(
                          (mode) => mode.id === authModeId && mode.available,
                        );
                        if (selected) void beginGeneric(editor, selected);
                      }}
                    >
                      重新连接
                    </button>
                  )}
                </div>
                <details className="links-other-methods">
                  <summary>其他连接方式</summary>
                  <div className="links-methods">
                    {editor.provider.authModes?.map((mode) => (
                      <button
                        key={mode.id}
                        disabled={
                          flow.busy || !mode.available || !!conflict || !editor.label.trim()
                        }
                        title={mode.unavailableReason}
                        onClick={() => void beginGeneric(editor, mode)}
                      >
                        {mode.label}
                        {mode.id === authModeId ? " · 当前" : ""}
                      </button>
                    ))}
                  </div>
                </details>
                {editor.original && (
                  <button
                    disabled={unavailable || !!conflict || !editor.label.trim()}
                    onClick={() =>
                      void operation(
                        (signal) =>
                          mutate(
                            `${ROOT}/connections/${encodeURIComponent(editor.original!.id)}`,
                            "PATCH",
                            {
                              label: editor.label.trim(),
                              expectedRevision: editor.original!.revision,
                            },
                            signal,
                          ),
                        saved,
                      )
                    }
                  >
                    保存名称
                  </button>
                )}
              </div>
            ) : (
              <>
                {method.browserAuth && (
                  <div className="links-auth-option">
                    <h3>浏览器授权</h3>
                    {editor.provider.deviceAuth?.configured ? (
                      <button
                        disabled={unavailable || !editor.label.trim() || !!conflict}
                        onClick={() => {
                          const workspace = getApiWorkspace() ?? "";
                          const projectId = getApiProject();
                          const scope = { workspace, projectId };
                          const target = apiUrl(
                            `${ROOT}/authorizations/device`,
                            workspace,
                            projectId,
                          );
                          void operation(
                            (signal) =>
                              mutate<LinkAuthorization>(target, "POST", input(), signal, scope),
                            (value) => {
                              authUrl.current = apiUrl(
                                `${ROOT}/authorizations/${encodeURIComponent(value.id)}`,
                                workspace,
                                projectId,
                              );
                              authScope.current = scope;
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
                {method.authKind === "token" && (
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
                                {
                                  label: editor.label.trim(),
                                  expectedRevision: editor.original.revision,
                                },
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
                                {permission.label}（
                                {permission.level === "required" ? "必需" : "可选"}）
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
                )}
              </>
            )}
            <details>
              <summary>
                {generic ? "服务支持的操作" : "可用操作"}（{editor.provider.actions.length}）
              </summary>
              {generic && (
                <p className="links-muted">此连接实际可用的操作以授权时确认的权限为准。</p>
              )}
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
        </>
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
                disabled={
                  unavailable ||
                  (snapshot?.capabilities.authorizationSteps !== 1 &&
                    !!(existing && !existing.editable))
                }
                onClick={() =>
                  openEditor(
                    provider,
                    snapshot?.capabilities.authorizationSteps === 1 ? undefined : existing,
                  )
                }
              >
                {snapshot?.capabilities.authorizationSteps === 1
                  ? "添加连接"
                  : existing
                    ? existing.editable
                      ? "管理连接"
                      : "项目配置管理"
                    : "添加连接"}
              </button>
            </article>
          );
        })}
      </div>
      {snapshot && providers.length === 0 && <p className="links-muted">没有匹配的服务。</p>}
    </section>
  );
}
