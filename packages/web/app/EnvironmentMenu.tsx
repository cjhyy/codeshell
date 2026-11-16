import React from "react";
import { api, ApiError } from "./auth.js";
import { isEnvironmentDescriptor, type EnvironmentDescriptor } from "../src/lib/environment.js";
import {
  environmentAddress,
  readEnvironments,
  removeEnvironment,
  verifyCurrentEnvironment,
  type SavedEnvironment,
} from "./environments.js";
import "./environments.css";

type EnvironmentApiPath = "/api/v1/environment" | "/api/v1/cloud-browser/environment";

/** A website may share its origin with an independently authenticated legacy Hub. */
export const EnvironmentApiContext = React.createContext<EnvironmentApiPath>("/api/v1/environment");

/** Each destination authenticates independently; switching never changes a running job's host. */
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
  const [saved, setSaved] = React.useState<SavedEnvironment[]>([]);
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [discovering, setDiscovering] = React.useState(discover);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    try {
      setSaved(readEnvironments(window.localStorage));
    } catch {
      setError("无法读取连接记录。当前项目仍可使用。");
    }
  }, []);

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
        setEnvironment(value);
        setError("");
        verifyCurrentEnvironment(
          readEnvironments(window.localStorage),
          window.location.origin,
          value,
        );
      })
      .catch((cause) => {
        if (
          controller.signal.aborted ||
          (cause instanceof ApiError && [401, 404].includes(cause.status))
        )
          return;
        setError(cause instanceof Error ? cause.message : "无法读取环境信息。");
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
    // Restore explicitly because closing unmounts the native dialog.
    return () => trigger.current?.focus();
  }, [open]);

  const edit = (operation: () => SavedEnvironment[]) => {
    try {
      setSaved(operation());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存连接失败。");
    }
  };
  const leave = (target: string) => {
    setOpen(false);
    if (navigate) navigate(target);
    else window.location.assign(target);
  };
  const go = (value: string) => leave(environmentAddress(value));
  const cloud = environmentApi === "/api/v1/cloud-browser/environment";
  const accountOrigin = environment?.accountComputers
    ? new URL(environment.accountComputers).origin
    : cloud
      ? window.location.origin
      : undefined;
  const computers = accountOrigin ? new URL("/app?target=choose", accountOrigin).href : undefined;

  return (
    <div className="environment-switcher">
      <button
        ref={trigger}
        type="button"
        className="ghost environment-trigger"
        onClick={() => setOpen(true)}
      >
        {environment?.name ?? "电脑与云端"}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="environment-dialog"
          aria-labelledby="environment-title"
          onCancel={() => setOpen(false)}
          onClose={() => setOpen(false)}
        >
          <header>
            <h2 id="environment-title">电脑与云端</h2>
            <button
              ref={closeButton}
              type="button"
              className="ghost"
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          </header>
          <p>选择电脑或云端，继续原来的聊天，也可以直接开始新聊天。</p>
          {cloud || environment ? (
            <p className="environment-hint">
              {cloud
                ? "当前在云端，聊天保存在云端。"
                : environment?.kind === "desktop"
                  ? "当前正在使用这台电脑的聊天和文件。"
                  : "当前正在使用此工作台的聊天和文件。"}
              已开始的任务会在原来的电脑或云端继续运行。
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          {computers ? (
            <section className="environment-account" aria-labelledby="environment-account-title">
              <strong id="environment-account-title">我的电脑与云端</strong>
              <p>进入账号列表，选择要使用的电脑或云端。</p>
              <button
                type="button"
                className="library-button primary"
                onClick={() => leave(computers)}
              >
                选择电脑或云端
              </button>
            </section>
          ) : (
            <section className="environment-account" aria-labelledby="environment-account-title">
              <strong id="environment-account-title">我的电脑与云端</strong>
              <p>
                {discovering
                  ? "正在读取电脑与云端入口…"
                  : environment?.kind === "desktop"
                    ? "请在这台电脑的 CodeShell 中登录账号并开启远程访问，随后可从账号列表打开这台电脑。"
                    : discover
                      ? "账号列表暂时不可用，请检查当前连接或在 CodeShell 中确认账号登录状态。"
                      : "请先完成当前电脑的连接验证，再打开账号列表。"}
              </p>
              {discover ? (
                <button
                  type="button"
                  className="library-button"
                  disabled={discovering}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  重新读取
                </button>
              ) : null}
            </section>
          )}
          {saved.length ? (
            <ul className="environment-list" aria-label="已保存的连接">
              {saved.map((item) => (
                <li key={item.address}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>已保存的连接</small>
                  </div>
                  <button type="button" className="library-button" onClick={() => go(item.address)}>
                    打开
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`移除 ${item.name}`}
                    onClick={() => edit(() => removeEnvironment(window.localStorage, item.address))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </dialog>
      ) : null}
    </div>
  );
}
