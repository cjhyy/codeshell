import React, { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  Copy,
  Info,
  Trash2,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { copyText } from "../lib/clipboard";
import { useT } from "../i18n";
import { IconButton } from "./IconButton";
import { useToastHistory } from "./ToastProvider";
import { MAX_TOAST_HISTORY, type ToastHistoryEntry } from "./toastState";
import { OPEN_NOTIFICATION_SESSION_EVENT } from "../app/notificationSessionNavigation";
import { cn } from "@/lib/utils";

/** Inspect earlier notifications without leaving the active conversation. */
export function NotificationHistory({
  onCloseAutoFocus,
}: {
  onCloseAutoFocus?: React.ComponentPropsWithoutRef<typeof PopoverContent>["onCloseAutoFocus"];
}) {
  const notifications = useToastHistory();
  const { t, lang } = useT();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{ id: string; ok: boolean } | null>(null);
  const copyRequestId = useRef(0);
  const history = notifications?.history;
  const markRead = notifications?.markRead;
  useEffect(() => {
    if (open) markRead?.();
  }, [open, history, markRead]);
  useEffect(() => {
    if (expandedId && !history?.some((entry) => entry.id === expandedId)) setExpandedId(null);
  }, [expandedId, history]);

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
  const formatCompactTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const today = new Date();
    const locale = lang === "zh" ? "zh-CN" : "en-US";
    const time = date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return date.toDateString() === today.toDateString()
      ? time
      : `${date.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" })} ${time}`;
  };
  const copy = async (entry: ToastHistoryEntry) => {
    const requestId = ++copyRequestId.current;
    const ok = await copyText(
      [formatTime(entry.createdAt), entry.message, entry.detail].filter(Boolean).join("\n\n"),
    );
    if (copyRequestId.current === requestId) setCopyResult({ id: entry.id, ok });
  };

  return (
    <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setExpandedId(null);
          copyRequestId.current += 1;
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
          onCloseAutoFocus={onCloseAutoFocus}
          align="end"
          aria-labelledby={titleId}
          sideOffset={8}
          className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[420px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl p-0 shadow-xl"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <h2 id={titleId} className="text-[13px] font-medium">
                {t("misc.toast.history")}
              </h2>
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
                title={t("misc.toast.historyHint", { count: MAX_TOAST_HISTORY })}
              >
                {notifications.history.length}
              </span>
            </div>
            <IconButton
              label={t("misc.toast.clearHistory")}
              className="h-7 w-7 text-muted-foreground/70 hover:text-foreground"
              disabled={notifications.history.length === 0}
              onClick={() => {
                notifications.clear();
                setExpandedId(null);
                copyRequestId.current += 1;
                setCopyResult(null);
              }}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
          <div className="shrink-0 px-3 pb-2">
            <div className="inline-flex gap-0.5 rounded-md bg-muted/70 p-0.5">
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-6 rounded px-2.5 text-[11px] font-normal",
                  !errorsOnly && "bg-popover shadow-sm",
                )}
                aria-pressed={!errorsOnly}
                onClick={() => {
                  setErrorsOnly(false);
                  setExpandedId(null);
                }}
              >
                {t("misc.toast.all")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-6 rounded px-2.5 text-[11px] font-normal",
                  errorsOnly && "bg-popover shadow-sm",
                )}
                aria-pressed={errorsOnly}
                onClick={() => {
                  setErrorsOnly(true);
                  setExpandedId(null);
                }}
              >
                {t("misc.toast.errorsOnly")}
              </Button>
            </div>
          </div>
          <div
            className="min-h-0 max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain border-t border-border/60"
            tabIndex={0}
          >
            {entries.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                {t(errorsOnly ? "misc.toast.noErrors" : "misc.toast.emptyHistory")}
              </p>
            ) : (
              <ol className="divide-y divide-border/50">
                {entries.map((entry) => {
                  const expanded = expandedId === entry.id;
                  const detailId = `${titleId}-detail-${entry.id}`;
                  const diagnostic = expanded
                    ? [entry.message, entry.detail !== entry.message ? entry.detail : undefined]
                        .filter(Boolean)
                        .join("\n\n")
                    : "";
                  return (
                    <li
                      key={entry.id}
                      className={cn("min-w-0", expanded && "bg-muted/20")}
                      data-notification-id={entry.id}
                    >
                      <div className="flex items-start gap-0.5 px-2 py-1.5">
                        <button
                          type="button"
                          data-notification-action="toggle-details"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailId : undefined}
                          title={t(
                            expanded ? "misc.toast.collapseDetails" : "misc.toast.showDetails",
                          )}
                          onClick={() => setExpandedId(expanded ? null : entry.id)}
                          className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)_0.75rem] items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                        >
                          <span className="pt-0.5">
                            {entry.variant === "error" ? (
                              <AlertTriangle size={14} className="text-status-err" />
                            ) : entry.variant === "success" ? (
                              <Check size={14} className="text-status-ok" />
                            ) : (
                              <Info size={14} />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="mb-0.5 flex items-center gap-2 text-[10px] leading-4 text-muted-foreground">
                              <span className={cn(entry.variant === "error" && "text-status-err")}>
                                {t(
                                  entry.variant === "error"
                                    ? "misc.toast.error"
                                    : entry.variant === "success"
                                      ? "misc.toast.success"
                                      : "misc.toast.info",
                                )}
                              </span>
                              <time
                                dateTime={new Date(entry.createdAt).toISOString()}
                                title={formatTime(entry.createdAt)}
                              >
                                {formatCompactTime(entry.createdAt)}
                              </time>
                            </span>
                            <span className="line-clamp-2 break-words text-[13px] leading-[18px] [overflow-wrap:anywhere]">
                              {entry.message.replace(/\s+/g, " ").trim()}
                            </span>
                          </span>
                          <ChevronDown
                            size={12}
                            className={cn(
                              "mt-1 text-muted-foreground/60",
                              expanded && "rotate-180",
                            )}
                          />
                        </button>
                        <IconButton
                          label={t("misc.toast.copy")}
                          className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground/60"
                          onClick={() => void copy(entry)}
                        >
                          <Copy size={12} />
                        </IconButton>
                      </div>
                      {expanded && (
                        <div id={detailId} data-notification-detail className="px-3 pb-2.5">
                          <pre
                            tabIndex={0}
                            className="max-h-44 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground select-text [overflow-wrap:anywhere]"
                          >
                            {diagnostic}
                          </pre>
                          {entry.sessionId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="mt-1 h-7 gap-1 px-1 text-[11px] font-normal"
                              data-notification-action="open-session"
                              onClick={() => {
                                setOpen(false);
                                setExpandedId(null);
                                copyRequestId.current += 1;
                                window.dispatchEvent(
                                  new CustomEvent(OPEN_NOTIFICATION_SESSION_EVENT, {
                                    detail: { sessionId: entry.sessionId },
                                  }),
                                );
                              }}
                            >
                              {t("misc.toast.openSession")}
                              <ArrowUpRight size={12} />
                            </Button>
                          )}
                        </div>
                      )}
                      {copyResult?.id === entry.id && (
                        <p role="status" className="px-3 pb-2 text-[11px] text-muted-foreground">
                          {t(copyResult.ok ? "misc.toast.copied" : "misc.toast.copyFailed")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
