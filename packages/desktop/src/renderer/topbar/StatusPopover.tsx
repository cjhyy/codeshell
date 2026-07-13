import React from "react";
import type { LiveActivity } from "./liveActivity";
import type { ActiveGoal, TaskListMessage } from "../types";
import { useT } from "../i18n/I18nProvider";

interface Props {
  /** Kept for prop compatibility with TopBar; the popover no longer renders a
   *  live-activity summary (that moved inline into the message stream — see
   *  messages/LiveActivityLine). */
  activity?: LiveActivity;
  busy: boolean;
  tasks: TaskListMessage | null;
  /** The session's active persistent goal (CC /goal), or null. */
  activeGoal?: ActiveGoal | null;
  /** Legacy clear callback retained for callers not yet on goalDelete. */
  onClearGoal?: () => void;
  onUpdateGoal?: (objective: string) => void;
  onGoalPausedChange?: (paused: boolean) => void;
  onDeleteGoal?: () => void;
}

/**
 * Status popover anchored under the TopBar's status dot. Shows ONLY the
 * current task list (the in-flight plan emitted via TodoWrite/task_update).
 *
 * The old "current tool / step count / elapsed" summary was removed: that
 * live "what's happening right now" signal now renders inline at the bottom
 * of the message stream (LiveActivityLine), Codex-style, instead of hiding in
 * a hover popover. When there are no tasks the popover is a small
 * idle/running placeholder.
 */
export function StatusPopover({
  busy,
  tasks,
  activeGoal,
  onClearGoal,
  onUpdateGoal,
  onGoalPausedChange,
  onDeleteGoal,
}: Props) {
  const { t } = useT();
  const markerColor = (s: string) =>
    s === "completed"
      ? "text-status-ok"
      : s === "in_progress"
        ? "text-status-running"
        : "text-muted-foreground";

  const hasTasks = !!tasks && tasks.tasks.length > 0;

  // With an active goal OR a task list, render the wide panel: Goal block on
  // top (when present), then the task overview. With neither, fall back to the
  // minimal idle/running placeholder.
  if (activeGoal || hasTasks) {
    return (
      <div className="w-[300px] rounded-md border bg-popover p-2.5 text-sm text-popover-foreground shadow-lg">
        {activeGoal && (
          <GoalBlock
            goal={activeGoal}
            onUpdate={onUpdateGoal}
            onPausedChange={onGoalPausedChange}
            onDelete={onDeleteGoal ?? onClearGoal}
          />
        )}
        {hasTasks && <TaskBlock tasks={tasks!} markerColor={markerColor} />}
      </div>
    );
  }

  // No goal, no task list — a minimal placeholder. Live activity is shown
  // inline in the stream, so there's nothing tool-by-tool to surface here.
  return (
    <div className="w-[140px] rounded-md border bg-popover p-2.5 text-center text-sm text-muted-foreground shadow-lg">
      {busy ? t("misc.status.running") : t("misc.status.idle")}
    </div>
  );
}

function GoalBlock({
  goal,
  onUpdate,
  onPausedChange,
  onDelete,
}: {
  goal: ActiveGoal;
  onUpdate?: (objective: string) => void;
  onPausedChange?: (paused: boolean) => void;
  onDelete?: () => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(goal.objective);

  React.useEffect(() => {
    if (!editing) setDraft(goal.objective);
  }, [editing, goal.objective]);

  const cancelEdit = (): void => {
    setDraft(goal.objective);
    setEditing(false);
  };
  const saveEdit = (): void => {
    const objective = draft.trim();
    if (!objective) return;
    if (objective !== goal.objective) onUpdate?.(objective);
    setEditing(false);
  };

  return (
    <div className="mb-2 border-b border-border pb-2">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-xs uppercase tracking-wide ${goal.paused ? "text-muted-foreground" : "text-status-running"}`}
          >
            ◎ {t("misc.status.goal")}
          </span>
          {goal.paused && (
            <span className="rounded bg-accent px-1 py-0.5 text-[10px] text-muted-foreground">
              {t("misc.status.paused")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {goal.round > 0 && (
            <span className="font-mono text-xs text-muted-foreground">
              {t("misc.status.round", { round: goal.round })}
            </span>
          )}
        </div>
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea
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
            className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("misc.status.cancel")}
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={!draft.trim()}
              className="rounded bg-accent px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("misc.status.save")}
            </button>
          </div>
        </div>
      ) : (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground">
          {goal.objective}
        </p>
      )}
      {!editing && (onUpdate || onPausedChange || onDelete) && (
        <div className="mt-2 flex items-center gap-1">
          {onUpdate && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("misc.status.editGoal")}
            >
              {t("misc.status.edit")}
            </button>
          )}
          {onPausedChange && (
            <button
              type="button"
              onClick={() => onPausedChange(!goal.paused)}
              className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title={goal.paused ? t("misc.status.resumeGoal") : t("misc.status.pauseGoal")}
            >
              {goal.paused ? t("misc.status.resume") : t("misc.status.pause")}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto rounded px-1.5 py-1 text-xs text-destructive hover:bg-destructive/10"
              title={t("misc.status.deleteGoal")}
            >
              {t("misc.status.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TaskBlock({
  tasks,
  markerColor,
}: {
  tasks: TaskListMessage;
  markerColor: (s: string) => string;
}) {
  const { t } = useT();
  const done = tasks.tasks.filter((task) => task.status === "completed").length;
  const total = tasks.tasks.length;
  return (
    <>
      <div className="mb-1.5 flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("misc.status.tasks")}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {done}/{total}
        </span>
      </div>
      <ol className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
        {tasks.tasks.map((task, i) => (
          <li
            key={task.id}
            className="grid grid-cols-[auto_auto_1fr] items-baseline gap-1.5 text-xs"
          >
            <span className="min-w-[1.6em] text-right font-mono text-muted-foreground">
              {i + 1}.
            </span>
            <span className={"w-4 text-center font-mono " + markerColor(task.status)}>
              {markerFor(task.status)}
            </span>
            <span
              className={
                "truncate " +
                (task.status === "completed" ? "text-muted-foreground line-through" : "")
              }
            >
              {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function markerFor(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    default:
      return "○";
  }
}
