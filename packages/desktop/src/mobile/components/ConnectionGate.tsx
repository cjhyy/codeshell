import { useT } from "@/i18n";
import type { ConnStatus } from "@cjhyy/code-shell-web";

/** Full-screen state for everything before "online": connecting, authing,
 *  unpaired (needs QR), or offline (reconnecting). */
export function ConnectionGate({ status }: { status: ConnStatus }) {
  const { t } = useT();
  const copy: Record<
    Exclude<ConnStatus, "online">,
    { title: string; body: string; tone: string }
  > = {
    connecting: {
      title: t("mobile.connection.connectingTitle"),
      body: t("mobile.connection.connectingBody"),
      tone: "text-status-running",
    },
    authenticating: {
      title: t("mobile.connection.authenticatingTitle"),
      body: t("mobile.connection.authenticatingBody"),
      tone: "text-status-running",
    },
    unpaired: {
      title: t("mobile.connection.unpairedTitle"),
      body: t("mobile.connection.unpairedBody"),
      tone: "text-status-warn",
    },
    offline: {
      title: t("mobile.connection.offlineTitle"),
      body: t("mobile.connection.offlineBody"),
      tone: "text-status-err",
    },
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
