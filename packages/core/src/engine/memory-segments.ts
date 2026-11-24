/**
 * Memory segments — connects an Engine's runs to memory closures
 * (services/memory-closure.ts).
 *
 * A run's end no longer extracts memories by itself. It marks the end of what
 * may be a work segment: in a host with a shared runtime the closure waits for
 * the session to stay quiet, and a new run cancels that wait. A host without
 * such a timer (a one-shot run) closes straight away.
 */
import type { TokenUsage, TranscriptEvent } from "../types.js";
import type { SessionBundle } from "../session/session-manager.js";
import { isEphemeralSessionState } from "../session/session-state-shape.js";
import type { Transcript } from "../session/transcript.js";
import type { MemoryClosureScheduler, MemoryCursor } from "../services/memory-closure.js";
import type {
  AuxiliaryPipeline,
  EngineLlmClient,
  MemoryClosureInput,
} from "./auxiliary-pipeline.js";

type BilledUsage = (usage: TokenUsage) => void;

export class MemorySegments {
  constructor(
    private readonly deps: {
      pipeline: AuxiliaryPipeline;
      /** The shared runtime's quiet-period timers; absent in one-shot hosts. */
      scheduler: () => MemoryClosureScheduler | undefined;
      /**
       * Nobody types in this Engine's sessions: a sub-agent's "user" is its
       * parent agent, an automation's is a schedule. Their runs never close a
       * segment; what a sub-agent found returns to its parent as a tool result.
       */
      unattended: boolean;
      // The cursor is detached session metadata, like the title: read and
      // written against the latest persisted state, never a run's snapshot.
      readCursor: (sessionId: string) => MemoryCursor | undefined;
      writeCursor: (sessionId: string, cursor: MemoryCursor) => void;
    },
  ) {}

  /** A run ended with memory allowed: close the segment now or once it goes quiet. */
  async runEnded(args: {
    transcript: Transcript;
    sessionId: string;
    cwd: string;
    primaryClient: EngineLlmClient;
    recordBilledUsage?: BilledUsage;
  }): Promise<void> {
    if (this.deps.unattended) return;
    const close = (trigger: "run-end" | "idle") =>
      // Events are read when the closure runs: a quiet period may pass first.
      this.close(args.transcript.getEvents(), trigger, args);
    const scheduler = this.deps.scheduler();
    if (!scheduler) return close("run-end");
    scheduler.schedule(args.sessionId, () => close("idle"));
  }

  /**
   * A run began, so the session's work segment continues: the closure waiting
   * for quiet is dropped, and this run's end schedules it again. If the stretch
   * before this run already sat idle long enough (its timer was lost to a
   * restart, or never existed), it is closed now, in the background.
   */
  runStarted(args: {
    session: SessionBundle;
    runId: string;
    cwd: string;
    primaryClient: EngineLlmClient;
    recordBilledUsage?: BilledUsage;
    memoryDisabled: boolean;
  }): void {
    const scheduler = this.deps.scheduler();
    if (!scheduler) return;
    const { session, runId } = args;
    const sessionId = session.state.sessionId;
    if (args.memoryDisabled || this.deps.unattended || isEphemeralSessionState(session.state))
      return;
    scheduler.cancel(sessionId);
    const events = session.transcript.getEvents();
    let start = events.length - 1;
    while (start >= 0 && events[start]!.id !== runId) start--;
    const last = start > 0 ? events[start - 1] : undefined;
    if (!last || Date.now() - last.timestamp < scheduler.idleMs) return;
    if (session.state.memoryCursor?.eventId === last.id) return;
    const before = events.slice(0, start);
    scheduler.runNow(sessionId, () => this.close(before, "resume", { ...args, sessionId }));
  }

  private close(
    events: readonly TranscriptEvent[],
    trigger: MemoryClosureInput["trigger"],
    args: {
      sessionId: string;
      cwd: string;
      primaryClient: EngineLlmClient;
      recordBilledUsage?: BilledUsage;
    },
  ): Promise<void> {
    const { sessionId } = args;
    return this.deps.pipeline.runMemoryClosure({
      events,
      sessionId,
      cwd: args.cwd,
      primaryClient: args.primaryClient,
      recordBilledUsage: args.recordBilledUsage,
      trigger,
      readCursor: () => this.deps.readCursor(sessionId),
      writeCursor: (cursor) => this.deps.writeCursor(sessionId, cursor),
    });
  }
}
