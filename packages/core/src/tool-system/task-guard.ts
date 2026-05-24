/**
 * TaskGuard — nudges the model to update stale in_progress todos.
 *
 * Background: a TodoWrite call is sticky in the model's working memory
 * only for the first few turns. After enough intervening tool_results
 * (Read/Edit/Bash) the "I have an open todo" signal gets diluted and
 * the model finishes its work without ever rewriting the snapshot —
 * so the UI's pinned panel keeps showing an item as in_progress that
 * the model considers done.
 *
 * Same shape as InvestigationGuard.turnEnded: turn-loop polls at the
 * end of each turn; if anything is in_progress and hasn't been touched
 * in N turns, we emit a <system-reminder> that lands at the top of the
 * next turn.
 *
 * Re-nag policy: don't fire more than once per (todo, threshold) pair.
 * Identity is the todo's position-based id ("1", "2", …) which we
 * carry from the TodoWrite tool output. Re-arranging the list creates
 * a new identity, which is fine — that already counts as a refresh.
 */

import type { TaskInfo } from "../types.js";

const STALE_TURN_THRESHOLD = 3;
const RENAG_INTERVAL = 3;

export class TaskGuard {
  private snapshotSource: () => TaskInfo[];
  private lastNagTurn = new Map<string, number>();
  private inProgressSince = new Map<string, number>();

  constructor(snapshotSource: () => TaskInfo[]) {
    this.snapshotSource = snapshotSource;
  }

  turnEnded(turnNumber: number): string | undefined {
    const tasks = this.snapshotSource();
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
      `  - "${task.subject}" (in_progress for ${age} turns)`,
    );

    return (
      `<system-reminder>You have ${stale.length === 1 ? "an open" : `${stale.length} open`} in_progress todo${stale.length === 1 ? "" : "s"} that ${stale.length === 1 ? "has" : "have"} not been updated recently:\n` +
      lines.join("\n") +
      `\nCall TodoWrite again with the updated snapshot — mark items completed when done or drop them if abandoned. The UI's pinned panel keeps showing in_progress until the next TodoWrite arrives, so leaving stale items there makes the user think work is still in flight.</system-reminder>`
    );
  }

  reset(): void {
    this.lastNagTurn.clear();
    this.inProgressSince.clear();
  }
}
