import React from "react";
import { useT } from "../i18n";

export interface PetOverviewHeaderProps {
  runningCount?: number;
  queuedCount?: number;
  pendingCount?: number;
  observedAt?: number;
  now?: number;
  loading?: boolean;
  reconciling?: boolean;
  chatError?: string;
}

export function PetOverviewHeader({
  runningCount = 0,
  queuedCount = 0,
  pendingCount = 0,
  observedAt,
  now = Date.now(),
  loading = false,
  reconciling = false,
  chatError,
}: PetOverviewHeaderProps) {
  const { t } = useT();
  const minutes =
    observedAt === undefined ? undefined : Math.floor(Math.max(0, now - observedAt) / 60_000);
  return (
    <header className="border-b border-border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("pet.overview.title")}</h2>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? t("pet.overview.loading")
            : reconciling
              ? t("pet.overview.reconciling")
              : minutes === undefined || minutes < 1
                ? t("pet.overview.updatedNow")
                : t("pet.overview.updatedMinutes", { count: minutes })}
        </span>
      </div>
      {!loading && (
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{t("pet.overview.runningCount", { count: runningCount })}</span>
          <span>{t("pet.overview.queuedCount", { count: queuedCount })}</span>
          <span>{t("pet.overview.pendingCount", { count: pendingCount })}</span>
        </div>
      )}
      {chatError && (
        <p className="mt-1 text-xs text-status-warn" role="status">
          {chatError} · {t("pet.overview.chatFailureFallback")}
        </p>
      )}
    </header>
  );
}
