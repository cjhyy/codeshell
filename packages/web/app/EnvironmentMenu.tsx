import React from "react";
import { api, ApiError } from "./auth.js";
import { isEnvironmentDescriptor, type EnvironmentDescriptor } from "../src/lib/environment.js";
import { readEnvironments, verifyCurrentEnvironment } from "./environments.js";
import "./environments.css";

type EnvironmentApiPath = "/api/v1/environment" | "/api/v1/cloud-browser/environment";

/** A website may share its origin with an independently authenticated legacy Hub. */
export const EnvironmentApiContext = React.createContext<EnvironmentApiPath>("/api/v1/environment");

/** The account directory owns destination selection; the workbench owns leave confirmation. */
export function EnvironmentMenu({
  discover = true,
  navigate,
}: {
  discover?: boolean;
  navigate?: (address: string) => void;
}) {
  const environmentApi = React.useContext(EnvironmentApiContext);
  const [open, setOpen] = React.useState(false);
  const [environment, setEnvironment] = React.useState<EnvironmentDescriptor>();
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [discovering, setDiscovering] = React.useState(discover);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const pending = React.useRef<EnvironmentApiPath | null>(null);

  React.useEffect(() => {
    if (!discover) {
      setEnvironment(undefined);
      setDiscovering(false);
      return;
    }
    const controller = new AbortController();
    setDiscovering(true);
    setEnvironment(undefined);
    void api<unknown>(environmentApi, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!isEnvironmentDescriptor(value)) throw new Error("环境信息无效，请更新工作台后重试。");
        verifyCurrentEnvironment(
          readEnvironments(window.localStorage),
          window.location.origin,
          value,
        );
        setEnvironment(value);
        setError("");
      })
      .catch((cause) => {
        if (
          controller.signal.aborted ||
          (cause instanceof ApiError && [401, 404].includes(cause.status))
        )
          return;
        setError(cause instanceof Error ? cause.message : "无法读取连接信息。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiscovering(false);
      });
    return () => controller.abort();
  }, [discover, environmentApi, retry]);

  React.useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    closeButton.current?.focus();
    return () => trigger.current?.focus();
  }, [open]);

  const dismiss = () => {
    pending.current = null;
    setOpen(false);
  };
  const leave = React.useCallback(
    (target: string) => {
      pending.current = null;
      setOpen(false);
      if (navigate) navigate(target);
      else window.location.assign(target);
    },
    [navigate],
  );
  const cloud = environmentApi === "/api/v1/cloud-browser/environment";
  const accountOrigin = environment?.accountComputers
    ? new URL(environment.accountComputers).origin
    : cloud
      ? window.location.origin
      : undefined;
  const computers = accountOrigin ? new URL("/app?target=choose", accountOrigin).href : undefined;

  React.useEffect(() => {
    if (pending.current !== environmentApi) {
      pending.current = null;
      return;
    }
    // A click during discovery or an explicit retry can continue once the
    // trusted entry arrives. Closing this fallback cancels that pending intent.
    if (open && computers) leave(computers);
  }, [computers, environmentApi, leave, open]);

  return (
    <div className="environment-switcher">
      <button
        ref={trigger}
        type="button"
        className="ghost environment-trigger"
        title="切换电脑或云端"
        onClick={() => {
          if (computers) leave(computers);
          else {
            pending.current = environmentApi;
            setOpen(true);
          }
        }}
      >
        {environment?.name ?? "电脑与云端"}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="environment-dialog"
          aria-labelledby="environment-title"
          onCancel={dismiss}
          onClose={dismiss}
        >
          <header>
            <h2 id="environment-title">电脑与云端</h2>
            <button ref={closeButton} type="button" className="ghost" onClick={dismiss}>
              关闭
            </button>
          </header>
          <p>
            {discovering
              ? "正在读取连接…"
              : environment?.kind === "desktop"
                ? "请在这台电脑的 CodeShell 中登录账号并开启远程访问，然后重试。"
                : discover
                  ? "暂时无法打开电脑列表，请检查连接后重试。"
                  : "请先完成当前电脑的连接验证。"}
          </p>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          {discover ? (
            <button
              type="button"
              className="library-button"
              disabled={discovering}
              onClick={() => {
                pending.current = environmentApi;
                setError("");
                setRetry((value) => value + 1);
              }}
            >
              重试连接
            </button>
          ) : null}
        </dialog>
      ) : null}
    </div>
  );
}
