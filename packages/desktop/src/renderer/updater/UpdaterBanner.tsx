import React, { useEffect, useState } from "react";
import type { UpdaterStatus } from "../../preload/types";
import { AlertCircle, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT, type TFunction } from "../i18n/I18nProvider";

const SIDEBAR_UPDATE_ACTION_CLASS =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";
const SIDEBAR_UPDATE_PROGRESS_CLASS =
  "inline-flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-muted-foreground";

function useUpdaterStatus(): UpdaterStatus {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  useEffect(() => {
    let mounted = true;
    void window.codeshell.getUpdaterStatus().then((s) => {
      if (mounted) setStatus(s);
    });
    const unsubscribe = window.codeshell.onUpdaterStatus((s) => {
      setStatus(s as UpdaterStatus);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return status;
}

export function SidebarUpdaterButton() {
  const { t } = useT();
  const status = useUpdaterStatus();
  const [downloadPending, setDownloadPending] = useState(false);
  const [installPending, setInstallPending] = useState(false);

  useEffect(() => {
    if (status.kind !== "available") setDownloadPending(false);
  }, [status.kind]);

  useEffect(() => {
    if (status.kind !== "downloaded") setInstallPending(false);
  }, [status.kind]);

  const visibleStatus: UpdaterStatus =
    downloadPending && status.kind === "available"
      ? { kind: "downloading", percent: 0, transferred: 0, total: 0 }
      : installPending && status.kind === "downloaded"
        ? { kind: "installing", version: status.version }
        : status;

  if (visibleStatus.kind === "available") {
    const title = t("misc.updater.available", { version: visibleStatus.version });
    return (
      <button
        type="button"
        className={SIDEBAR_UPDATE_ACTION_CLASS}
        onClick={() => {
          setDownloadPending(true);
          void window.codeshell.downloadUpdate().catch(() => setDownloadPending(false));
        }}
        aria-label={title}
        title={title}
      >
        <Download size={13} className="shrink-0" />
        <span>{t("misc.updater.download")}</span>
      </button>
    );
  }

  if (visibleStatus.kind === "manual-required") {
    const title = describeManualRequired(visibleStatus, t);
    return (
      <button
        type="button"
        className={SIDEBAR_UPDATE_ACTION_CLASS}
        onClick={() => void window.codeshell.openExternal(visibleStatus.url)}
        aria-label={title}
        title={title}
      >
        <ExternalLink size={13} className="shrink-0" />
        <span>{t("misc.updater.openReleaseCompact")}</span>
      </button>
    );
  }

  if (visibleStatus.kind === "downloading") {
    const title = t("misc.updater.downloading", { percent: visibleStatus.percent });
    return (
      <div
        className={SIDEBAR_UPDATE_PROGRESS_CLASS}
        aria-label={title}
        role="status"
        title={title}
      >
        <Loader2 size={13} className="shrink-0 animate-spin" />
        <span>{t("misc.updater.downloadingCompact", { percent: visibleStatus.percent })}</span>
      </div>
    );
  }

  if (visibleStatus.kind === "downloaded") {
    const title = t("misc.updater.downloaded", { version: visibleStatus.version });
    return (
      <button
        type="button"
        className={SIDEBAR_UPDATE_ACTION_CLASS}
        onClick={() => {
          setInstallPending(true);
          void window.codeshell.installUpdate().catch(() => setInstallPending(false));
        }}
        aria-label={title}
        title={title}
      >
        <RefreshCw size={13} className="shrink-0" />
        <span>{t("misc.updater.installCompact")}</span>
      </button>
    );
  }

  if (visibleStatus.kind === "installing") {
    const title = t("misc.updater.installing", { version: visibleStatus.version });
    return (
      <div
        className={SIDEBAR_UPDATE_PROGRESS_CLASS}
        aria-label={title}
        role="status"
        title={title}
      >
        <Loader2 size={13} className="shrink-0 animate-spin" />
        <span>{t("misc.updater.installingCompact")}</span>
      </div>
    );
  }

  if (visibleStatus.kind === "error") {
    const title = t("misc.updater.statusError", { message: visibleStatus.message });
    return (
      <div
        className="inline-flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-status-err/30 bg-status-err/10 px-2 text-xs font-medium text-status-err"
        aria-label={title}
        role="status"
        title={title}
      >
        <AlertCircle size={13} className="shrink-0" />
        <span>{t("misc.updater.errorCompact")}</span>
      </div>
    );
  }

  return null;
}

/** Inline status row for the Settings view. */
export function UpdaterSettingsRow() {
  const { t } = useT();
  const status = useUpdaterStatus();

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
        {status.kind === "installing" && (
          <Button size="sm" disabled>{t("misc.updater.installingCompact")}</Button>
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
    case "manual-required": return describeManualRequired(s, t);
    case "not-available": return t("misc.updater.statusNotAvailable", { version: s.version });
    case "downloading": return t("misc.updater.statusDownloading", { percent: s.percent });
    case "downloaded": return t("misc.updater.statusDownloaded", { version: s.version });
    case "installing": return t("misc.updater.statusInstalling", { version: s.version });
    case "error": return t("misc.updater.statusError", { message: s.message });
  }
}

function describeManualRequired(
  s: Extract<UpdaterStatus, { kind: "manual-required" }>,
  t: TFunction,
): string {
  return s.reason === "mac-readonly-volume"
    ? t("misc.updater.manualRequiredReadOnly", { version: s.version })
    : t("misc.updater.manualRequiredSignature", { version: s.version });
}
