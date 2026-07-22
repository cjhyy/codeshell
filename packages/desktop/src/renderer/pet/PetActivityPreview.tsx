import React from "react";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useT } from "../i18n";
import { petExternalSessionLocator } from "./petExternalSession";
import type { PetWidgetActivityItem } from "./petWidgetActivity";

export function PetActivityPreview({
  item,
  onOpen,
  onDismiss,
  actionLabel,
}: {
  item: PetWidgetActivityItem;
  onOpen: () => void;
  onDismiss?: () => void;
  actionLabel?: string;
}) {
  const { t } = useT();
  const stateLabel = t(`pet.widget.workState.${item.kind}`);
  const navigationDisabled = Boolean(item.external && !petExternalSessionLocator(item));

  return (
    <div
      data-pet-activity-preview="true"
      className="group relative min-h-20 w-full shrink-0 rounded-[28px] border border-border/50 bg-popover/95 text-popover-foreground shadow-[0_8px_24px_rgb(0_0_0/0.10)] backdrop-blur transition-[border-color,box-shadow] hover:border-border/75 hover:shadow-[0_10px_28px_rgb(0_0_0/0.13)] focus-within:ring-2 focus-within:ring-primary/50"
    >
      <button
        type="button"
        disabled={navigationDisabled}
        title={navigationDisabled ? t("pet.work.externalUnavailable") : undefined}
        className="flex min-h-20 w-full items-center gap-3 rounded-[inherit] border-0 bg-transparent px-5 py-3 text-left outline-none disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => !navigationDisabled && onOpen()}
        aria-label={actionLabel ?? t("pet.widget.previewAria", { title: item.title })}
      >
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm leading-5">
            <strong className="font-semibold">{item.title}</strong>
            {item.detail && (
              <>
                <span className="px-1 text-muted-foreground" aria-hidden="true">
                  ·
                </span>
                <span className="text-muted-foreground">{item.detail}</span>
              </>
            )}
          </span>
          <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{stateLabel}</span>
          </span>
        </span>

        <span
          className={
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border " +
            (item.kind === "needs-action"
              ? "border-status-warn/35 bg-status-warn/10 text-status-warn"
              : item.kind === "completed"
                ? "border-status-ok/35 bg-status-ok/10 text-status-ok"
                : "border-status-running/35 bg-status-running/10 text-status-running")
          }
          title={stateLabel}
          aria-hidden="true"
        >
          {item.kind === "needs-action" ? (
            <CircleAlert className="h-5 w-5" />
          ) : item.kind === "completed" ? (
            <Check className="h-5 w-5" />
          ) : (
            <LoaderCircle className="h-6 w-6 animate-spin group-hover:[animation-play-state:paused] motion-reduce:animate-none" />
          )}
        </span>
      </button>

      {onDismiss && (
        <button
          type="button"
          data-pet-activity-dismiss={item.key}
          className="pointer-events-none absolute -left-2 -top-2 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground opacity-0 shadow-md transition-[opacity,transform,color] hover:scale-105 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          aria-label={`${t(
            item.kind === "completed" ? "pet.peek.close" : "pet.widget.collapseSessions",
          )}：${item.title}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
