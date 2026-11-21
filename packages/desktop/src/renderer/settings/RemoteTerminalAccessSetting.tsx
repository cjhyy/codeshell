import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useT } from "../i18n/I18nProvider";

/** Off by default: a paired phone gets a shell only after the owner opts in here. */
export function RemoteTerminalAccessSetting() {
  const { t } = useT();
  const api = window.codeshell.mobileRemote;
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.terminalAccess().then(
      (value) => alive && setEnabled(value),
      () => alive && setEnabled(false),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  const change = async (next: boolean) => {
    setBusy(true);
    try {
      setEnabled(await api.setTerminalAccess(next));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0">
        <h4 className="text-sm font-medium">{t("settingsX.adv.remoteTerminal")}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settingsX.adv.remoteTerminalDesc")}
        </p>
      </div>
      <Switch
        aria-label={t("settingsX.adv.remoteTerminal")}
        checked={enabled === true}
        disabled={enabled === undefined || busy}
        onCheckedChange={(next) => void change(next)}
      />
    </div>
  );
}
