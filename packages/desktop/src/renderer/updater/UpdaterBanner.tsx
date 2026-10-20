import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UpdaterStatus } from "../../preload/types";
import { AlertCircle, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT, type TFunction } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";

const SIDEBAR_UPDATE_ACTION_CLASS =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";
const SIDEBAR_UPDATE_PROGRESS_CLASS =
  "inline-flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-muted-foreground";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useUpdaterStatus(onReadSuccess?: () => void) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    setLoading(true);
    // Subscribe before reading; a pushed status is newer than this snapshot.
    const unsubscribe = window.codeshell.onUpdaterStatus((s) => {
      if (!mounted) return;
      receivedEvent = true;
      onReadSuccess?.();
      setStatus(s);
      setLoading(false);
      setError(null);
    });
    void window.codeshell
      .getUpdaterStatus()
      .then((s) => {
        if (mounted && !receivedEvent) {
          onReadSuccess?.();
          setStatus(s);
          setError(null);
        }
      })
      .catch((cause) => {
        if (mounted && !receivedEvent) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [revision, onReadSuccess]);

  return { status, loading, error, retry };
}

export function SidebarUpdaterButton() {
  const { t } = useT();
  const toast = useToast();
  const { status } = useUpdaterStatus();
  const [downloadPending, setDownloadPending] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const reportError = (cause: unknown) =>
    toast({
      message: t("misc.updater.actionFailed", { error: errorMessage(cause) }),
      variant: "error",
    });

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

  // GitHub may be blocked or temporarily unreachable on the current network.
  // Keep the diagnostic in Settings, but do not turn the persistent sidebar
  // footer into an error state for this non-critical background check.
  if (visibleStatus.kind === "error" && visibleStatus.reason === "github-unreachable") {
    return null;
  }

  if (visibleStatus.kind === "available") {
    const title = t("misc.updater.available", { version: visibleStatus.version });
    return (
      <button
        type="button"
        className={SIDEBAR_UPDATE_ACTION_CLASS}
        onClick={() => {
          setDownloadPending(true);
          void window.codeshell.downloadUpdate().catch((cause) => {
            setDownloadPending(false);
            reportError(cause);
          });
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
        onClick={() => void window.codeshell.openExternal(visibleStatus.url).catch(reportError)}
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
      <div className={SIDEBAR_UPDATE_PROGRESS_CLASS} aria-label={title} role="status" title={title}>
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
          void window.codeshell.installUpdate().catch((cause) => {
            setInstallPending(false);
            reportError(cause);
          });
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
      <div className={SIDEBAR_UPDATE_PROGRESS_CLASS} aria-label={title} role="status" title={title}>
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
  const [actionError, setActionError] = useState<string | null>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const versionRetry = useRef<HTMLButtonElement>(null);
  const statusRetry = useRef<HTMLButtonElement>(null);
  const handoffFocus = useRef(false);
  const statusReadSuccess = useCallback(() => {
    if (document.activeElement === statusRetry.current) handoffFocus.current = true;
    setActionError(null);
  }, []);
  const {
    status,
    loading,
    error: statusError,
    retry: retryStatus,
  } = useUpdaterStatus(statusReadSuccess);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionRevision, setVersionRevision] = useState(0);
  const [versionLoading, setVersionLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setVersionLoading(true);
    void window.codeshell
      .getAppVersion()
      .then((v) => {
        if (active) {
          if (document.activeElement === versionRetry.current) handoffFocus.current = true;
          setAppVersion(v);
          setVersionError(null);
        }
      })
      .catch((cause) => {
        if (active) setVersionError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setVersionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [versionRevision]);

  useLayoutEffect(() => {
    if (!handoffFocus.current) return;
    handoffFocus.current = false;
    if (document.activeElement === document.body) checkButton.current?.focus();
  });

  const statusBusy = ["checking", "downloading", "installing"].includes(status.kind);
  const disabled = loading || !!statusError || pending !== null || statusBusy;
  const invoke = async (kind: string, run: () => Promise<unknown>): Promise<void> => {
    if (actionPending.current || disabled) return;
    actionPending.current = true;
    setPending(kind);
    setActionError(null);
    try {
      await run();
    } catch (cause) {
      if (mounted.current) setActionError(errorMessage(cause));
    } finally {
      actionPending.current = false;
      if (mounted.current) setPending(null);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]">
      <h3 className="text-sm font-semibold">{t("misc.updater.autoUpdate")}</h3>
      <div className="text-sm">
        <span className="text-muted-foreground">{t("misc.updater.currentVersionLabel")}</span>
        <span>{appVersion ?? (versionError ? t("misc.updater.versionUnavailable") : "…")}</span>
      </div>
      <div className="text-sm">
        <span className="text-muted-foreground">{t("misc.updater.statusLabel")}</span>
        <span role="status">
          {loading ? t("misc.updater.loadingStatus") : describeStatus(status, t)}
        </span>
      </div>
      {!loading && status.kind === "error" && (
        <details className="min-w-0 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            {t("misc.updater.errorDetails")}
          </summary>
          <pre
            tabIndex={0}
            className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {status.message}
          </pre>
        </details>
      )}
      {versionError && (
        <div className="flex flex-wrap items-start gap-2 text-xs text-status-err" role="alert">
          <span className="min-w-0 flex-1">
            {t("misc.updater.versionFailed", { error: versionError })}
          </span>
          <Button
            ref={versionRetry}
            size="sm"
            variant="outline"
            aria-disabled={versionLoading}
            aria-busy={versionLoading}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => {
              if (!versionLoading) setVersionRevision((value) => value + 1);
            }}
          >
            {t("misc.updater.retryVersion")}
          </Button>
        </div>
      )}
      {statusError && (
        <div className="flex flex-wrap items-start gap-2 text-xs text-status-err" role="alert">
          <span className="min-w-0 flex-1">
            {t("misc.updater.statusFailed", { error: statusError })}
          </span>
        </div>
      )}
      {actionError && (
        <div className="flex flex-wrap items-start gap-2 text-xs text-status-err" role="alert">
          <p className="min-w-0 flex-1">{t("misc.updater.actionFailed", { error: actionError })}</p>
        </div>
      )}
      {(statusError || actionError) && (
        <Button
          ref={statusRetry}
          size="sm"
          variant="outline"
          aria-disabled={loading}
          aria-busy={loading}
          className="self-start aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!loading) retryStatus();
          }}
        >
          {t("misc.updater.retryStatus")}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={checkButton}
          size="sm"
          variant="outline"
          aria-disabled={disabled}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-busy={pending === "check"}
          onClick={() => void invoke("check", () => window.codeshell.checkForUpdate())}
        >
          {t("misc.updater.checkUpdate")}
        </Button>
        {status.kind === "available" && (
          <Button
            size="sm"
            aria-disabled={disabled}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-busy={pending === "download"}
            onClick={() => void invoke("download", () => window.codeshell.downloadUpdate())}
          >
            {t("misc.updater.download")}
          </Button>
        )}
        {status.kind === "downloaded" && (
          <Button
            size="sm"
            aria-disabled={disabled}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-busy={pending === "install"}
            onClick={() => void invoke("install", () => window.codeshell.installUpdate())}
          >
            {t("misc.updater.restartInstall")}
          </Button>
        )}
        {status.kind === "installing" && (
          <Button size="sm" disabled>
            {t("misc.updater.installingCompact")}
          </Button>
        )}
        {status.kind === "manual-required" && (
          <Button
            size="sm"
            aria-disabled={disabled}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-busy={pending === "open"}
            onClick={() => void invoke("open", () => window.codeshell.openExternal(status.url))}
          >
            {t("misc.updater.openRelease")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("misc.updater.feedHint")}</p>
    </section>
  );
}

function describeStatus(s: UpdaterStatus, t: TFunction): string {
  switch (s.kind) {
    case "idle":
      return t("misc.updater.statusIdle");
    case "checking":
      return t("misc.updater.statusChecking");
    case "available":
      return t("misc.updater.statusAvailable", { version: s.version });
    case "manual-required":
      return describeManualRequired(s, t);
    case "not-available":
      return t("misc.updater.statusNotAvailable", { version: s.version });
    case "downloading":
      return t("misc.updater.statusDownloading", { percent: s.percent });
    case "downloaded":
      return t("misc.updater.statusDownloaded", { version: s.version });
    case "installing":
      return t("misc.updater.statusInstalling", { version: s.version });
    case "error":
      return t("misc.updater.statusErrorSummary");
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
