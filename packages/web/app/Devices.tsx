import React from "react";
import { api, post, ApiError, type AuthSession, type DeviceSession } from "./auth.js";

export function Devices({
  session,
  onClose,
  onAuthLost,
}: {
  session?: AuthSession;
  onClose: () => void;
  onAuthLost: () => void;
}) {
  const [devices, setDevices] = React.useState<DeviceSession[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>("loading");
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const report = React.useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onAuthLost();
      else setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    },
    [onAuthLost],
  );

  React.useEffect(() => {
    let active = true;
    dialogRef.current?.showModal();
    void api<{ sessions: DeviceSession[] }>("/api/v1/auth/sessions")
      .then((result) => {
        if (active) setDevices(result.sessions);
      })
      .catch((cause) => {
        if (active) report(cause);
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [report]);

  const revoke = async (device: DeviceSession) => {
    setBusy(device.id);
    setError("");
    try {
      await api(`/api/v1/auth/sessions/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      if (device.current) onAuthLost();
      else setDevices((prev) => prev.filter((item) => item.id !== device.id));
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };
  const logout = async () => {
    setBusy("logout");
    setError("");
    try {
      await post("/api/v1/auth/logout");
      onAuthLost();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      className="devices-dialog"
      ref={dialogRef}
      onCancel={onClose}
      aria-labelledby="devices-title"
    >
      <div className="dialog-head">
        <h2 id="devices-title">账号与设备</h2>
        <button className="ghost" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <p className="muted">
        {session?.username} · {session?.deviceName || "当前设备"}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {busy === "loading" ? <p role="status">正在读取设备…</p> : null}
      <ul className="device-list">
        {devices.map((device) => (
          <li key={device.id}>
            <div>
              <strong>
                {device.deviceName || "未命名设备"}
                {device.current ? "（当前）" : ""}
              </strong>
              <span>最近活动 {new Date(device.lastSeenAt).toLocaleString()}</span>
            </div>
            <button className="ghost" disabled={busy !== null} onClick={() => void revoke(device)}>
              {busy === device.id ? "处理中…" : "撤销登录"}
            </button>
          </li>
        ))}
      </ul>
      <button className="stop" disabled={busy !== null} onClick={() => void logout()}>
        退出当前设备
      </button>
    </dialog>
  );
}
