import type { StreamEvent } from "@cjhyy/code-shell-core";
import { createTurnOutcomeTracker, withOutcomeTrigger } from "@cjhyy/code-shell-core/internal";

/** Core's `SessionRunTrigger`: why a run started. */
export type SessionRunTrigger = NonNullable<
  Extract<StreamEvent, { type: "session_started" }>["trigger"]
>;

/** Why one external submission runs (native core stamps the same on `session_started`). */
export function externalRunTrigger(
  input: { trigger?: SessionRunTrigger; injected?: boolean },
  backgroundWake: boolean,
): SessionRunTrigger | undefined {
  if (backgroundWake) return "background_wake";
  // An injected continuation (a Goal resume) has no trigger, as in native core.
  return input.trigger ?? (input.injected ? undefined : "user");
}

function isChildEvent(event: StreamEvent): boolean {
  return "agentId" in event && event.agentId !== undefined;
}

/**
 * What native ChatSession and Engine put around one top-level run, for one
 * external-runtime submission (all of its Goal rounds are one run):
 * `session_started.trigger`, the run's `runId` / `clientMessageId` on every
 * event, and `turn_complete.outcome` from core's own tracker. The Mimi notice
 * pipeline (pet/session-outcome.ts) and the long-task coordinator then read
 * an external run exactly like a native one instead of inferring it.
 *
 * The recorder stamps each event before journaling it, so a live
 * notification and its journal frame stay identical (Main deduplicates late
 * notifications against the journal by content).
 */
export class ExternalRunEnvelope {
  private run:
    | {
        trigger?: SessionRunTrigger;
        tracker: ReturnType<typeof createTurnOutcomeTracker>;
        runId?: string;
        clientMessageId?: string;
      }
    | undefined;

  /**
   * `isBookkeepingTool`: the host registry's `bookkeeping` flag (provider tools
   * are work). `awaitsBackground`: the Session's running background work will
   * wake it, so a run ending now yielded to it (core's `background_wait`).
   */
  constructor(
    private readonly isBookkeepingTool: (toolName: string) => boolean,
    private readonly awaitsBackground: () => boolean = () => false,
  ) {}

  /** A submission starts its run; a run left unclosed is dropped. */
  open(trigger: SessionRunTrigger | undefined): void {
    this.run = {
      ...(trigger ? { trigger } : {}),
      tracker: createTurnOutcomeTracker(this.isBookkeepingTool),
    };
  }

  /** Stamp one event of the open run; its `turn_complete` closes the run. */
  prepare(event: StreamEvent): StreamEvent {
    const run = this.run;
    if (!run || isChildEvent(event)) return event;
    let next = run.tracker.prepareEvent(event);
    if (next.type === "session_started") {
      run.runId = next.runId;
      run.clientMessageId = next.clientMessageId;
      if (run.trigger) next = { ...next, trigger: run.trigger };
    } else if (next.type === "turn_complete") {
      this.run = undefined;
      if (next.outcome && !next.outcome.backgroundPending && this.awaitsBackground())
        next = { ...next, outcome: { ...next.outcome, backgroundPending: true } };
      next = withOutcomeTrigger(next, run.trigger);
    }
    return {
      ...next,
      ...(run.runId ? { runId: run.runId } : {}),
      ...(run.clientMessageId ? { clientMessageId: run.clientMessageId } : {}),
    };
  }
}
