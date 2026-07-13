import React from "react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { Badge } from "../ui/Badge";
import { useT } from "../i18n";

export interface PetSidebarEntryProps {
  active: boolean;
  pendingCount: number;
  runningCount: number;
  onOpen: () => void;
}

export function PetSidebarEntry({
  active,
  pendingCount,
  runningCount,
  onOpen,
}: PetSidebarEntryProps) {
  const { t } = useT();
  const safePending = Math.max(0, pendingCount);
  const safeRunning = Math.max(0, runningCount);
  const description = t("pet.sidebar.summary", {
    pending: safePending,
    running: safeRunning,
  });

  return (
    <button
      type="button"
      className={
        "flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-sm transition " +
        (active
          ? "border-primary/15 bg-primary/10 text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground")
      }
      onClick={onOpen}
      aria-pressed={active}
      aria-label={`${t("pet.sidebar.label")}：${description}`}
      title={description}
    >
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-background/80">
        <img
          src={dogIcon}
          alt=""
          draggable={false}
          className="h-6 w-6 select-none object-contain"
        />
        {safeRunning > 0 && (
          <span
            data-pet-indicator="running"
            className="motion-reduce:animate-none absolute -bottom-0.5 -left-0.5 h-2 w-2 animate-pulse rounded-full border border-card bg-status-info"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="flex-1 text-left font-medium">{t("pet.sidebar.label")}</span>
      {safePending > 0 && (
        <span data-pet-indicator="pending" className="shrink-0">
          <Badge count={safePending} />
        </span>
      )}
    </button>
  );
}
