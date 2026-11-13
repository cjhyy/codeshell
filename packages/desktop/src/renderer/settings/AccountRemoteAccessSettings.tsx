import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DesktopRelayStatus } from "../../shared/device-relay.js";
import { useAccountFeature } from "../account/useAccountFeature";
import { useT } from "../i18n/I18nProvider";

/** Account binding is automatic. This switch grants only incoming remote access. */
export function AccountRemoteAccessSettings({
  identity,
  pending = false,
}: {
  identity: { origin: string; accountId: string };
  pending?: boolean;
}) {
  const { t } = useT();
  const feature = useAccountFeature("devices.directory");
  const relay = window.codeshell.mobileRemote?.relay;
  const [status, setStatus] = useState<DesktopRelayStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const working = useRef(false);
  const statusRevision = useRef(0);
  useEffect(() => {
    active.current = true;
    let changed = false;
    const off = relay?.onStatus?.((next) => {
      changed = true;
      statusRevision.current++;
      if (active.current) setStatus(next);
    });
    void relay?.status?.().then(
      (next) => {
        if (active.current && !changed) setStatus(next);
      },
      (cause) => {
        if (active.current) setError(String(cause));
      },
    );
    return () => {
      active.current = false;
      off?.();
    };
  }, [relay]);
  const bound =
    status?.registered &&
    status.accountId === identity.accountId &&
    status.relayOrigin === identity.origin;
  const enabled = bound && status.remoteAccessEnabled === true;
  const perform = async (operation: () => Promise<unknown>) => {
    if (working.current || pending) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : t("settingsX.cloudAccount.failed"));
    } finally {
      try {
        const revision = statusRevision.current;
        const next = await relay?.status?.();
        if (active.current && revision === statusRevision.current && next) setStatus(next);
      } catch {
        // Keep the last observed status and the operation error until the next update.
      }
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  if (!relay || feature.state === "hidden") return null;
  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4 text-sm"
      aria-label={t("settingsX.cloudAccount.remoteAccess")}
    >
      <h4 className="font-medium">{t("settingsX.cloudAccount.remoteAccess")}</h4>
      <p className="leading-6 text-muted-foreground">
        {t("settingsX.cloudAccount.remoteAccessHint")}
      </p>
      <label className="flex items-center justify-between gap-4">
        <span>{t("settingsX.cloudAccount.remoteAccessToggle")}</span>
        <Switch
          aria-label={t("settingsX.cloudAccount.remoteAccessToggle")}
          checked={!!enabled}
          disabled={pending || busy || !bound}
          onCheckedChange={(next) =>
            void perform(() =>
              next
                ? window.codeshell.mobileRemote.start({ mode: "relay" })
                : window.codeshell.mobileRemote.stop(),
            )
          }
        />
      </label>
      <p role="status" className="text-xs text-muted-foreground">
        {status?.message ||
          t(
            !bound
              ? "settingsX.cloudAccount.remoteAccessSyncing"
              : !enabled
                ? "settingsX.cloudAccount.remoteAccessOff"
                : status.state === "ready"
                  ? "settingsX.cloudAccount.remoteAccessOn"
                  : "settingsX.adv.relayState_connecting",
          )}
      </p>
      {(!bound || (enabled && !["ready", "connecting"].includes(status.state))) && (
        <Button
          variant="outline"
          disabled={pending || busy}
          onClick={() => void perform(() => window.codeshell.cloudAccount.resume!())}
        >
          {t("settingsX.cloudAccount.remoteAccessRetry")}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
