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
  activeMs: number;
  startedAtMs?: number;
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
    const entry = this.entry(goalId);
    entry.startedAtMs ??= this.now();
  }

  /** Close a run segment immediately; delayed tool/stream teardown is not work. */
  pause(goalId: string, atMs = this.now()): void {
    const entry = this.entries.get(goalId);
    if (!entry || entry.startedAtMs === undefined) return;
    entry.activeMs += Math.max(0, atMs - entry.startedAtMs);
    entry.startedAtMs = undefined;
  }

  decorate(event: StreamEvent): StreamEvent {
    if (event.type !== "goal_progress" || event.agentId || !event.goalId) return event;
    const entry = this.entry(event.goalId);
    if (event.status === "not_met" || event.status === "met") entry.rounds += 1;
    const atMs = this.now();
    if (
      event.waitingForUser !== undefined ||
      event.waiting !== undefined ||
      event.status === "met" ||
      event.status === "exhausted"
    ) {
      // Background time is owned by the lifecycle from its park boundary.
      // Keeping this segment open would count the teardown overlap twice.
      this.pause(event.goalId, Math.min(atMs, event.waiting?.sinceMs ?? atMs));
    }
    const rounds = entry.base.rounds + entry.rounds;
    return {
      ...event,
      round: rounds,
      progress: {
        rounds,
        activeMs: entry.base.activeMs + this.elapsed(entry, atMs),
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
      activeMs: this.elapsed(entry, endMs),
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
        activeMs: 0,
        startedAtMs: this.now(),
      };
      this.entries.set(goalId, entry);
    }
    return entry;
  }

  private elapsed(entry: MeterEntry, atMs: number): number {
    return (
      entry.activeMs + (entry.startedAtMs === undefined ? 0 : Math.max(0, atMs - entry.startedAtMs))
    );
  }
}
