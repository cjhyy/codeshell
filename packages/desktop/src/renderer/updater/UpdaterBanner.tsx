import React, { useEffect, useState } from "react";
import type { UpdaterStatus } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { useT, type TFunction } from "../i18n/I18nProvider";

export function UpdaterBanner() {
  const { t } = useT();
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void window.codeshell.getUpdaterStatus().then(setStatus);
    return window.codeshell.onUpdaterStatus((s) => {
      setStatus(s as UpdaterStatus);
      setDismissed(false);
    });
  }, []);

  if (dismissed) return null;

  if (status.kind === "downloaded") {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
        <span className="flex-1">{t("misc.updater.downloaded", { version: status.version })}</span>
        <Button size="sm" onClick={() => void window.codeshell.installUpdate()}>{t("misc.updater.restartInstall")}</Button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label={t("misc.updater.close")}
        >
          ×
        </button>
      </div>
    );
  }

  if (status.kind === "manual-required") {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
        <span className="flex-1">{t("misc.updater.manualRequired", { version: status.version })}</span>
        <Button size="sm" onClick={() => void window.codeshell.openExternal(status.url)}>{t("misc.updater.openRelease")}</Button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label={t("misc.updater.close")}
        >
          ×
        </button>
      </div>
    );
  }

  if (status.kind === "downloading") {
    return (
      <div className="border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
        {t("misc.updater.downloading", { percent: status.percent })}
      </div>
    );
  }

  if (status.kind === "available") {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
        <span className="flex-1">{t("misc.updater.available", { version: status.version })}</span>
        <Button size="sm" onClick={() => void window.codeshell.downloadUpdate()}>{t("misc.updater.download")}</Button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label={t("misc.updater.close")}
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}

/** Inline status row for the Settings view. */
export function UpdaterSettingsRow() {
  const { t } = useT();
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  useEffect(() => {
    void window.codeshell.getUpdaterStatus().then(setStatus);
    return window.codeshell.onUpdaterStatus((s) => setStatus(s as UpdaterStatus));
  }, []);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("misc.updater.autoUpdate")}</h3>
      <div className="text-sm">
        <span className="text-muted-foreground">{t("misc.updater.statusLabel")}</span>
        <span>{describeStatus(status, t)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void window.codeshell.checkForUpdate()}>
          {t("misc.updater.checkUpdate")}
        </Button>
        {status.kind === "available" && (
          <Button size="sm" onClick={() => void window.codeshell.downloadUpdate()}>{t("misc.updater.download")}</Button>
        )}
        {status.kind === "downloaded" && (
          <Button size="sm" onClick={() => void window.codeshell.installUpdate()}>{t("misc.updater.restartInstall")}</Button>
        )}
        {status.kind === "manual-required" && (
          <Button size="sm" onClick={() => void window.codeshell.openExternal(status.url)}>{t("misc.updater.openRelease")}</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("misc.updater.feedHint")}
      </p>
    </section>
  );
}

function describeStatus(s: UpdaterStatus, t: TFunction): string {
  switch (s.kind) {
    case "idle": return t("misc.updater.statusIdle");
    case "checking": return t("misc.updater.statusChecking");
    case "available": return t("misc.updater.statusAvailable", { version: s.version });
    case "manual-required": return t("misc.updater.statusManualRequired", { version: s.version });
    case "not-available": return t("misc.updater.statusNotAvailable", { version: s.version });
    case "downloading": return t("misc.updater.statusDownloading", { percent: s.percent });
    case "downloaded": return t("misc.updater.statusDownloaded", { version: s.version });
    case "error": return t("misc.updater.statusError", { message: s.message });
  }
}
