/** Run-local task tracking and durable Goal progress projection. */
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import type { StreamCallback, StreamEvent, TaskInfo } from "../types.js";
import { SessionOutputJournal } from "../session/output-journal.js";
import { outputUserMessage } from "./run-output-user-message.js";

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
    allowLateMetadata?: (event: StreamEvent) => boolean;
  };
}): StreamCallback {
  const { userOnStream, getSession, setLatestTodos } = args;
  let journal: SessionOutputJournal | undefined;
  let failed = false;
  return (event) => {
    event = args.prepareEvent?.(event) ?? event;
    if (args.outputJournal?.allowLateMetadata?.(event))
      return userOnStream?.({ ...event, outputCursor: undefined });
    if (event.outputCursor) event = { ...event, outputOriginCursor: event.outputCursor };
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
          });
        }
        event = { ...event, outputCursor: journal.append(event) };
      } catch (error) {
        failed = true;
        try {
          args.outputJournal.onFailure();
        } catch {
          /* The live failure fence still applies when the disk is unavailable. */
        }
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
}
