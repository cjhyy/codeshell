import React from "react";
import { FileClock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TFunction } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

export const RUN_STATUSES: Record<string, { tone: string; label: TranslationKey }> = {
  queued: { tone: "text-muted-foreground", label: "auto.runs.statusQueued" },
  running: { tone: "text-status-running", label: "auto.runs.statusRunning" },
  waiting_input: { tone: "text-status-warn", label: "auto.runs.statusWaitingInput" },
  waiting_approval: { tone: "text-status-warn", label: "auto.runs.statusWaitingApproval" },
  blocked: { tone: "text-status-warn", label: "auto.runs.statusBlocked" },
  completed: { tone: "text-status-ok", label: "auto.runs.statusCompleted" },
  failed: { tone: "text-status-err", label: "auto.runs.statusFailed" },
  cancelled: { tone: "text-muted-foreground", label: "auto.runs.statusCancelled" },
  unknown: { tone: "text-muted-foreground", label: "auto.runs.statusUnknown" },
};

export function statusLabel(status: string, t: TFunction): string {
  return RUN_STATUSES[status] ? t(RUN_STATUSES[status].label) : status || t("auto.runs.none");
}

export function RunStatus({ status, t }: { status: string; t: TFunction }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        RUN_STATUSES[status]?.tone ?? "text-muted-foreground",
      )}
      title={status}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {statusLabel(status, t)}
    </span>
  );
}

export function formatRunTime(timestamp: number, lang: string, compact = false): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString(
    lang === "zh" ? "zh-CN" : "en-US",
    compact
      ? {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }
      : undefined,
  );
}

export function RunPlaceholder({
  children,
  loading = false,
}: {
  children: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-col items-center gap-3 px-4 py-8 text-center text-sm leading-relaxed text-muted-foreground"
    >
      {loading ? (
        <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <FileClock size={24} className="opacity-60" aria-hidden />
      )}
      {children}
    </div>
  );
}
