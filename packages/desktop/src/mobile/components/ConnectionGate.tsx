import type { ConnStatus } from "@mobile/hooks/useRemoteSocket";

/** Full-screen state for everything before "online": connecting, authing,
 *  unpaired (needs QR), or offline (reconnecting). */
export function ConnectionGate({ status }: { status: ConnStatus }) {
  const copy: Record<
    Exclude<ConnStatus, "online">,
    { title: string; body: string; tone: string }
  > = {
    connecting: { title: "正在连接…", body: "与 CodeShell 建立通道", tone: "text-status-running" },
    authenticating: { title: "认证中…", body: "正在校验设备身份", tone: "text-status-running" },
    unpaired: {
      title: "未配对",
      body: "请在 CodeShell 桌面端打开「设置 → 远程」,扫码或打开配对链接。",
      tone: "text-status-warn",
    },
    offline: { title: "连接断开", body: "正在自动重连…", tone: "text-status-err" },
  };
  const c = copy[status as Exclude<ConnStatus, "online">] ?? copy.connecting;
  return (
    <div className="mobile-shell grid min-h-dvh place-items-center px-8 text-center">
      <div className="mobile-glass flex max-w-xs flex-col items-center gap-3 rounded-2xl px-6 py-7">
        <div className="mobile-logo grid size-14 place-items-center rounded-2xl text-lg font-black text-white">
          C
        </div>
        <h1 className={`text-base font-semibold ${c.tone}`}>{c.title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{c.body}</p>
      </div>
    </div>
  );
}
