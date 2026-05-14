/**
 * TaskGuard — nudges the model to update stale in_progress tasks.
 *
 * Background: TaskCreate is sticky in the model's working memory only for the
 * first few turns. After enough intervening tool_results (Read/Edit/Bash) the
 * "I have an open task" signal gets diluted and the model finishes its work
 * without ever calling TaskUpdate(status="completed") — so the UI spinner runs
 * forever on a task that the model considers done.
 *
 * Same shape as InvestigationGuard.turnEnded: turn-loop polls at the end of
 * each turn; if anything is in_progress and hasn't been touched in N turns,
 * we emit a <system-reminder> that lands at the top of the next turn.
 *
 * Re-nag policy: don't fire more than once per (task, threshold) pair. A task
 * stale at turn 5 fires once; if the model still ignores it, we wait for it
 * to cross the next threshold (8, 11, …) before firing again. This keeps the
 * reminder from drowning out everything else when the model is genuinely
 * stuck on something unrelated.
 */

import type { Task } from "./builtin/task.js";

const STALE_TURN_THRESHOLD = 3;
const RENAG_INTERVAL = 3;

export class TaskGuard {
  private taskListSource: () => Task[];
  /** Last turn we nagged about a given task id. */
  private lastNagTurn = new Map<string, number>();
  /** Turn the task was first observed in_progress (model-time, not wall-clock). */
  private inProgressSince = new Map<string, number>();

  constructor(taskListSource: () => Task[]) {
    this.taskListSource = taskListSource;
  }

  turnEnded(turnNumber: number): string | undefined {
    const tasks = this.taskListSource();
    const open = tasks.filter((t) => t.status === "in_progress");

    const trackedIds = [...this.inProgressSince.keys()];
    for (const id of trackedIds) {
      const stillOpen = open.some((t) => t.id === id);
      if (!stillOpen) {
        this.inProgressSince.delete(id);
        this.lastNagTurn.delete(id);
      }
    }
    for (const t of open) {
      if (!this.inProgressSince.has(t.id)) {
        this.inProgressSince.set(t.id, turnNumber);
      }
    }

    const stale = open
      .map((t) => ({ task: t, age: turnNumber - (this.inProgressSince.get(t.id) ?? turnNumber) }))
      .filter(({ task, age }) => {
        if (age < STALE_TURN_THRESHOLD) return false;
        const last = this.lastNagTurn.get(task.id);
        if (last === undefined) return true;
        return turnNumber - last >= RENAG_INTERVAL;
      });

    if (stale.length === 0) return undefined;

    for (const { task } of stale) {
      this.lastNagTurn.set(task.id, turnNumber);
    }

    const lines = stale.map(({ task, age }) =>
      `  - #${task.id} "${task.subject}" (in_progress for ${age} turns)`,
    );
    const action = stale.length === 1
      ? `If task #${stale[0]!.task.id} is done, call TaskUpdate(taskId="${stale[0]!.task.id}", status="completed"); if abandoned, call TaskStop.`
      : `For each: if done, call TaskUpdate(status="completed"); if abandoned, call TaskStop.`;

    return (
      `<system-reminder>You have ${stale.length === 1 ? "an open" : `${stale.length} open`} in_progress task${stale.length === 1 ? "" : "s"} that ${stale.length === 1 ? "has" : "have"} not been updated recently:\n` +
      lines.join("\n") +
      `\n${action} The UI spinner runs until status changes — leaving tasks open makes the user think work is still in flight.</system-reminder>`
    );
  }

  reset(): void {
    this.lastNagTurn.clear();
    this.inProgressSince.clear();
  }
}
