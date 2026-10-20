import React from "react";
import { api, post, ApiError, type AuthSession, type DeviceSession } from "./auth.js";

interface FocusRequest {
  source: HTMLElement;
  cancelled: boolean;
}
function useDeviceActionFocus() {
  const current = React.useRef<FocusRequest | null>(null);
  React.useLayoutEffect(() => {
    const handoff = (event: Event) => {
      const target = event.type === "focusout" ? (event as FocusEvent).relatedTarget : event.target;
      if (!(target instanceof Node) || (target === document.body && event.type !== "pointerdown"))
        return;
      if (current.current && !current.current.source.contains(target))
        current.current.cancelled = true;
    };
    const blur = () => {
      if (current.current) current.current.cancelled = true;
    };
    document.addEventListener("pointerdown", handoff, true);
    document.addEventListener("focusin", handoff, true);
    document.addEventListener("focusout", handoff, true);
    window.addEventListener("blur", blur);
    return () => {
      current.current = null;
      document.removeEventListener("pointerdown", handoff, true);
      document.removeEventListener("focusin", handoff, true);
      document.removeEventListener("focusout", handoff, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const capture = React.useCallback((source: Element | null = document.activeElement) => {
    if (current.current) current.current.cancelled = true;
    const request =
      source instanceof HTMLElement && source !== document.body
        ? { source, cancelled: false }
        : null;
    current.current = request;
    return request;
  }, []);
  const finish = React.useCallback((request: FocusRequest | null, target: HTMLElement | null) => {
    if (!request || current.current !== request) return;
    current.current = null;
    const active = document.activeElement;
    if (
      request.cancelled ||
      (active && active !== document.body && !request.source.contains(active) && active.isConnected)
    )
      return;
    if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
  }, []);
  const cancel = React.useCallback(() => {
    current.current = null;
  }, []);
  return { capture, finish, cancel };
}

export function Devices({
  session,
  onClose,
  onAuthLost,
  opener,
  fallbackOpener,
}: {
  session?: AuthSession;
  onClose: () => void;
  onAuthLost: () => void;
  opener?: HTMLElement | null;
  fallbackOpener?: HTMLElement | null;
}) {
  const [devices, setDevices] = React.useState<DeviceSession[]>([]);
  const [error, setError] = React.useState("");
  const [readFailed, setReadFailed] = React.useState(false);
  const [readVersion, setReadVersion] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>("loading");
  const [intent, setIntent] = React.useState<{
    request: FocusRequest | null;
    kind: "error" | "neighbor" | "list";
    index: number;
  } | null>(null);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const errorRef = React.useRef<HTMLParagraphElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const logoutRef = React.useRef<HTMLButtonElement>(null);
  const busyRef = React.useRef<string | null>("loading");
  const alive = React.useRef(false);
  const readFocus = React.useRef<FocusRequest | null>(null);
  const focus = useDeviceActionFocus();
  const report = React.useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthLost();
        return false;
      }
      if (alive.current) setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      return true;
    },
    [onAuthLost],
  );

  React.useLayoutEffect(() => {
    alive.current = true;
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    readFocus.current = focus.capture();
    return () => {
      alive.current = false;
    };
  }, [focus.capture]);
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const request = readFocus.current;
    busyRef.current = "loading";
    setBusy("loading");
    setError("");
    setReadFailed(false);
    void api<{ sessions: DeviceSession[] }>("/api/v1/auth/sessions", { signal: controller.signal })
      .then((result) => {
        if (active) {
          setDevices(result.sessions);
          if (readVersion > 0) setIntent({ request, kind: "list", index: 0 });
        }
      })
      .catch((cause) => {
        if (active) {
          setReadFailed(true);
          if (report(cause)) setIntent({ request, kind: "error", index: 0 });
        }
      })
      .finally(() => {
        if (active) {
          busyRef.current = null;
          setBusy(null);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [report, readVersion]);

  const keepFocusedVisible = React.useCallback(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (
      !alive.current ||
      !dialog?.open ||
      !(active instanceof HTMLElement) ||
      !dialog.contains(active)
    )
      return;
    const scroller = active.closest<HTMLElement>("[data-devices-scroll]");
    if (!scroller || active === scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < bounds.top + 4) scroller.scrollTop -= Math.ceil(bounds.top + 4 - item.top);
    else if (item.bottom > bounds.bottom - 4)
      scroller.scrollTop += Math.ceil(item.bottom - bounds.bottom + 4);
  }, []);
  React.useLayoutEffect(() => {
    if (!intent || busy !== null) return;
    setIntent(null);
    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>(".device-list button");
    const target =
      intent.kind === "error"
        ? errorRef.current
        : intent.kind === "list"
          ? listRef.current
          : (buttons?.[Math.min(intent.index, buttons.length - 1)] ?? logoutRef.current);
    focus.finish(intent.request, target);
    keepFocusedVisible();
  }, [intent, busy, devices, focus, keepFocusedVisible]);
  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const observer = new ResizeObserver(keepFocusedVisible);
    observer.observe(dialog);
    dialog.querySelectorAll("[data-devices-scroll]").forEach((node) => observer.observe(node));
    dialog.addEventListener("focusin", keepFocusedVisible);
    window.addEventListener("resize", keepFocusedVisible);
    return () => {
      observer.disconnect();
      dialog.removeEventListener("focusin", keepFocusedVisible);
      window.removeEventListener("resize", keepFocusedVisible);
    };
  }, [error, keepFocusedVisible]);

  const revoke = async (device: DeviceSession, source: HTMLElement) => {
    if (busyRef.current !== null) return;
    const request = focus.capture(source);
    const index = devices.findIndex((item) => item.id === device.id);
    busyRef.current = device.id;
    setBusy(device.id);
    setError("");
    try {
      await api(`/api/v1/auth/sessions/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      if (device.current) onAuthLost();
      else if (alive.current) {
        setDevices((prev) => prev.filter((item) => item.id !== device.id));
        setIntent({ request, kind: "neighbor", index });
      }
    } catch (cause) {
      if (report(cause) && alive.current) setIntent({ request, kind: "error", index });
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  };
  const logout = async (source: HTMLElement) => {
    if (busyRef.current !== null) return;
    const request = focus.capture(source);
    busyRef.current = "logout";
    setBusy("logout");
    setError("");
    try {
      await post("/api/v1/auth/logout");
      onAuthLost();
    } catch (cause) {
      if (report(cause) && alive.current) setIntent({ request, kind: "error", index: 0 });
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  };
  const close = () => {
    focus.cancel();
    dialogRef.current?.close();
    const visible = (node: HTMLElement | null | undefined) =>
      node?.isConnected &&
      !node.closest("[inert]") &&
      node.getClientRects().length &&
      !node.matches(":disabled");
    if (visible(opener)) opener?.focus({ preventScroll: true });
    else if (visible(fallbackOpener)) fallbackOpener?.focus({ preventScroll: true });
    onClose();
  };
  return (
    <dialog
      className="devices-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-labelledby="devices-title"
    >
      <div className="dialog-head">
        <h2 id="devices-title">账号与设备</h2>
        <button className="ghost" onClick={close} aria-label="关闭">
          ×
        </button>
      </div>
      {error ? (
        <p
          className="form-error devices-error"
          role="alert"
          tabIndex={0}
          ref={errorRef}
          data-devices-scroll
        >
          {error}
        </p>
      ) : null}
      <div
        className="devices-body"
        ref={listRef}
        role="region"
        aria-label="登录设备"
        tabIndex={0}
        data-devices-scroll
      >
        <p className="muted devices-summary">
          {session?.username} · {session?.deviceName || "当前设备"}
        </p>
        {busy === "loading" ? <p role="status">正在读取设备…</p> : null}
        {!busy && !readFailed && devices.length === 0 ? (
          <p className="muted">暂无可显示的登录设备。</p>
        ) : null}
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
              <button
                className="ghost"
                aria-disabled={busy !== null}
                aria-busy={busy === device.id}
                onClick={(event) => void revoke(device, event.currentTarget)}
              >
                {busy === device.id ? "处理中…" : "撤销登录"}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="devices-footer">
        {readFailed ? (
          <button
            className="ghost"
            aria-disabled={busy !== null}
            aria-busy={busy === "loading"}
            onClick={(event) => {
              if (busyRef.current !== null) return;
              readFocus.current = focus.capture(event.currentTarget);
              busyRef.current = "loading";
              setReadVersion((value) => value + 1);
            }}
          >
            重新读取
          </button>
        ) : null}
        <button
          className="stop"
          ref={logoutRef}
          aria-disabled={busy !== null}
          aria-busy={busy === "logout"}
          onClick={(event) => void logout(event.currentTarget)}
        >
          退出当前设备
        </button>
      </div>
    </dialog>
  );
}
