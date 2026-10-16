/** Run-local task tracking and durable Goal progress projection. */
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import { randomUUID } from "node:crypto";
import type { StreamCallback, StreamEvent, TaskInfo } from "../types.js";
import { outputJournalCutover, SessionOutputJournal } from "../session/output-journal.js";
import { outputCoverageIncarnation } from "../session/output-coverage-state.js";
import { outputUserMessage } from "./run-output-user-message.js";
import { stampStreamEvent } from "../session/stream-timing.js";

export function createRunOutputJournalPolicy(
  manager: SessionManager,
  getSession: () => SessionBundle,
  getRunId: () => string,
) {
  return {
    root: manager.getStorageDir(),
    getRunId,
    onFailure: () => {
      const session = getSession();
      session.state.outputRecoveryIncomplete = true;
      manager.updateSessionState(
        session.state.sessionId,
        { outputRecoveryIncomplete: true },
        getRunId(),
      );
    },
    onIndependentFailure: (incarnation: string) => {
      const session = getSession();
      const { sessionId, startedAt } = session.state;
      // A child can outlive its spawning run. Fence the same Session's current
      // run, but never a replacement directory or a copied/restored Session.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = manager.readSessionState(sessionId);
        if (
          !current?.runId ||
          current.startedAt !== startedAt ||
          outputCoverageIncarnation(manager.getStorageDir(), sessionId, startedAt) !== incarnation
        )
          return;
        try {
          manager.updateSessionRunState(sessionId, current.runId, (latest) => {
            if (
              latest.startedAt !== startedAt ||
              outputCoverageIncarnation(manager.getStorageDir(), sessionId, startedAt) !==
                incarnation
            )
              throw new Error("Output Session was replaced");
            return { outputRecoveryIncomplete: true };
          });
          session.state.outputRecoveryIncomplete = true;
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    },
    // Title generation can settle after a later run. Its persisted, exact
    // Session metadata remains authoritative; it cannot append turn output
    // under a superseded owner or claim a cursor in that newer run.
    allowLateMetadata: (event: StreamEvent) => {
      if (event.type !== "session_title") return false;
      const current = manager.readSessionState(getSession().state.sessionId);
      return current?.runId !== getRunId() && current?.title === event.title;
    },
  };
}

export function buildWrappedOnStream(args: {
  userOnStream: StreamCallback | undefined;
  getSession: () => SessionBundle;
  setLatestTodos: (todos: TaskInfo[]) => void;
  prepareEvent?: (event: StreamEvent) => StreamEvent;
  outputJournal?: {
    root: string;
    getRunId: () => string;
    onFailure: () => void;
    onIndependentFailure?: (incarnation: string) => void;
    allowLateMetadata?: (event: StreamEvent) => boolean;
  };
}): StreamCallback & { finish(): void } {
  const { userOnStream, getSession, setLatestTodos } = args;
  let journal: SessionOutputJournal | undefined;
  let childJournal: SessionOutputJournal | undefined;
  let childIncarnation: string | undefined;
  let failed = false;
  let streamingClosed = false;
  let pending: StreamEvent[] = [],
    pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = (independent = false) => {
    failed = true;
    try {
      if (independent && args.outputJournal?.onIndependentFailure) {
        if (childIncarnation) args.outputJournal.onIndependentFailure(childIncarnation);
      } else args.outputJournal?.onFailure();
    } catch {
      /* Retain the live barrier when its durable marker also fails. */
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    pendingBytes = 0;
    if (!events.length) return;
    let cursors: string[];
    try {
      cursors = journal!.appendBatch(events);
    } catch (cause) {
      failure();
      throw cause;
    }
    for (let index = 0; index < events.length; index++)
      userOnStream?.({ ...events[index], outputCursor: cursors[index] });
  };
  const onStream: StreamCallback = (event) => {
    event = stampStreamEvent(args.prepareEvent?.(event) ?? event);
    if (!("agentId" in event && event.agentId) && args.outputJournal?.allowLateMetadata?.(event))
      return userOnStream?.({ ...event, outputCursor: undefined });
    if (event.outputCursor)
      event = { ...event, outputOriginCursor: event.outputCursor, outputCursor: undefined };
    if ("agentId" in event && event.agentId) {
      if (args.outputJournal && getSession().transcript.isPersistent()) {
        if (failed) throw new Error("Session output recovery is incomplete");
        // Child details and lifecycle belong to the Session, not to the run
        // that spawned them. They also must not update the parent's Todos or
        // Goal transcript. Flush earlier parent text before independent output.
        flush();
        try {
          if (!childJournal) {
            const { sessionId, startedAt } = getSession().state;
            childIncarnation = outputCoverageIncarnation(
              args.outputJournal.root,
              sessionId,
              startedAt,
            );
            const at = outputJournalCutover(args.outputJournal.root, sessionId);
            childJournal = new SessionOutputJournal(
              args.outputJournal.root,
              sessionId,
              { kind: "host", id: randomUUID() },
              at.legacy,
              childIncarnation,
            );
          }
          event = { ...event, outputCursor: childJournal.append(event) };
        } catch (error) {
          failure(true);
          throw error;
        }
      }
      userOnStream?.(event);
      return;
    }
    if (args.outputJournal && getSession().transcript.isPersistent()) {
      if (failed) {
        // The failure result must remain visible even if storage itself cannot
        // record it. Never publish an ordinary/completed event after this fence.
        if (
          event.type === "error" ||
          (event.type === "turn_complete" && event.reason !== "completed")
        ) {
          return userOnStream?.({
            ...event,
            outputRecovery: "incomplete",
            outputCursor: undefined,
          });
        }
        throw new Error("Session output recovery is incomplete");
      }
      // A late caller is a lifecycle error, not evidence of damaged storage.
      if (streamingClosed && (event.type === "text_delta" || event.type === "thinking_delta"))
        throw new Error("Run output stream is closed");
      try {
        if (!journal) {
          const session = getSession();
          const runId = args.outputJournal.getRunId();
          const events = session.transcript.getEvents();
          const index = events.findIndex((item) => item.id === runId);
          if (index < 0) throw new Error("Run output has no durable user-message anchor");
          journal = new SessionOutputJournal(
            args.outputJournal.root,
            session.state.sessionId,
            runId,
            index > 0 ? events[index - 1].id : undefined,
          );
          session.state.outputJournalIdentity = journal.identityPin;
          // Hosts already publish the submitted bubble. The journal owns one
          // synthetic copy for replay after the frozen legacy transcript base.
          journal.append({
            ...outputUserMessage(events[index].data, session.state.sessionId, session.state.cwd),
            runId,
            timestamp: events[index].timestamp,
          });
        }
      } catch (error) {
        failure();
        throw error;
      }
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (pending.length && (pending.length >= 64 || pendingBytes + bytes > 256 * 1024)) flush();
        pending.push({ ...event });
        pendingBytes += bytes;
        if (pendingBytes >= 256 * 1024) flush();
        else if (!timer) {
          timer = setTimeout(() => {
            try {
              flush();
            } catch {
              // flush fences storage failures itself; a consumer throw must
              // not mark already durable output as damaged.
            }
          }, 8);
          timer.unref?.();
        }
        return;
      }
      flush();
      try {
        event = { ...event, outputCursor: journal!.append(event) };
      } catch (error) {
        failure();
        throw error;
      }
    }
    if (event.type === "task_update") {
      setLatestTodos(event.tasks);
    }
    // Persist goal progress so replay/history shows how many rounds the
    // goal ran. Display-only — toMessages() ignores this type, so it never
    // re-enters the LLM context.
    if (event.type === "goal_progress") {
      getSession().transcript.append("goal_progress", {
        ...(event.goalId ? { goalId: event.goalId } : {}),
        status: event.status,
        round: event.round,
        ...(event.gaps ? { gaps: event.gaps } : {}),
      });
    }
    userOnStream?.(event);
  };
  return Object.assign(onStream, {
    finish() {
      streamingClosed = true;
      try {
        flush();
      } catch {
        // Storage failures are already fenced by flush; UI failures do not
        // invalidate the committed journal.
      }
    },
  });
}
