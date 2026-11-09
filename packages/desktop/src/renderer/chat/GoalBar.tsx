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
import { goalElapsedMs } from "../goalClock";
import { GoalReplyCard } from "./GoalReplyCard";
import type { MarkdownRootStatus } from "../Markdown";

/** `12h 57m 34s` / `3m 05s` / `45s` — accumulated goal time. */
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
  onReply?: (answer: string) => void | Promise<void>;
  replyDisabled?: boolean;
  sessionId?: string | null;
  cwd?: string | null;
  rootId?: string | null;
  rootStatus?: MarkdownRootStatus;
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
  onReply,
  replyDisabled = false,
  sessionId,
  cwd,
  rootId,
  rootStatus,
  now = Date.now,
}: Props) {
  const { t } = useT();
  const [expanded, setExpanded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(goal.objective);
  const [clock, setClock] = React.useState(now);
  const replyKey = JSON.stringify([
    sessionId,
    goal.goalId,
    goal.objective,
    goal.round,
    goal.waitingForUser,
  ]);
  // Keep an answer through the optimistic waiting -> running -> failed launch
  // transition, even while the reply card itself is temporarily unmounted.
  const [replyDraft, setReplyDraft] = React.useState({ key: "", text: "", failed: false });
  const reply = onReply
    ? async (answer: string): Promise<void> => {
        setReplyDraft({ key: replyKey, text: answer, failed: false });
        try {
          await onReply(answer);
          setReplyDraft((previous) =>
            previous.key === replyKey ? { key: "", text: "", failed: false } : previous,
          );
        } catch (error) {
          setReplyDraft((previous) =>
            previous.key === replyKey ? { ...previous, failed: true } : previous,
          );
          throw error;
        }
      }
    : undefined;

  React.useEffect(() => {
    if (!editing) setDraft(goal.objective);
  }, [editing, goal.objective]);

  // Unknown historical accounting is not elapsed work. Never substitute the
  // goal's wall-clock age: it includes pauses and time spent waiting for replies.
  const ticking =
    goal.activeMs !== undefined &&
    !goal.paused &&
    !goal.waitingForUser &&
    goal.clockSinceMs !== undefined;
  React.useEffect(() => {
    setClock(now());
    if (!ticking) return;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, now]);

  const goalTime = goalElapsedMs(goal, clock);
  const elapsed = goalTime !== undefined ? formatGoalElapsed(goalTime) : undefined;
  const elapsedLabel =
    goalTime !== undefined && goal.round > 0
      ? t("chat.goal.barActiveTime", { round: goal.round, elapsed: elapsed! })
      : elapsed;
  const elapsedTitle =
    goalTime !== undefined
      ? t("chat.goal.barActiveTimeHint", {
          elapsed: elapsed!,
          setAt: goal.setAtMs !== undefined ? new Date(goal.setAtMs).toLocaleString() : "—",
        })
      : elapsed && t("chat.goal.barElapsed", { elapsed });
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
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 py-1">
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
            "min-w-0 truncate font-medium",
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
          className="col-span-2 row-start-2 h-7 min-w-0 justify-start px-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          title={goal.objective}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="truncate">{goal.objective}</span>
        </Button>
        {elapsedLabel && (
          <span
            className="col-start-3 row-start-2 justify-self-end text-xs tabular-nums text-muted-foreground"
            title={elapsedTitle || undefined}
          >
            {elapsedLabel}
          </span>
        )}
        <div className="col-start-3 row-start-1 flex items-center justify-self-end">
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
        </div>
      )}
      {waiting && (
        <GoalReplyCard
          key={replyKey}
          question={goal.waitingForUser!}
          onReply={reply}
          draft={replyDraft.key === replyKey ? replyDraft.text : ""}
          failed={replyDraft.key === replyKey && replyDraft.failed}
          onDraftChange={(text) => setReplyDraft({ key: replyKey, text, failed: false })}
          disabled={pending || busy || replyDisabled}
          sessionId={sessionId}
          cwd={cwd}
          rootId={rootId}
          rootStatus={rootStatus}
        />
      )}
    </div>
  );
}
