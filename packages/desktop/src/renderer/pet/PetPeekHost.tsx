import type { PetPeek } from "../../preload/types";
import React from "react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { useT } from "../i18n";

export function PetPeekHost({
  peeks,
  onAction,
  onDismiss,
}: {
  peeks: readonly PetPeek[];
  onAction: (peek: PetPeek) => void;
  onDismiss: (peek: PetPeek) => void;
}) {
  const { t } = useT();
  return (
    <div
      data-pet-peek-stack="bottom-right"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      {peeks.map((peek) => (
        <section
          key={peek.id}
          className="pointer-events-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start gap-2">
            <img src={dogIcon} alt="" className="h-8 w-8 rounded object-contain" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{peek.title}</p>
              <p className="text-xs text-muted-foreground">{peek.detail}</p>
            </div>
            <button
              type="button"
              className="rounded px-1 text-muted-foreground hover:bg-muted"
              aria-label={t("pet.peek.close")}
              onClick={() => onDismiss(peek)}
            >
              ×
            </button>
          </div>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={() => onAction(peek)}
          >
            {peek.action.type === "open_session"
              ? t("pet.pending.open")
              : t("pet.peek.openPending")}
          </button>
        </section>
      ))}
    </div>
  );
}
