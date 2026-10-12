import React, { useEffect, useId, useState } from "react";
import { AlertTriangle, Bell, Check, Copy, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { copyText } from "../lib/clipboard";
import { useT } from "../i18n";
import { IconButton } from "./IconButton";
import { useToastHistory } from "./ToastProvider";
import { MAX_TOAST_HISTORY, type ToastHistoryEntry } from "./toastState";
import { OPEN_NOTIFICATION_SESSION_EVENT } from "../app/notificationSessionNavigation";

/** Inspect earlier notifications without leaving the active conversation. */
export function NotificationHistory() {
  const notifications = useToastHistory();
  const { t, lang } = useT();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copyResult, setCopyResult] = useState<{ id: string; ok: boolean } | null>(null);
  const history = notifications?.history;
  const markRead = notifications?.markRead;
  useEffect(() => {
    if (open) markRead?.();
  }, [open, history, markRead]);

  if (!notifications) return null;
  const unreadErrors = notifications.history.filter((n) => n.variant === "error" && !n.read).length;
  const entries = notifications.history
    .filter((n) => !errorsOnly || n.variant === "error")
    .slice()
    .reverse();
  const label = unreadErrors
    ? t("misc.toast.historyUnread", { count: unreadErrors })
    : t("misc.toast.history");
  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  const copy = async (entry: ToastHistoryEntry) => {
    const ok = await copyText(
      [formatTime(entry.createdAt), entry.message, entry.detail].filter(Boolean).join("\n\n"),
    );
    setCopyResult({ id: entry.id, ok });
  };

  return (
    <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setCopyResult(null);
        }}
      >
        <PopoverTrigger asChild>
          <IconButton
            label={label}
            active={open}
            className="relative"
            data-notification-action="open"
          >
            <Bell size={14} />
            {unreadErrors > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-status-err px-0.5 text-[9px] leading-3.5 text-white"
              >
                {unreadErrors > 99 ? "99+" : unreadErrors}
              </span>
            )}
          </IconButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-labelledby={titleId}
          className="w-[min(28rem,calc(100vw-1.5rem))]"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            <div>
              <h2 id={titleId} className="text-sm font-semibold">
                {t("misc.toast.history")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("misc.toast.historyHint", { count: MAX_TOAST_HISTORY })}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={notifications.history.length === 0}
              onClick={() => {
                notifications.clear();
                setCopyResult(null);
              }}
            >
              {t("misc.toast.clearHistory")}
            </Button>
          </div>
          <div className="flex gap-1 border-b border-border px-3 py-2">
            <Button
              size="sm"
              variant={errorsOnly ? "ghost" : "secondary"}
              aria-pressed={!errorsOnly}
              onClick={() => setErrorsOnly(false)}
            >
              {t("misc.toast.all")}
            </Button>
            <Button
              size="sm"
              variant={errorsOnly ? "secondary" : "ghost"}
              aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly(true)}
            >
              {t("misc.toast.errorsOnly")}
            </Button>
          </div>
          <div className="max-h-[60vh] overflow-auto overscroll-contain" tabIndex={0}>
            {entries.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {t(errorsOnly ? "misc.toast.noErrors" : "misc.toast.emptyHistory")}
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {entries.map((entry) => (
                  <li key={entry.id} className="space-y-2 p-3" data-notification-id={entry.id}>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {entry.variant === "error" ? (
                        <AlertTriangle size={14} className="text-status-err" />
                      ) : entry.variant === "success" ? (
                        <Check size={14} className="text-status-ok" />
                      ) : (
                        <Info size={14} />
                      )}
                      <span>
                        {t(
                          entry.variant === "error"
                            ? "misc.toast.error"
                            : entry.variant === "success"
                              ? "misc.toast.success"
                              : "misc.toast.info",
                        )}
                      </span>
                      <time dateTime={new Date(entry.createdAt).toISOString()} className="flex-1">
                        {formatTime(entry.createdAt)}
                      </time>
                      <IconButton label={t("misc.toast.copy")} onClick={() => void copy(entry)}>
                        <Copy size={13} />
                      </IconButton>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm select-text">
                      {entry.message}
                    </p>
                    {entry.detail && entry.detail !== entry.message && (
                      <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs select-text">
                        {entry.detail}
                      </p>
                    )}
                    {entry.sessionId && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-notification-action="open-session"
                        onClick={() => {
                          setOpen(false);
                          window.dispatchEvent(
                            new CustomEvent(OPEN_NOTIFICATION_SESSION_EVENT, {
                              detail: { sessionId: entry.sessionId },
                            }),
                          );
                        }}
                      >
                        {t("misc.toast.openSession")}
                      </Button>
                    )}
                    {copyResult?.id === entry.id && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {t(copyResult.ok ? "misc.toast.copied" : "misc.toast.copyFailed")}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
