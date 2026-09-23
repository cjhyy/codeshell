import React from "react";
import { api, ApiError } from "./auth.js";
import { isEnvironmentDescriptor, type EnvironmentDescriptor } from "../src/lib/environment.js";
import {
  environmentAddress,
  readEnvironments,
  removeEnvironment,
  saveEnvironment,
  verifyCurrentEnvironment,
  type SavedEnvironment,
} from "./environments.js";
import "./environments.css";

/** Each destination authenticates independently; switching never changes a running job's host. */
export function EnvironmentMenu({
  discover = true,
  navigate,
}: {
  discover?: boolean;
  navigate?: (address: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [environment, setEnvironment] = React.useState<EnvironmentDescriptor>();
  const [saved, setSaved] = React.useState<SavedEnvironment[]>([]);
  const [name, setName] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [error, setError] = React.useState("");
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
    if (!discover) return;
    const controller = new AbortController();
    void api<unknown>("/api/v1/environment", { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!isEnvironmentDescriptor(value)) throw new Error("环境信息无效，请更新工作台后重试。");
        setEnvironment(value);
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
      });
    return () => controller.abort();
  }, [discover]);

  React.useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    closeButton.current?.focus();
  }, [open]);

  const edit = (operation: () => SavedEnvironment[]) => {
    try {
      setSaved(operation());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存连接失败。");
    }
  };
  const go = (value: string) => {
    const target = environmentAddress(value);
    setOpen(false);
    if (navigate) navigate(target);
    else window.location.assign(target);
  };

  return (
    <div className="environment-switcher">
      <button type="button" className="ghost environment-trigger" onClick={() => setOpen(true)}>
        {environment?.name ?? "连接环境"}
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
          <p>打开目标环境后选择项目。切换入口不会移动文件或正在运行的任务。</p>
          <p className="environment-location">当前地址：{window.location.origin}</p>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          {environment ? (
            <button
              type="button"
              className="library-button"
              onClick={() =>
                edit(() =>
                  saveEnvironment(window.localStorage, {
                    name: environment.name,
                    address: window.location.origin + environment.entryPath,
                    environmentId: environment.id,
                  }),
                )
              }
            >
              保存当前环境
            </button>
          ) : null}
          <ul className="environment-list">
            {saved.map((item) => (
              <li key={item.address}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.address}</small>
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              edit(() => saveEnvironment(window.localStorage, { name, address: address.trim() }));
            }}
          >
            <label>
              连接名称
              <input
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：家里的电脑"
              />
            </label>
            <label>
              工作台地址
              <input
                required
                type="url"
                maxLength={2048}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="https://example.com/"
              />
            </label>
            <button type="submit" className="library-button primary">
              添加连接
            </button>
          </form>
          <p className="environment-hint">
            连接记录保存在当前工作台的浏览器存储中。目标环境需要单独登录或配对，请勿保存带配对令牌的地址。未连接的环境不会显示为在线。
          </p>
        </dialog>
      ) : null}
    </div>
  );
}
