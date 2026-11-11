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

/**
 * Whether a submission's user message is published live (the service does it
 * only for these). Only then may its run carry the message's `clientMessageId`:
 * a renderer folds a run with an id it has no user bubble for out of view.
 */
export function announcesUserMessage(input: { displayText?: string; injected?: boolean }): boolean {
  return !!input.displayText && !input.injected;
}

/**
 * A host message (Mimi, another Session) must be announced: it has no
 * renderer bubble of its own, and a long task binds by its `clientMessageId`.
 * Senders pass `displayText` and do not mark it `injected`.
 */
export function assertExternalSubmission(input: {
  trigger?: SessionRunTrigger;
  displayText?: string;
  injected?: boolean;
}): void {
  if (input.trigger === "host_message" && !announcesUserMessage(input))
    throw new Error("A host message to an external runtime needs displayText and is not injected");
}

function isChildEvent(event: StreamEvent): boolean {
  return "agentId" in event && event.agentId !== undefined;
}

/** User input keeps its own identity; a run never stamps its id onto it. */
const USER_INPUT_EVENTS: ReadonlySet<string> = new Set([
  "session_user_message",
  "steer_injected",
  "user_message",
]);

/**
 * What native ChatSession and Engine put around one top-level run, for one
 * external-runtime submission (all of its Goal rounds are one run):
 * `session_started.trigger`, the run's `runId` / `clientMessageId` on its
 * events (not on user input, which keeps its own), and `turn_complete.outcome`
 * from core's own tracker; a Goal the run paused reads `goal: "paused"`. The Mimi notice
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
        goalPaused?: boolean;
        /** Background work was already running when the run started. */
        backgroundAtOpen: boolean;
      }
    | undefined;

  /**
   * `isBookkeepingTool`: the host registry's `bookkeeping` flag (provider tools
   * are work). `awaitsBackground`: running background work will wake the Session.
   */
  constructor(
    private readonly isBookkeepingTool: (toolName: string) => boolean,
    private readonly awaitsBackground: () => boolean = () => false,
  ) {}

  /**
   * The open run started background work that will wake the Session and is
   * ending before it finishes: it parks for it (core's `background_wait`).
   * Work an earlier run started does not park this one, as in native core.
   */
  yieldsToBackground(): boolean {
    return !!this.run && !this.run.backgroundAtOpen && this.awaitsBackground();
  }

  /** A submission starts its run; a run left unclosed is dropped. */
  open(trigger: SessionRunTrigger | undefined): void {
    this.run = {
      ...(trigger ? { trigger } : {}),
      tracker: createTurnOutcomeTracker(this.isBookkeepingTool),
      backgroundAtOpen: this.awaitsBackground(),
    };
  }

  /** Stamp one event of the open run; its `turn_complete` closes the run. */
  prepare(event: StreamEvent): StreamEvent {
    const run = this.run;
    if (!run || isChildEvent(event) || USER_INPUT_EVENTS.has(event.type)) return event;
    let next = run.tracker.prepareEvent(event);
    if (next.type === "session_started") {
      run.runId = next.runId;
      run.clientMessageId = next.clientMessageId;
      if (run.trigger) next = { ...next, trigger: run.trigger };
    } else if (next.type === "goal_updated") {
      run.goalPaused = next.paused === true;
    } else if (next.type === "turn_complete") {
      this.run = undefined;
      if (run.goalPaused && next.outcome && !next.outcome.goal)
        next = { ...next, outcome: { ...next.outcome, goal: "paused" } };
      next = withOutcomeTrigger(next, run.trigger);
    }
    return {
      ...next,
      ...(run.runId ? { runId: run.runId } : {}),
      ...(run.clientMessageId ? { clientMessageId: run.clientMessageId } : {}),
    };
  }
}
