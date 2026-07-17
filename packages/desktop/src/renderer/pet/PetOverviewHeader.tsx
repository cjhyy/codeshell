import React from "react";
import { ChevronDown, CircleDot, Clock3, LayoutDashboard, Sparkles } from "lucide-react";
import dogIcon from "../assets/codeshell-dog-icon.png";
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
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();
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
    minutes === undefined || minutes < 1
      ? t("pet.overview.updatedNow")
      : t("pet.overview.updatedMinutes", { count: minutes });
  return (
    <header className="border-b border-border/55 px-5 py-4 min-[1440px]:px-6 min-[1440px]:py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 shadow-sm">
            <img
              src={dogIcon}
              alt=""
              draggable={false}
              className="h-10 w-10 select-none object-contain"
            />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{t("pet.overview.title")}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {t("pet.overview.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {exceptionalStatus && (
            <span
              className="rounded-full bg-status-warn/10 px-2.5 py-1 text-xs font-medium text-status-warn"
              aria-live="polite"
            >
              {exceptionalStatus}
            </span>
          )}
          <div>
            <button
              type="button"
              data-pet-overview-summary="toggle"
              aria-expanded={expanded}
              aria-controls={detailsId}
              title={expanded ? t("pet.overview.collapseSummary") : t("pet.overview.expandSummary")}
              className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition hover:border-primary/25 hover:bg-background hover:text-foreground"
              onClick={() => setExpanded((current) => !current)}
            >
              <LayoutDashboard size={14} aria-hidden="true" />
              <span>{t("pet.overview.summaryLabel")}</span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div
          id={detailsId}
          data-pet-overview-details="expanded"
          className="mt-4 rounded-2xl border border-border/50 bg-muted/35 p-3"
        >
          {!exceptionalStatus && (
            <div
              className="mb-2.5 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              <Clock3 size={12} aria-hidden="true" />
              {freshness}
            </div>
          )}
          {!loading && (
            <div className="grid grid-cols-3 gap-2">
              <div
                data-pet-overview-stat="running"
                className="rounded-xl border border-status-running/15 bg-background/75 p-3"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CircleDot size={13} className="text-status-running" aria-hidden="true" />
                  {t("pet.overview.runningLabel")}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{runningCount}</div>
              </div>
              <div
                data-pet-overview-stat="pending"
                className="rounded-xl border border-status-warn/15 bg-background/75 p-3"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CircleDot size={13} className="text-status-warn" aria-hidden="true" />
                  {t("pet.overview.pendingLabel")}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{pendingCount}</div>
              </div>
              <div
                data-pet-overview-stat="follow-up"
                className="rounded-xl border border-status-warn/15 bg-background/75 p-3"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles size={13} className="text-status-warn" aria-hidden="true" />
                  {t("pet.overview.followUpLabel")}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{followUpCount}</div>
              </div>
            </div>
          )}
        </div>
      )}
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
