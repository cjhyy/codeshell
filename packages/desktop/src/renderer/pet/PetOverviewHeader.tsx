import React from "react";
import { CircleDot, Clock3, ListTodo, Radio, Sparkles } from "lucide-react";
import { useT } from "../i18n";

export interface PetOverviewHeaderProps {
  runningCount?: number;
  pendingCount?: number;
  followUpCount?: number;
  observedAt?: number;
  now?: number;
  loading?: boolean;
  reconciling?: boolean;
  retrying?: boolean;
  chatError?: string;
}

/** The rail is a live overview: its most useful numbers never need a disclosure. */
export function PetOverviewHeader({
  runningCount = 0,
  pendingCount = 0,
  followUpCount = 0,
  observedAt,
  now = Date.now(),
  loading = false,
  reconciling = false,
  retrying = false,
  chatError,
}: PetOverviewHeaderProps) {
  const { t } = useT();
  const minutes =
    observedAt === undefined ? undefined : Math.floor(Math.max(0, now - observedAt) / 60_000);
  const exceptionalStatus = loading
    ? t("pet.overview.loading")
    : retrying
      ? t("pet.overview.retrying")
      : reconciling
        ? t("pet.overview.reconciling")
        : null;
  const freshness =
    minutes === undefined
      ? t("pet.session.state.unknown")
      : minutes < 1
        ? t("pet.overview.updatedNow")
        : t("pet.overview.updatedMinutes", { count: minutes });
  const stats = [
    {
      key: "running",
      label: t("pet.overview.runningLabel"),
      count: runningCount,
      icon: CircleDot,
      tone: "text-status-running",
      background: "bg-status-running/8",
    },
    {
      key: "pending",
      label: t("pet.overview.pendingLabel"),
      count: pendingCount,
      icon: ListTodo,
      tone: pendingCount > 0 ? "text-status-warn" : "text-muted-foreground",
      background: pendingCount > 0 ? "bg-status-warn/10" : "bg-muted/45",
    },
    {
      key: "follow-up",
      label: t("pet.overview.followUpLabel"),
      count: followUpCount,
      icon: Sparkles,
      tone: followUpCount > 0 ? "text-primary" : "text-muted-foreground",
      background: followUpCount > 0 ? "bg-primary/8" : "bg-muted/45",
    },
  ];
  return (
    <header
      className="shrink-0 border-b border-border/50 px-4 pb-4 pt-5"
      aria-label={t("pet.overview.title")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Radio size={15} className="text-primary" aria-hidden="true" />
            {t("pet.overview.activityTitle")}
          </h2>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {t("pet.overview.activitySubtitle")}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2" aria-label={t("pet.overview.summaryLabel")}>
        {stats.map(({ key, label, count, icon: Icon, tone, background }) => (
          <div
            key={key}
            data-pet-overview-stat={key}
            className={`min-w-0 rounded-xl px-2.5 py-2.5 ${background}`}
          >
            <dt className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <Icon size={12} className={`shrink-0 ${tone}`} aria-hidden="true" />
              <span className="break-words">{label}</span>
            </dt>
            <dd className={`mt-1.5 text-xl font-semibold leading-6 tabular-nums ${tone}`}>
              {loading ? "—" : count}
            </dd>
          </div>
        ))}
      </dl>
      <p
        className={`mt-3 flex items-center gap-1.5 text-[10px] leading-4 ${exceptionalStatus ? "text-status-warn" : "text-muted-foreground"}`}
        role="status"
        aria-live="polite"
      >
        <Clock3 size={11} aria-hidden="true" />
        {exceptionalStatus ?? freshness}
      </p>
      {chatError && (
        <p
          className="mt-3 rounded-xl bg-status-warn/10 px-3 py-2 text-xs text-status-warn"
          role="status"
        >
          {chatError} · {t("pet.overview.chatFailureFallback")}
        </p>
      )}
    </header>
  );
}
