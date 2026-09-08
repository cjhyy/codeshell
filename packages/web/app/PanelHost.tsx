import React from "react";
import type { ManagedPanel } from "../../server/src/panels/types.js";
import { api, ApiError } from "./auth.js";
import { apiUrl, getApiWorkspace } from "./api-context.js";
import { connectPanelRuntime, type PanelRuntimeEvent } from "./panel-runtime-connection.js";
import "./panel-host.css";

const ROOT = "/api/v1/panels/runtime";
interface PreparedPanel {
  instanceId: string;
  src: string;
  expiresAt: number;
  context: Record<string, unknown>;
  limitations: string[];
}
type PanelEffect =
  | { effect: "agent.submitPrompt"; prompt: string; sessionId: string }
  | { effect: "external.open"; url: string }
  | { effect: "host.confirm"; requestId: string; title: string; body: string; expiresAt: number };
interface Confirmation {
  effect: PanelEffect;
  finish: (approved: boolean) => void;
  cancel: () => void;
}
export interface PanelHostProps {
  panel: ManagedPanel;
  sessionId: string;
  busy: boolean;
  onClose: () => void;
  onAuthLost: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmitPrompt: (input: { prompt: string; sessionId: string }) => Promise<{ accepted: true }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeExternalUrl(value: unknown): string | undefined {
  try {
    if (typeof value !== "string" || value.length > 2048) return;
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    /* The parent rejects malformed effect payloads. */
  }
}
function safeDirectoryUrl(value: unknown, instanceId: string): value is string {
  const prefix = `${ROOT}/${instanceId}/directory/`;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.slice(prefix.length),
    )
  );
}
function safeAssetPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\/api\/v1\/panel-assets\/[A-Za-z0-9_-]{20,128}\/[A-Za-z0-9_%./-]+$/.test(value)
  )
    return false;
  try {
    return value
      .split("/")
      .slice(5)
      .every((part) => {
        const decoded = decodeURIComponent(part);
        return !!decoded && !decoded.startsWith(".") && !/[\\/:\u0000-\u001f\u007f]/.test(decoded);
      });
  } catch {
    return false;
  }
}
function validPrepared(value: unknown): value is PreparedPanel {
  if (!isRecord(value)) return false;
  return (
    typeof value.instanceId === "string" &&
    /^[A-Za-z0-9_-]{20,128}$/.test(value.instanceId) &&
    safeAssetPath(value.src) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    isRecord(value.context) &&
    Array.isArray(value.limitations) &&
    value.limitations.every((item) => typeof item === "string")
  );
}

