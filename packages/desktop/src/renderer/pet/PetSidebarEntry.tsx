import React from "react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { Badge } from "../ui/Badge";
import { useT } from "../i18n";
import { Eye, EyeOff } from "lucide-react";

export interface PetSidebarEntryProps {
  active: boolean;
  pendingCount: number;
  runningCount: number;
  onOpen: () => void;
  widgetVisible?: boolean;
  onToggleWidget?: () => void;
}

export function PetSidebarEntry({
  active,
  pendingCount,
  runningCount,
  onOpen,
  widgetVisible = true,
  onToggleWidget,
}: PetSidebarEntryProps) {
  const { t } = useT();
  const safePending = Math.max(0, pendingCount);
  const safeRunning = Math.max(0, runningCount);
  const description = t("pet.sidebar.summary", {
    pending: safePending,
    running: safeRunning,
  });

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        className={
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors " +
          (active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
        }
        onClick={onOpen}
        aria-pressed={active}
        aria-label={`${t("pet.sidebar.label")}：${description}`}
        title={description}
      >
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <img
            src={dogIcon}
            alt=""
            draggable={false}
            className="h-5 w-5 select-none rounded object-contain"
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
      {onToggleWidget && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={onToggleWidget}
          aria-pressed={widgetVisible}
        >
          {widgetVisible ? <Eye size={12} /> : <EyeOff size={12} />}
          <span>{widgetVisible ? t("pet.widget.hide") : t("pet.widget.show")}</span>
        </button>
      )}
    </div>
  );
}
