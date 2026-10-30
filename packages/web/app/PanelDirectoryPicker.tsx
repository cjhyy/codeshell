import React from "react";
import { ApiError } from "./auth.js";
import "./panel-directory-picker.css";

export interface PanelDirectoryDescription {
  kind: "workspace-directory";
  rootPath: string;
  rootToken: string;
  initialToken: string;
}
interface DirectoryListing {
  requestId: string;
  directoryToken: string;
  relativePath: string;
  name: string;
  parentToken?: string;
  rootToken: string;
  directories: Array<{ name: string; token: string }>;
  truncated: boolean;
}
export interface PanelDirectoryRequest {
  requestId: string;
  title: string;
  description: PanelDirectoryDescription;
  list: (token: string, signal: AbortSignal) => Promise<unknown>;
  finish: (allowed: boolean, token?: string) => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const directoryToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{24}$/.test(value);
const pathText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
export function validDirectoryDescription(value: unknown): value is PanelDirectoryDescription {
  return (
    record(value) &&
    value.kind === "workspace-directory" &&
    pathText(value.rootPath) &&
    !!value.rootPath &&
    directoryToken(value.rootToken) &&
    directoryToken(value.initialToken)
  );
}
function listing(value: unknown, request: PanelDirectoryRequest, token: string): DirectoryListing {
  if (
    !record(value) ||
    value.requestId !== request.requestId ||
    value.directoryToken !== token ||
    value.rootToken !== request.description.rootToken ||
    !pathText(value.relativePath) ||
    !pathText(value.name) ||
    !value.name ||
    (value.parentToken !== undefined && !directoryToken(value.parentToken)) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.directories) ||
    value.directories.length > 200 ||
    !value.directories.every(
      (child) => record(child) && pathText(child.name) && child.name && directoryToken(child.token),
    )
  )
    throw new Error("目录响应无效，请重试或取消后重新打开。");
  return value as unknown as DirectoryListing;
}

/** Trusted parent UI: paths are labels; only scoped opaque tokens reach the Host. */
export function PanelDirectoryPicker({
  request,
  confirming,
  confirmationError,
}: {
  request: PanelDirectoryRequest;
  confirming: boolean;
  confirmationError: string;
}) {
  const [token, setToken] = React.useState(request.description.initialToken);
  const [retry, setRetry] = React.useState(0);
  const [current, setCurrent] = React.useState<DirectoryListing>();
  const [error, setError] = React.useState("");
  const [expired, setExpired] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const element = React.useRef<HTMLElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    element.current?.focus({ preventScroll: true });
    element.current?.scrollIntoView?.({ block: "nearest" });
  }, [request]);
  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setCurrent(undefined);
    setError("");
    setExpired(false);
    void request
      .list(token, controller.signal)
      .then((value) => {
        if (!active || controller.signal.aborted) return;
        setCurrent(listing(value, request, token));
        if (list.current) list.current.scrollTop = 0;
      })
      .catch((cause) => {
        if (!active || controller.signal.aborted) return;
        const ended = cause instanceof ApiError && [403, 409, 410].includes(cause.status);
        setExpired(ended);
        setError(
          ended
            ? "目录选择已失效，请取消后在面板中重新打开。原目录未更改。"
            : "暂时无法读取目录。请重试，或取消以保留原目录。",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [request, token, retry]);
  const ready = !loading && current?.directoryToken === token && !expired;
  return (
    <section
      className="panel-directory-picker"
      aria-label={request.title}
      ref={element}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !confirming) {
          event.preventDefault();
          request.finish(false);
        }
      }}
    >
      <header>
        <h2>{request.title}</h2>
        <button type="button" disabled={confirming} onClick={() => request.finish(false)}>
          取消
        </button>
      </header>
      <div className="panel-directory-scroll" ref={list}>
        <p className="panel-directory-help">
          选择当前项目中已存在的文件夹。选择其他项目，请先取消，再使用顶部项目选择器。
        </p>
        <p className="panel-directory-root">
          当前项目：<span>{request.description.rootPath}</span>
        </p>
        <nav aria-label="目录导航">
          <button
            type="button"
            disabled={confirming || loading || expired || token === request.description.rootToken}
            onClick={() => setToken(request.description.rootToken)}
          >
            项目根目录
          </button>
          <button
            type="button"
            disabled={confirming || !ready || !current?.parentToken}
            onClick={() => current?.parentToken && setToken(current.parentToken)}
          >
            返回上级
          </button>
        </nav>
        <p className="panel-directory-current" aria-live="polite">
          当前位置：
          {ready ? current.relativePath || "项目根目录" : error ? "读取失败" : "正在读取…"}
        </p>
        <div className="panel-directory-list" aria-busy={loading}>
          {loading && <p role="status">正在读取目录…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              {!expired && (
                <button type="button" onClick={() => setRetry((value) => value + 1)}>
                  重试读取
                </button>
              )}
            </div>
          )}
          {ready &&
            current.directories.map((child) => (
              <button
                type="button"
                key={child.token}
                disabled={confirming}
                onClick={() => setToken(child.token)}
              >
                <span aria-hidden="true">▱</span>
                <span>{child.name}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          {ready && !current.directories.length && <p>此目录下没有可浏览的子目录。</p>}
          {ready && current.truncated && (
            <p role="status">目录较多，仅显示前 200 个子目录。可在电脑端整理后重新打开。</p>
          )}
        </div>
        {confirmationError && <p role="alert">{confirmationError}</p>}
      </div>
      <footer>
        <p>浏览不会更改配置，点击“使用此目录”才会应用。</p>
        <button
          type="button"
          className="panel-host-primary"
          disabled={confirming || !ready}
          onClick={() => ready && request.finish(true, token)}
        >
          {confirming ? "正在确认…" : "使用此目录"}
        </button>
      </footer>
    </section>
  );
}