/** The iframe is untrusted. Only the authenticated parent can reach host APIs. */
export function PanelHost({
  panel,
  sessionId,
  busy,
  onClose,
  onAuthLost,
  onDirtyChange,
  onSubmitPrompt,
}: PanelHostProps) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [prepared, setPrepared] = React.useState<PreparedPanel>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [directory, setDirectory] = React.useState<{ path: string; url?: string }>();
  const [connectionStatus, setConnectionStatus] = React.useState("");
  const [confirmationError, setConfirmationError] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<Confirmation>();
  const [confirming, setConfirming] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const callbacks = React.useRef({ onClose, onAuthLost, onDirtyChange, onSubmitPrompt, busy });
  callbacks.current = { onClose, onAuthLost, onDirtyChange, onSubmitPrompt, busy };
  const authReported = React.useRef(false);
  const activeConfirmation = React.useRef<Confirmation | undefined>(undefined);
  const frameLifecycle = React.useRef<{ loaded: () => void } | undefined>(undefined);
  const confirmationElement = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    callbacks.current.onDirtyChange?.(!!confirmation || confirming);
    if (confirmation) {
      confirmationElement.current?.focus();
      confirmationElement.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [confirmation, confirming]);

  React.useEffect(() => {
    const workspace = getApiWorkspace() ?? "";
    const scope = { workspace, grant: undefined as PreparedPanel | undefined };
    const prepareController = new AbortController();
    const calls = new Set<AbortController>();
    const seen = new Set<string>();
    let disposed = false;
    let connection: ReturnType<typeof connectPanelRuntime> | undefined;
    const queuedEvents: PanelRuntimeEvent[] = [];
    const queuedConfirmations: Array<Extract<PanelEffect, { effect: "host.confirm" }>> = [];
    const confirmationIds = new Set<string>();
    const pendingTools = new Set<string>();
    let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
    let closeRequested = false;
    let submissionActive = false;
    let loaded = false;
    let bridgeReady = false;
    const flushEvents = () => {
      const child = frame.current?.contentWindow;
      if (disposed || !scope.grant || !child || !bridgeReady) return;
      for (const event of queuedEvents.splice(0)) {
        if (
          event.event === "tools.invoke" &&
          isRecord(event.payload) &&
          typeof event.payload.requestId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(event.payload.requestId)
        )
          pendingTools.add(event.payload.requestId);
        child.postMessage(
          {
            type: "codeshell-panel:event",
            instanceId: scope.grant.instanceId,
            event: event.event,
            payload: event.payload,
          },
          "*",
        );
      }
    };
    const ready = () => {
      if (disposed || !loaded || !bridgeReady || !scope.grant) return;
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      setLoading(false);
      flushEvents();
    };
    const lifecycle = {
      loaded: () => {
        loaded = true;
        ready();
      },
    };
    frameLifecycle.current = lifecycle;
    setPrepared(undefined);
    setLoading(true);
    setError("");
    setNotice("");
    setDirectory(undefined);
    setConnectionStatus("");
    setConfirmationError("");
    setConfirmation(undefined);
    setConfirming(false);

    const closeGrant = (grant: PreparedPanel) => {
      if (closeRequested) return;
      closeRequested = true;
      void api(apiUrl(`${ROOT}/${encodeURIComponent(grant.instanceId)}`, workspace), {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    };
    const report = (cause: unknown) => {
      if (disposed) return;
      if (cause instanceof ApiError && cause.status === 401 && !authReported.current) {
        authReported.current = true;
        callbacks.current.onAuthLost();
      }
      setError(cause instanceof Error ? cause.message : "面板连接失败，请重新打开。");
    };
    const terminate = (cause: Error) => {
      if (disposed || !scope.grant) return;
      const grant = scope.grant;
      scope.grant = undefined;
      connection?.stop();
      activeConfirmation.current?.cancel();
      queuedConfirmations.length = 0;
      queuedEvents.length = 0;
      closeGrant(grant);
      for (const call of calls) call.abort();
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      setPrepared(undefined);
      setDirectory(undefined);
      setLoading(false);
      setConfirming(false);
      setConnectionStatus("");
      report(cause);
    };
    const contextual = (context: Record<string, unknown>) => ({
      ...context,
      ...(typeof context.sessionId === "string" ? { busy: callbacks.current.busy } : {}),
    });
    const reply = (source: WindowProxy, requestId: string, result?: unknown, failure?: string) => {
      if (disposed || !scope.grant || source !== frame.current?.contentWindow) return;
      source.postMessage(
        {
          type: "codeshell-panel:response",
          instanceId: scope.grant.instanceId,
          requestId,
          ...(failure ? { error: failure } : { result }),
        },
        "*",
      );
    };
    const showNextHostConfirmation = () => {
      if (disposed || !scope.grant || activeConfirmation.current || submissionActive) return;
      const effect = queuedConfirmations.shift();
      if (!effect) return;
      if (effect.expiresAt <= Date.now()) {
        showNextHostConfirmation();
        return;
      }
      let sending = false;
      const pending: Confirmation = {
        effect,
        cancel: () => {
          if (activeConfirmation.current !== pending) return;
          clearTimeout(timer);
          activeConfirmation.current = undefined;
          if (!disposed) {
            setConfirmation(undefined);
            setConfirmationError("");
            setConfirming(false);
          }
        },
        finish: (allowed) => {
          if (disposed || !scope.grant || activeConfirmation.current !== pending || sending) return;
          sending = true;
          setConfirming(true);
          setConfirmationError("");
          const controller = new AbortController();
          calls.add(controller);
          const timeout = setTimeout(() => controller.abort(), 8_000);
          void api<{ allowed?: boolean }>(
            apiUrl(`${ROOT}/${scope.grant.instanceId}/confirm`, workspace),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requestId: effect.requestId, allowed }),
              signal: controller.signal,
            },
          )
            .then((result) => {
              if (disposed || activeConfirmation.current !== pending) return;
              if (typeof result.allowed !== "boolean") throw new Error("确认响应无效。");
              if (allowed && result.allowed === false)
                setNotice("此确认已超时或被取消，操作未获准执行，请在面板中重新发起。");
              if (!allowed && result.allowed === true)
                setNotice("该操作此前已获准执行，请在面板中查看进度或停止。");
              pending.cancel();
              showNextHostConfirmation();
            })
            .catch((cause) => {
              if (disposed || activeConfirmation.current !== pending) return;
              if (cause instanceof ApiError && [401, 403, 410].includes(cause.status)) {
                terminate(cause);
                return;
              }
              if (cause instanceof ApiError && cause.status === 409) {
                pending.cancel();
                setNotice("面板操作确认已失效，请在面板中重新发起。");
                showNextHostConfirmation();
                return;
              }
              setConfirmationError("暂未收到确认结果。可以重试本次确认，或取消尚未执行的请求。");
            })
            .finally(() => {
              clearTimeout(timeout);
              calls.delete(controller);
              sending = false;
              if (!disposed && activeConfirmation.current === pending) setConfirming(false);
            });
        },
      };
      const timer = setTimeout(() => {
        pending.cancel();
        if (!disposed && scope.grant) {
          setNotice("面板操作确认已超时，请在面板中重新发起。");
          showNextHostConfirmation();
        }
      }, effect.expiresAt - Date.now());
      activeConfirmation.current = pending;
      setConfirmation(pending);
      setConfirmationError("");
    };
    const receiveEvents = (events: PanelRuntimeEvent[]) => {
      for (const event of events) {
        if (event.event !== "host.confirm") {
          queuedEvents.push(event);
          continue;
        }
        const payload = event.payload;
        if (
          !isRecord(payload) ||
          typeof payload.requestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId) ||
          typeof payload.title !== "string" ||
          payload.title.length > 500 ||
          typeof payload.body !== "string" ||
          payload.body.length > 30_000
        )
          throw new Error("面板操作确认格式无效。");
        if (!confirmationIds.has(payload.requestId)) {
          confirmationIds.add(payload.requestId);
          queuedConfirmations.push({
            effect: "host.confirm",
            requestId: payload.requestId,
            title: payload.title,
            body: payload.body,
            expiresAt: Date.now() + 50_000,
          });
        }
      }
      if (queuedEvents.length > 2048 || queuedConfirmations.length > 32) {
        terminate(new Error("面板状态积压过多，请重新打开面板。"));
        return;
      }
      showNextHostConfirmation();
      flushEvents();
    };
    const confirm = (effect: Exclude<PanelEffect, { effect: "host.confirm" }>): Promise<boolean> =>
      new Promise((resolve) => {
        if (activeConfirmation.current || submissionActive) {
          resolve(false);
          return;
        }
        const pending: Confirmation = {
          effect,
          finish: (approved) => {
            if (activeConfirmation.current !== pending) return;
            clearTimeout(timer);
            activeConfirmation.current = undefined;
            if (!disposed) setConfirmation(undefined);
            resolve(approved);
            queueMicrotask(showNextHostConfirmation);
          },
          cancel: () => pending.finish(false),
        };
        const timer = setTimeout(() => pending.finish(false), 55_000);
        activeConfirmation.current = pending;
        setConfirmation(pending);
      });
    const handle = async (event: MessageEvent) => {
      const child = frame.current?.contentWindow;
      const grant = scope.grant;
      const data = event.data;
      if (
        disposed ||
        !child ||
        event.source !== child ||
        event.origin !== "null" ||
        !grant ||
        !isRecord(data) ||
        data.instanceId !== grant.instanceId
      )
        return;
      if (data.type === "codeshell-panel:ready") {
        bridgeReady = true;
        ready();
        return;
      }
      if (data.type === "codeshell-panel:tool-result") {
        if (
          typeof data.requestId !== "string" ||
          !pendingTools.has(data.requestId) ||
          calls.size >= 32
        )
          return;
        let payload: string;
        try {
          payload = JSON.stringify({
            requestId: data.requestId,
            ...(typeof data.error === "string" ? { error: data.error } : { result: data.result }),
          });
          if (new TextEncoder().encode(payload).length > 512 * 1024) return;
        } catch {
          return;
        }
        pendingTools.delete(data.requestId);
        const controller = new AbortController();
        calls.add(controller);
        const timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          await api(apiUrl(`${ROOT}/${grant.instanceId}/tool-results`, workspace), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            signal: controller.signal,
          });
        } catch (cause) {
          if (!disposed && scope.grant) {
            if (cause instanceof ApiError && [401, 410].includes(cause.status)) terminate(cause);
            else setNotice("面板工具结果未能送达，请在对话中重新发起操作。");
          }
        } finally {
          clearTimeout(timeout);
          calls.delete(controller);
        }
        return;
      }
      if (
        data.type !== "codeshell-panel:call" ||
        typeof data.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(data.requestId)
      )
        return;
      const requestId = data.requestId;
      if (seen.has(requestId)) {
        reply(child, requestId, undefined, "此请求已经处理，请重新发起。");
        return;
      }
      if (seen.size >= 8192 || calls.size >= 32) {
        reply(child, requestId, undefined, "面板请求过于频繁，请稍后重试。");
        return;
      }
      seen.add(requestId);
      if (typeof data.method !== "string" || !/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(data.method)) {
        reply(child, requestId, undefined, "面板方法无效。");
        return;
      }
      let payload: string;
      try {
        payload = JSON.stringify({ method: data.method, params: data.params });
        if (payload.length > 2 * 1024 * 1024) throw new Error("too large");
      } catch {
        reply(child, requestId, undefined, "面板请求内容过大或格式无效。");
        return;
      }
      const controller = new AbortController();
      let submitting = false;
      calls.add(controller);
      try {
        const result = await api<unknown>(apiUrl(`${ROOT}/${grant.instanceId}/call`, workspace), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        if (disposed || controller.signal.aborted) return;
        if (data.method === "context.get") {
          bridgeReady = true;
          ready();
        }
        if (data.method === "external.open") {
          const url =
            isRecord(result) && result.effect === data.method
              ? safeExternalUrl(result.url)
              : undefined;
          if (!url) throw new Error("面板返回的外部链接无效。");
          if (!(await confirm({ effect: "external.open", url })))
            throw new Error("你取消了打开链接，或确认已超时。");
          reply(child, requestId, { opened: true });
        } else if (data.method === "agent.submitPrompt") {
          if (
            !isRecord(result) ||
            result.effect !== data.method ||
            typeof result.prompt !== "string" ||
            !result.prompt.trim() ||
            result.prompt.length > 20000 ||
            result.sessionId !== sessionId
          )
            throw new Error("面板任务与当前对话不匹配，请重新打开面板。");
          if (!(await confirm({ effect: "agent.submitPrompt", prompt: result.prompt, sessionId })))
            throw new Error("你取消了发送任务，或确认已超时。");
          if (disposed || controller.signal.aborted) return;
          submitting = true;
          submissionActive = true;
          setConfirming(true);
          const accepted = await callbacks.current.onSubmitPrompt({
            prompt: result.prompt,
            sessionId,
          });
          if (disposed || controller.signal.aborted) return;
          setNotice("面板任务已提交到当前对话，可切换到对话查看进度。");
          reply(child, requestId, accepted);
        } else if (data.method === "filesystem.openDirectory") {
          setDirectory(undefined);
          if (!isRecord(result) || result.effect !== data.method || typeof result.path !== "string")
            throw new Error("面板目录信息无效。");
          if (result.url !== undefined && !safeDirectoryUrl(result.url, grant.instanceId))
            throw new Error("面板目录链接无效，请重新打开目录。");
          setDirectory({
            path: result.path,
            ...(typeof result.url === "string" ? { url: apiUrl(result.url, workspace) } : {}),
          });
          reply(child, requestId, { opened: false, path: result.path });
        } else if (data.method === "notifications.send") {
          if (
            !isRecord(result) ||
            result.effect !== data.method ||
            typeof result.title !== "string" ||
            result.title.length > 160 ||
            typeof result.body !== "string" ||
            result.body.length > 2000
          )
            throw new Error("面板通知格式无效。");
          setNotice(`${result.title}${result.body ? `：${result.body}` : ""}`);
          reply(child, requestId, { sent: true });
        } else
          reply(
            child,
            requestId,
            data.method === "context.get" && isRecord(result) ? contextual(result) : result,
          );
      } catch (cause) {
        if (!disposed && !controller.signal.aborted) {
          if (cause instanceof ApiError && [401, 410].includes(cause.status)) terminate(cause);
          if (data.method === "agent.submitPrompt" || data.method === "external.open")
            setNotice(cause instanceof Error ? cause.message : "面板操作未完成。");
          reply(
            child,
            requestId,
            undefined,
            cause instanceof Error ? cause.message : "面板请求失败。",
          );
        }
      } finally {
        calls.delete(controller);
        if (submitting) {
          submissionActive = false;
          if (!disposed) setConfirming(false);
          showNextHostConfirmation();
        }
      }
    };
    const listener = (event: MessageEvent) => {
      void handle(event);
    };
    window.addEventListener("message", listener);
    const resume = () => connection?.refresh();
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visibility);
    void api<unknown>(apiUrl(`${ROOT}/prepare`, workspace), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: panel.id,
        revision: panel.revision,
        ...(sessionId ? { sessionId } : {}),
        theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
        locale: "zh-CN",
      }),
      signal: prepareController.signal,
    })
      .then((value) => {
        if (!validPrepared(value)) throw new Error("面板启动信息无效，请刷新面板列表后重试。");
        if (disposed || prepareController.signal.aborted) {
          closeGrant(value);
          return;
        }
        if (value.expiresAt <= Date.now()) {
          closeGrant(value);
          throw new Error("面板授权已过期，请重新打开。");
        }
        scope.grant = value;
        setPrepared({ ...value, src: apiUrl(value.src, workspace) });
        handshakeTimeout = setTimeout(() => {
          terminate(
            new Error(
              "面板未能完成加载，请重新打开。若仍无法加载，可检查面板文件或使用桌面客户端。",
            ),
          );
        }, 45_000);
        connection = connectPanelRuntime({
          instanceId: value.instanceId,
          expiresAt: value.expiresAt,
          workspace,
          onEvents: receiveEvents,
          onTerminal: terminate,
          onStatus: setConnectionStatus,
        });
      })
      .catch((cause) => {
        if (!disposed && !prepareController.signal.aborted) {
          setLoading(false);
          report(cause);
        }
      });
    return () => {
      disposed = true;
      activeConfirmation.current?.cancel();
      window.removeEventListener("message", listener);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visibility);
      connection?.stop();
      prepareController.abort();
      for (const call of calls) call.abort();
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      if (scope.grant) closeGrant(scope.grant);
      callbacks.current.onDirtyChange?.(false);
      if (frameLifecycle.current === lifecycle) frameLifecycle.current = undefined;
    };
  }, [panel.id, panel.revision, sessionId, reload]);

  React.useEffect(() => {
    if (!prepared || !frame.current?.contentWindow) return;
    frame.current.contentWindow.postMessage(
      {
        type: "codeshell-panel:event",
        instanceId: prepared.instanceId,
        event: "context.changed",
        payload: {
          ...prepared.context,
          ...(typeof prepared.context.sessionId === "string" ? { busy } : {}),
        },
      },
      "*",
    );
  }, [busy, prepared]);

  return (
    <section className="panel-host">
      <header className="panel-host-heading">
        <div>
          <h1>{panel.title["zh-CN"] || panel.title.default}</h1>
          <p>v{panel.version} · 运行于当前工作区</p>
        </div>
        <button onClick={onClose}>返回面板</button>
      </header>
      {(prepared?.limitations ?? panel.compatibility.reasons).length > 0 && (
        <details className="panel-host-limitations" open>
          <summary>部分功能可用</summary>
          <p>面板界面可以使用；以下功能尚未接入网页，使用时会显示具体限制。</p>
          <ul>
            {(prepared?.limitations ?? panel.compatibility.reasons).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
      {notice && (
        <p className="panel-host-notice" role="status">
          {notice}
        </p>
      )}
      {directory && (
        <div className="panel-host-notice panel-host-directory" role="status">
          <p>文件保存在服务器目录：{directory.path}</p>
          {directory.url && (
            <a href={directory.url} target="_blank" rel="noopener noreferrer">
              查看并下载文件
            </a>
          )}
        </div>
      )}
      {connectionStatus && (
        <p className="panel-host-notice" role="status">
          {connectionStatus}
        </p>
      )}
      {error && (
        <div className="panel-host-error" role="alert">
          <p>{error}</p>
          <button disabled={loading} onClick={() => setReload((value) => value + 1)}>
            重新打开面板
          </button>
        </div>
      )}
      {loading && (
        <p className="panel-host-loading" role="status">
          正在打开面板…
        </p>
      )}
      {confirmation && (
        <section
          className="panel-host-confirm"
          ref={confirmationElement}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !confirming) {
              event.preventDefault();
              confirmation.finish(false);
            }
          }}
          aria-label={
            confirmation.effect.effect === "external.open"
              ? "确认打开外部链接"
              : confirmation.effect.effect === "host.confirm"
                ? "确认面板操作"
                : "确认发送面板任务"
          }
        >
          <h2>
            {confirmation.effect.effect === "external.open"
              ? "面板请求打开网页"
              : confirmation.effect.effect === "host.confirm"
                ? confirmation.effect.title
                : "面板请求向当前对话发送任务"}
          </h2>
          {confirmation.effect.effect === "external.open" ? (
            <p className="panel-host-url">{confirmation.effect.url}</p>
          ) : confirmation.effect.effect === "host.confirm" ? (
            <pre>{confirmation.effect.body}</pre>
          ) : (
            <pre>{confirmation.effect.prompt}</pre>
          )}
          {confirmationError && <p role="alert">{confirmationError}</p>}
          <div className="panel-host-actions">
            <button disabled={confirming} onClick={() => confirmation.finish(false)}>
              取消
            </button>
            {confirmation.effect.effect === "external.open" ? (
              <a
                href={confirmation.effect.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => confirmation.finish(true)}
              >
                确认打开网页
              </a>
            ) : (
              <button
                className="panel-host-primary"
                disabled={confirming}
                onClick={() => confirmation.finish(true)}
              >
                {confirming
                  ? "正在确认…"
                  : confirmation.effect.effect === "host.confirm"
                    ? "确认执行"
                    : "确认发送任务"}
              </button>
            )}
          </div>
        </section>
      )}
      {prepared && (
        <iframe
          ref={frame}
          src={prepared.src}
          title={`${panel.title["zh-CN"] || panel.title.default}面板`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          inert={!!confirmation || confirming}
          onLoad={() => frameLifecycle.current?.loaded()}
          allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'"
          className="panel-host-frame"
        />
      )}
    </section>
  );
}
