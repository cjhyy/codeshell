import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { accountPublicOrigin } from "@cjhyy/code-shell-web";
import type { AccountExecutionDevice } from "../../shared/account-device.js";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import type { DesktopRelayStatus } from "../../shared/device-relay.js";
import { openAccountSettings, useAccountFeature } from "../account/useAccountFeature";
import { cn } from "@/lib/utils";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const identityOf = (account: CloudAccountStatus) =>
  account.state === "signed-in" ? JSON.stringify([account.origin, account.account?.id]) : "";

/** Select a computer and continue its existing chats. This page never creates a Session. */
export function AccountDeviceWorkspace({
  open,
  onClose,
  onOpenLocal,
}: {
  open: boolean;
  onClose(): void;
  onOpenLocal(isCurrent: () => boolean): void | Promise<void>;
}) {
  const directory = useAccountFeature("devices.directory");
  const [account, setAccount] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [checkingAccount, setCheckingAccount] = useState(true);
  const [local, setLocal] = useState<DesktopRelayStatus>();
  const [listed, setListed] = useState<{ identity: string; devices: AccountExecutionDevice[] }>({
    identity: "",
    devices: [],
  });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [opened, setOpened] = useState("");
  const [refresh, setRefresh] = useState(0);
  const revision = useRef(0);
  const pending = useRef<string | null>(null);
  const surface = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const identity = identityOf(account);

  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const container = surface.current;
    returnButton.current?.focus({ preventScroll: true });
    return () => {
      const focused = document.activeElement;
      if (focused !== document.body && !container?.contains(focused)) return;
      if (opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length)
        opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let changed = false;
    let relayChanged = false;
    setCheckingAccount(true);
    const apply = (next: CloudAccountStatus) => {
      if (!active) return;
      setAccount(next);
      setCheckingAccount(false);
    };
    const offAccount = window.codeshell.cloudAccount.onStatus((next) => {
      changed = true;
      apply(next);
    });
    void window.codeshell.cloudAccount.status().then(
      (next) => {
        if (!changed) apply(next);
      },
      () => {
        if (!changed) apply({ state: "signed-out" });
      },
    );
    const relay = window.codeshell.mobileRemote?.relay;
    const offRelay = relay?.onStatus((next) => {
      relayChanged = true;
      if (active) setLocal(next);
    });
    void relay?.status().then(
      (next) => {
        if (active && !relayChanged) setLocal(next);
      },
      () => {},
    );
    return () => {
      active = false;
      offAccount();
      offRelay?.();
    };
  }, [open]);

  useEffect(() => {
    revision.current++;
    pending.current = null;
    setOpening(null);
    setOpened("");
    setActionError("");
    return () => {
      revision.current++;
      pending.current = null;
    };
  }, [open, identity]);

  useEffect(() => {
    let active = true;
    let fetching = false;
    setListError("");
    if (!open || checkingAccount || !identity || directory.state !== "ready") {
      setLoading(false);
      return;
    }
    const load = async () => {
      if (fetching) return;
      fetching = true;
      setLoading(true);
      try {
        const devices = await window.codeshell.accountDevices.list();
        if (active) {
          setListed({ identity, devices });
          setListError("");
        }
      } catch {
        if (active) setListError("暂时无法读取其他电脑，请刷新重试。本机聊天仍可使用。");
      } finally {
        fetching = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [open, checkingAccount, identity, directory.state, refresh]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  const localMatchesAccount =
    !!identity && local?.accountId === account.account?.id && local?.relayOrigin === account.origin;
  const localHostId = localMatchesAccount ? local?.hostId : undefined;
  const devices =
    !checkingAccount && directory.state === "ready" && listed.identity === identity
      ? listed.devices.filter((device) => !device.revoked && device.hostId !== localHostId)
      : [];

  const enter = async (device?: AccountExecutionDevice) => {
    if (device ? pending.current !== null : pending.current === "local") return;
    if (device && (!identity || directory.state !== "ready" || !device.online || device.revoked))
      return;
    const target = device?.hostId ?? "local";
    const epoch = ++revision.current;
    pending.current = target;
    setOpening(target);
    setActionError("");
    setOpened("");
    try {
      if (!device) await onOpenLocal(() => revision.current === epoch);
      else {
        const origin = accountPublicOrigin(account.origin);
        if (!origin?.startsWith("https://") || !UUID.test(device.hostId))
          throw new Error("电脑连接地址无效，请刷新电脑列表后重试。");
        const url = new URL("/app", origin);
        url.searchParams.set("target", "choose");
        url.searchParams.set("computer", device.hostId);
        await window.codeshell.openExternal(url.href);
        if (revision.current === epoch)
          setOpened(`已在浏览器打开 ${device.name}。完成指纹或 Passkey 验证后即可继续原来的聊天。`);
      }
    } catch (cause) {
      if (revision.current === epoch)
        setActionError(cause instanceof Error ? cause.message : "无法打开聊天，请重试。");
    } finally {
      if (revision.current === epoch) {
        pending.current = null;
        setOpening(null);
      }
    }
  };

  if (!open) return null;
  return (
    <section
      ref={surface}
      role="dialog"
      aria-modal="true"
      aria-label="我的电脑"
      className="absolute inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground"
    >
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4",
          window.codeshell?.platform === "darwin" && "pl-[88px]",
        )}
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <h1 className="text-lg font-semibold">我的电脑</h1>
        <button
          ref={returnButton}
          type="button"
          onClick={onClose}
          className="min-h-11 shrink-0 rounded-md border border-border px-3 py-2 text-sm"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          返回工作台
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <p className="text-sm text-muted-foreground">
            选择电脑，继续使用它原来的聊天和项目。也可以直接开始新对话，不必先选项目。
          </p>
          <button
            type="button"
            aria-label="打开本机聊天"
            disabled={opening === "local"}
            onClick={() => void enter()}
            className="flex min-h-24 w-full items-center justify-between gap-4 rounded-xl border border-border p-5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
          >
            <span className="min-w-0">
              <span className="block font-medium">这台电脑</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                继续本机已有聊天，无需远程连接
              </span>
            </span>
            <span className="shrink-0 text-sm">
              {opening === "local" ? "正在打开…" : "打开聊天"}
            </span>
          </button>
          <section aria-labelledby="other-computers-heading" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="other-computers-heading" className="font-medium">
                其他电脑
              </h2>
              {!!identity && directory.state === "ready" && (
                <button
                  type="button"
                  aria-label="刷新电脑列表"
                  disabled={loading}
                  onClick={() => setRefresh((value) => value + 1)}
                  className="min-h-11 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
                >
                  {loading ? "正在刷新…" : "刷新"}
                </button>
              )}
            </div>
            {checkingAccount ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取账号…
              </p>
            ) : !identity ? (
              <div className="rounded-xl border border-border p-5">
                <p className="text-sm text-muted-foreground">
                  登录后可连接账号里的其他电脑。本机聊天不需要登录。
                </p>
                <button
                  type="button"
                  onClick={openAccountSettings}
                  className="mt-3 min-h-11 rounded-md border border-border px-3 py-2 text-sm"
                >
                  登录账号
                </button>
              </div>
            ) : directory.state !== "ready" ? (
              <div className="rounded-xl border border-border p-5">
                <p className="text-sm text-muted-foreground">
                  电脑列表暂不可用，本机聊天仍可使用。
                </p>
                <button
                  type="button"
                  onClick={openAccountSettings}
                  className="mt-3 min-h-11 rounded-md border border-border px-3 py-2 text-sm"
                >
                  查看账号设置
                </button>
              </div>
            ) : (
              <>
                {loading && !devices.length && (
                  <p role="status" className="text-sm text-muted-foreground">
                    正在读取其他电脑…
                  </p>
                )}
                {!loading && !devices.length && !listError && (
                  <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                    账号里还没有其他电脑。只有这一台也可以正常使用；手机或网页可通过账号连接本机。
                  </p>
                )}
                {devices.map((device) => (
                  <button
                    key={device.hostId}
                    type="button"
                    aria-label={`连接 ${device.name}`}
                    disabled={!device.online || opening !== null}
                    onClick={() => void enter(device)}
                    className="flex min-h-24 w-full items-center justify-between gap-4 rounded-xl border border-border p-5 text-left hover:enabled:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block break-words font-medium">{device.name}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {device.online
                          ? "在线 · 在浏览器中验证后进入原来的聊天"
                          : "暂不可连接 · 电脑离线或未开启远程访问"}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm">
                      {opening === device.hostId
                        ? "正在打开…"
                        : device.online
                          ? "打开聊天"
                          : "离线"}
                    </span>
                  </button>
                ))}
                {devices.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    连接其他电脑时，在当前设备完成指纹或 Passkey 验证即可，无需目标电脑逐次确认。
                  </p>
                )}
              </>
            )}
            {listError && (
              <p role="alert" className="text-sm text-destructive">
                {listError}
              </p>
            )}
          </section>
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          {opened && (
            <p role="status" className="text-sm text-muted-foreground">
              {opened}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
