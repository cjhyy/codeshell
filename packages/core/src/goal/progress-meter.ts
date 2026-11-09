/**
 * Goal-level progress for one Engine run.
 *
 * TurnLoop numbers its goal markers per run (its stop-block streak resets on
 * every tool call and every new run), so a goal driven by background-work
 * wakes showed "第 1 轮" forever. The meter rewrites each top-level
 * `goal_progress` event to the goal's cumulative count — persisted base plus
 * the judged attempts seen in this run — and attaches the running time, before
 * the event is journaled or shown. At run end the caller persists `drain()`.
 *
 * A judged attempt is a `not_met` (including a background-wait park or a
 * user-wait park) or `met` marker; `approaching_limit` and `exhausted` restate
 * the current count without adding one.
 */
import type { StreamEvent } from "../types.js";
import type { GoalProgress } from "./lifecycle.js";

interface MeterEntry {
  base: GoalProgress;
  rounds: number;
  startedAtMs: number;
}

export interface GoalProgressDelta {
  goalId: string;
  rounds: number;
  activeMs: number;
}

export class GoalProgressMeter {
  private readonly entries = new Map<string, MeterEntry>();

  constructor(
    private readonly loadBase: (goalId: string) => GoalProgress | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start the clock for a goal the run drives from its first step. */
  begin(goalId: string): void {
    this.entry(goalId);
  }

  decorate(event: StreamEvent): StreamEvent {
    if (event.type !== "goal_progress" || event.agentId || !event.goalId) return event;
    const entry = this.entry(event.goalId);
    if (event.status === "not_met" || event.status === "met") entry.rounds += 1;
    const atMs = this.now();
    const rounds = entry.base.rounds + entry.rounds;
    return {
      ...event,
      round: rounds,
      progress: {
        rounds,
        activeMs: entry.base.activeMs + Math.max(0, atMs - entry.startedAtMs),
        atMs,
      },
    };
  }

  /** This run's deltas per goal; the meter is empty afterwards. */
  drain(): GoalProgressDelta[] {
    const endMs = this.now();
    const deltas = [...this.entries].map(([goalId, entry]) => ({
      goalId,
      rounds: entry.rounds,
      activeMs: Math.max(0, endMs - entry.startedAtMs),
    }));
    this.entries.clear();
    return deltas;
  }

  private entry(goalId: string): MeterEntry {
    let entry = this.entries.get(goalId);
    if (!entry) {
      entry = {
        base: this.loadBase(goalId) ?? { rounds: 0, activeMs: 0 },
        rounds: 0,
        startedAtMs: this.now(),
      };
      this.entries.set(goalId, entry);
    }
    return entry;
  }
}
