/** Trusted publisher seam for visible events outside the Engine run wrapper. */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "../types.js";
import {
  SessionOutputJournal,
  outputJournalCutover,
  readOutputJournal,
  type OutputJournalProducer,
} from "./output-journal.js";

const visible = new Set([
  "session_started",
  "stream_request_start",
  "text_delta",
  "thinking_delta",
  "tool_use_start",
  "tool_use_args_delta",
  "tool_result",
  "room_tool_result",
  "tool_summary",
  "tombstone",
  "assistant_message",
  "turn_complete",
  "goal_set",
  "goal_updated",
  "goal_cleared",
  "goal_progress",
  "task_update",
  "agent_start",
  "agent_end",
  "background_agent_completed",
  "context_compact",
  "error",
  "steer_injected",
  "user_message",
  "assistant_text",
  "session_title",
]);
// One committed source notification can fan out through several AgentServers.
// Scope the memo to that actual source object's lifetime and Session identity;
// it is neither a transport sequence nor a durable source-id deduplication log.
const publications = new WeakMap<
  object,
  Map<string, { incarnation: string; event: StreamEvent }>
>();
/** Preliminary user echoes remain pending until their canonical run anchor is committed. */
export function needsIndependentOutput(event: unknown): event is StreamEvent {
  const value = event as StreamEvent | null;
  return (
    !!value &&
    visible.has(value.type) &&
    !value.outputCursor &&
    value.outputRecovery !== "incomplete"
  );
}

/**
 * Only a trusted, already authorized producer calls this. It never creates a
 * Session, alters runId, or turns missing historical coverage into success.
 * Keep each instance attached to its producer lifetime, not a model Run.
 */
export class SessionOutputPublisher {
  private readonly producer: OutputJournalProducer;
  private readonly bindings = new Map<string, string>();
  private readonly writers = new Map<string, SessionOutputJournal>();
  constructor(
    private readonly root: (sessionId: string) => string,
    kind: OutputJournalProducer["kind"],
  ) {
    this.producer = { kind, id: randomUUID() };
  }

  project(sessionId: string, raw: unknown, source?: object): unknown {
    const existingCursor = (raw as StreamEvent | null)?.outputCursor;
    if (!needsIndependentOutput(raw) && typeof existingCursor !== "string") return raw;
    const root = this.root(sessionId);
    let at: ReturnType<typeof outputJournalCutover>;
    try {
      at = outputJournalCutover(root, sessionId);
    } catch (cause) {
      if (
        ["ENOENT", "CODESHELL_EPHEMERAL_OUTPUT"].includes(
          (cause as NodeJS.ErrnoException).code ?? "",
        ) &&
        !this.bindings.has(sessionId)
      )
        return raw;
      throw cause;
    }
    const incarnation = at.incarnation;
    const bound = this.bindings.get(sessionId);
    if (bound !== undefined && bound !== incarnation)
      throw new Error("Output publisher Session was replaced");
    // Refuse admission rather than dropping identity evidence at capacity.
    if (!bound && this.bindings.size >= 8192) throw new Error("Output publisher binding capacity");
    const sourceKey = `${root}:${sessionId}`;
    const published = source && publications.get(source)?.get(sourceKey);
    if (published) {
      if (published.incarnation !== incarnation)
        throw new Error("Output source notification Session was replaced");
      this.bindings.set(sessionId, incarnation);
      return published.event;
    }
    if (typeof existingCursor === "string") {
      if (
        !bound &&
        readOutputJournal(root, sessionId, { after: existingCursor, through: existingCursor })
          .status !== "ok"
      )
        throw new Error("Output publisher cannot bind an unverified native cursor");
      this.bindings.set(sessionId, incarnation);
      return raw;
    }
    this.bindings.set(sessionId, incarnation);
    let writer = this.writers.get(sessionId);
    if (!writer) {
      writer = new SessionOutputJournal(root, sessionId, this.producer, at.legacy, incarnation);
      this.writers.set(sessionId, writer);
      if (this.writers.size > 16) this.writers.delete(this.writers.keys().next().value!);
    }
    const event = { ...(raw as StreamEvent), outputCursor: writer.append(raw as StreamEvent) };
    if (source) {
      let results = publications.get(source);
      if (!results) publications.set(source, (results = new Map()));
      results.set(sourceKey, { incarnation, event });
    }
    return event;
  }
}
