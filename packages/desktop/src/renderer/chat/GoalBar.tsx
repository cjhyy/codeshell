import React from "react";
import {
  ChevronDown,
  ChevronUp,
  CirclePause,
  MessageCircleQuestion,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { ActiveGoal } from "../types";

/** `12h 57m 34s` / `3m 05s` / `45s` — the Goal's age, Codex-style. */
export function formatGoalElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

interface Props {
  goal: ActiveGoal;
  /** A provider turn is running in this conversation. */
  busy: boolean;
  /** A pause/resume/edit is still in flight; controls stay disabled until it settles. */
  pending?: boolean;
  onPausedChange?: (paused: boolean) => void;
  onUpdate?: (objective: string) => void;
  onDelete?: () => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * The session's persistent Goal, pinned above the composer so it is visible
 * without hovering the top bar. A paused Goal swaps its icon and label: a
 * Goal that silently stopped driving looked identical to a running one.
 */
export function GoalBar({
  goal,
  busy,
  pending = false,
  onPausedChange,
  onUpdate,
  onDelete,
  now = Date.now,
}: Props) {
  const { t } = useT();
  const [expanded, setExpanded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(goal.objective);
  const [clock, setClock] = React.useState(now);

  React.useEffect(() => {
    if (!editing) setDraft(goal.objective);
  }, [editing, goal.objective]);

  // Tick only while the Goal is live; a paused Goal's age needs no animation.
  React.useEffect(() => {
    setClock(now());
    if (goal.paused || goal.setAtMs === undefined) return;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [goal.paused, goal.setAtMs, now]);

  const elapsed = goal.setAtMs !== undefined ? formatGoalElapsed(clock - goal.setAtMs) : undefined;
  // Paused wins: a paused Goal does not continue even after the user replies.
  const waiting = !goal.paused && !!goal.waitingForUser;
  const label = goal.paused
    ? t("chat.goal.barPaused")
    : waiting
      ? t("chat.goal.barWaiting")
      : t("chat.goal.barActive");
  const saveEdit = (): void => {
    const objective = draft.trim();
    if (!objective) return;
    if (objective !== goal.objective) onUpdate?.(objective);
    setEditing(false);
  };
  const cancelEdit = (): void => {
    setDraft(goal.objective);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "mx-3 rounded-t-2xl border border-b-0 px-3 text-sm",
        goal.paused
          ? "border-status-warn/40 bg-status-warn/5"
          : waiting
            ? "border-primary/30 bg-primary/5"
            : "border-border bg-background/80",
      )}
      data-goal-state={goal.paused ? "paused" : waiting ? "waiting" : busy ? "running" : "active"}
    >
      <div className="flex h-9 min-w-0 items-center gap-2">
        {goal.paused ? (
          <CirclePause
            size={15}
            className="shrink-0 text-status-warn"
            aria-label={t("misc.status.paused")}
          />
        ) : waiting ? (
          <MessageCircleQuestion
            size={15}
            className="shrink-0 text-primary"
            aria-label={t("chat.goal.barWaiting")}
          />
        ) : (
          <Target
            size={15}
            className={cn("shrink-0", busy ? "text-status-running" : "text-muted-foreground")}
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "shrink-0 font-medium",
            goal.paused ? "text-status-warn" : waiting ? "text-primary" : "text-foreground",
          )}
          title={
            goal.paused
              ? t("chat.goal.barPausedHint")
              : waiting
                ? `${t("chat.goal.barWaitingHint")} ${goal.waitingForUser}`
                : undefined
          }
        >
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="h-7 min-w-0 flex-1 justify-start px-1 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          title={goal.objective}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="truncate">{goal.objective}</span>
        </Button>
        {elapsed && (
          <span
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
            title={t("chat.goal.barElapsed", { elapsed })}
          >
            {elapsed}
          </span>
        )}
        <div className="flex shrink-0 items-center">
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              disabled={pending}
              aria-label={t("misc.status.deleteGoal")}
              title={t("misc.status.deleteGoal")}
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </Button>
          )}
          {onPausedChange && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-7",
                goal.paused ? "text-status-warn hover:text-foreground" : "text-muted-foreground",
              )}
              disabled={pending}
              aria-label={goal.paused ? t("misc.status.resumeGoal") : t("misc.status.pauseGoal")}
              title={goal.paused ? t("misc.status.resumeGoal") : t("misc.status.pauseGoal")}
              onClick={() => onPausedChange(!goal.paused)}
            >
              {goal.paused ? <Play size={14} /> : <Pause size={14} />}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-expanded={expanded}
            aria-label={expanded ? t("chat.goal.collapse") : t("chat.goal.expand")}
            title={expanded ? t("chat.goal.collapse") : t("chat.goal.expand")}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border/60 py-2">
          {editing ? (
            <div className="space-y-1.5">
              <Textarea
                autoFocus
                value={draft}
                rows={3}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    saveEdit();
                  }
                }}
                aria-label={t("misc.status.editGoalInput")}
                className="min-h-0 resize-none text-xs"
              />
              <div className="flex justify-end gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
                  {t("misc.status.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!draft.trim() || pending}
                  onClick={saveEdit}
                >
                  {t("misc.status.save")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <p className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground">
                {goal.objective}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {goal.round > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("misc.status.round", { round: goal.round })}
                  </span>
                )}
                {onUpdate && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    disabled={pending}
                    aria-label={t("misc.status.editGoal")}
                    title={t("misc.status.editGoal")}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil size={13} />
                  </Button>
                )}
              </div>
            </div>
          )}
          {goal.paused && (
            <p className="mt-1.5 text-xs text-status-warn">{t("chat.goal.barPausedHint")}</p>
          )}
          {waiting && (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-primary">
              {t("chat.goal.barWaitingHint")} {goal.waitingForUser}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
