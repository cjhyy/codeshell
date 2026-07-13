import React from "react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { useT } from "../i18n";
import { Badge } from "../ui/Badge";

export function PetWidget({
  visible,
  runningCount,
  pendingCount,
  onOpen,
}: {
  visible: boolean;
  runningCount: number;
  pendingCount: number;
  onOpen: () => void;
}) {
  const { t } = useT();
  if (!visible) return null;
  const running = Math.max(0, runningCount);
  const pending = Math.max(0, pendingCount);
  const summary = t("pet.sidebar.summary", { pending, running });
  return (
    <button
      type="button"
      data-pet-widget="bottom-left"
      className="group fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-popover/95 shadow-lg transition-transform hover:-translate-y-0.5 hover:shadow-xl"
      onClick={onOpen}
      aria-label={`${t("pet.widget.open")}：${summary}`}
      title={summary}
    >
      <img
        src={dogIcon}
        alt=""
        draggable={false}
        className="h-10 w-10 select-none rounded-xl object-contain transition-transform group-hover:scale-105"
      />
      {running > 0 && (
        <span
          data-pet-indicator="running"
          className="motion-reduce:animate-none absolute bottom-0.5 left-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-popover bg-status-info"
          aria-hidden="true"
        />
      )}
      {pending > 0 && (
        <span className="absolute -right-1.5 -top-1.5" data-pet-indicator="pending">
          <Badge count={pending} />
        </span>
      )}
    </button>
  );
}
