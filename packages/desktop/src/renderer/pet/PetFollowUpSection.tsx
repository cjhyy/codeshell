import React from "react";
import { ArrowUpRight, BellRing, Bot, Check, X } from "lucide-react";
import type { PetSessionSummaryRow } from "../../preload/types";
import { petFollowUpStateId } from "../../shared/pet-work-item-id";
import { useT } from "../i18n";
import { useOptionalPetState } from "./PetStateProvider";

/**
 * "需要跟进" (needs-follow-up) block, rendered ABOVE the work tree. Lists ONLY
 * sessions whose closing left something the user must act on — the aux service
 * produces a line only for a genuine follow-up (an open "要不要我再做 X" or a
 * flagged next step), everything else is NONE and never reaches here.
 *
 * Each row shows the source session title (click → onOpen) plus its workspace,
 * and the follow-up line IN FULL (no truncation — it wraps naturally). Rows are
 * dismissable; UI buttons and Mimi's ManageFollowUp tool persist the same exact
 * `follow-up:${followUpId}` state. This is deliberately separate from the
 * source session's completed-row state, so handling a reminder does not hide its
 * work history. When there is nothing to follow up (after the state filter), the
 * block renders NOTHING — it only appears when there is something to act on.
 */

export function PetFollowUpSection({
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
  const { dispatch } = useOptionalPetState();
  return (
    <PetFollowUpSectionView
      rows={rows}
      onOpen={onOpen}
      onDismiss={onDismiss}
      onAskMimi={(row) =>
        dispatch({
          type: "set-chat-draft",
          draft: t("pet.followUp.askMimiPrompt", {
            followUpId: row.followUpId,
            title: row.title,
            text: row.text,
          }),
        })
      }
      dismissedIds={dismissedIds}
    />
  );
}

export default function PetFollowUpSectionView({
  rows,
  onOpen,
  onDismiss,
  onAskMimi,
  dismissedIds,
}: {
  rows: readonly PetSessionSummaryRow[];
  onOpen?: (sessionId: string) => void;
  onDismiss?: (id: string) => void;
  onAskMimi?: (row: PetSessionSummaryRow) => void;
  dismissedIds?: ReadonlySet<string>;
}) {
  const { t } = useT();
  const visible = rows
    .filter((row) => !dismissedIds?.has(petFollowUpStateId(row.followUpId)))
    .slice(0, 20);
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
          <BellRing size={16} aria-hidden="true" />
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
            key={row.followUpId}
            data-pet-follow-up-row={row.sessionId}
            data-pet-follow-up-id={row.followUpId}
            className="rounded-2xl border border-border/60 bg-background/60 p-3"
          >
            <div className="flex w-full min-w-0 items-baseline gap-2">
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.title}</span>
                {row.workspace && (
                  <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                    {row.workspace}
                  </span>
                )}
              </div>
              {onDismiss && (
                <button
                  type="button"
                  data-pet-follow-up-dismiss={row.sessionId}
                  aria-label={t("pet.followUp.dismissAria", { title: row.title })}
                  title={t("pet.followUp.dismiss")}
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => onDismiss(petFollowUpStateId(row.followUpId))}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {row.text}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {onOpen && (
                <button
                  type="button"
                  data-pet-follow-up-open={row.sessionId}
                  aria-label={t("pet.followUp.openSessionAria", { title: row.title })}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition hover:border-primary/30 hover:text-primary"
                  onClick={() => onOpen(row.sessionId)}
                >
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {t("pet.followUp.continue")}
                </button>
              )}
              {onAskMimi && (
                <button
                  type="button"
                  data-pet-follow-up-ask-mimi={row.sessionId}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 text-xs font-medium text-primary transition hover:bg-primary/15"
                  onClick={() => onAskMimi(row)}
                >
                  <Bot size={13} aria-hidden="true" />
                  {t("pet.followUp.askMimi")}
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  data-pet-follow-up-complete={row.sessionId}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-status-ok transition hover:bg-status-ok/10"
                  onClick={() => onDismiss(petFollowUpStateId(row.followUpId))}
                >
                  <Check size={13} aria-hidden="true" />
                  {t("pet.followUp.complete")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
