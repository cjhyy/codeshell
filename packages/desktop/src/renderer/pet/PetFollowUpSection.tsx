import React from "react";
import { ListTodo, X } from "lucide-react";
import type { PetSessionSummaryRow } from "../../preload/types";
import { useT } from "../i18n";
import { useFollowUps } from "./useFollowUps";

/**
 * "需要跟进" (needs-follow-up) block, rendered ABOVE the work tree. Lists ONLY
 * sessions whose closing left something the user must act on — the aux service
 * produces a line only for a genuine follow-up (an open "要不要我再做 X" or a
 * flagged next step), everything else is NONE and never reaches here.
 *
 * Each row shows the source session title (click → onOpen) plus its workspace,
 * and the follow-up line IN FULL (no truncation — it wraps naturally). Rows are
 * dismissable; dismiss reuses the shared work-inbox id `completed:${sessionId}`,
 * so clearing a follow-up also clears the session from the work tree's completed
 * bucket. When there is nothing to follow up (after the dismiss filter), the
 * block renders NOTHING — it only appears when there is something to act on.
 */

/** Stable work-inbox dismiss id for a follow-up row (shared with the work tree). */
export function followUpDismissId(sessionId: string): string {
  return `completed:${sessionId}`;
}

export function PetFollowUpSection({
  snapshotVersion,
  onOpen,
  onDismiss,
  dismissedIds,
}: {
  snapshotVersion: number | null;
  onOpen?: (sessionId: string) => void;
  onDismiss?: (id: string) => void;
  dismissedIds?: ReadonlySet<string>;
}) {
  const rows = useFollowUps(snapshotVersion);
  return (
    <PetFollowUpSectionView
      rows={rows}
      onOpen={onOpen}
      onDismiss={onDismiss}
      dismissedIds={dismissedIds}
    />
  );
}

export default function PetFollowUpSectionView({
  rows,
  onOpen,
  onDismiss,
  dismissedIds,
}: {
  rows: readonly PetSessionSummaryRow[];
  onOpen?: (sessionId: string) => void;
  onDismiss?: (id: string) => void;
  dismissedIds?: ReadonlySet<string>;
}) {
  const { t } = useT();
  const visible = rows.filter((row) => !dismissedIds?.has(followUpDismissId(row.sessionId)));
  // The block only exists when there is something to follow up on — no rows,
  // no noise.
  if (visible.length === 0) return null;
  return (
    <section
      data-pet-follow-up="needs-follow-up"
      className="rounded-2xl border border-status-warn/40 bg-status-warn/5 p-1"
    >
      <div className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-status-warn/15 text-status-warn">
          <ListTodo size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            {t("pet.followUp.title")}
          </span>
        </span>
        <span className="rounded-full bg-status-warn/15 px-2.5 py-1 text-[10px] font-semibold tabular-nums text-status-warn">
          {visible.length}
        </span>
      </div>
      <ul className="space-y-2 px-1.5 pb-1.5 pt-1">
        {visible.map((row) => (
          <li
            key={row.sessionId}
            data-pet-follow-up-row={row.sessionId}
            className="rounded-2xl border border-border/60 bg-background/60 p-3"
          >
            <div className="flex w-full min-w-0 items-baseline gap-2">
              {onOpen ? (
                <button
                  type="button"
                  data-pet-follow-up-open={row.sessionId}
                  aria-label={t("pet.followUp.openSessionAria", { title: row.title })}
                  className="flex min-w-0 flex-1 items-baseline gap-2 text-left transition hover:text-primary"
                  onClick={() => onOpen(row.sessionId)}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.title}</span>
                  {row.workspace && (
                    <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                      {row.workspace}
                    </span>
                  )}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.title}</span>
                  {row.workspace && (
                    <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                      {row.workspace}
                    </span>
                  )}
                </div>
              )}
              {onDismiss && (
                <button
                  type="button"
                  data-pet-follow-up-dismiss={row.sessionId}
                  aria-label={t("pet.followUp.dismissAria", { title: row.title })}
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => onDismiss(followUpDismissId(row.sessionId))}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {row.text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
