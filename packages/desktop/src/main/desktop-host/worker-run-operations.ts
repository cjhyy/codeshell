import type { OperationLedgerRequest } from "@cjhyy/code-shell-core/internal/operations";
import type { HostRunOperations, OperationCap } from "../../host/composition/run-operations.js";

/** Only the executor's own session_started stream associates a Run with its private child channel. */
export class WorkerRunOperations {
  private readonly sessions = new Map<string, { runId: string; cap: OperationCap }>();
  constructor(
    private readonly host: HostRunOperations,
    private readonly active: () => boolean,
  ) {}
  observe(raw: unknown) {
    const message = raw as {
      method?: string;
      params?: {
        sessionId?: string;
        event?: { type?: string; sessionId?: string; runId?: string };
      };
    } | null;
    if (message?.method !== "agent/streamEvent") return;
    const { sessionId, event } = message.params ?? {};
    if (
      typeof sessionId !== "string" ||
      !event ||
      !(event.type === "turn_complete" || event.type === "session_started")
    )
      return;
    const prev = this.sessions.get(sessionId);
    if (event.type === "turn_complete" && event.runId && event.runId !== prev?.runId) return;
    if (event.type === "session_started" && event.runId === prev?.runId) return;
    prev?.cap.close();
    this.sessions.delete(sessionId);
    if (
      event.type === "session_started" &&
      sessionId === event.sessionId &&
      typeof event.runId === "string" &&
      this.sessions.size < 128
    ) {
      const runId = event.runId;
      let cap: OperationCap;
      try {
        cap = this.host.open(
          sessionId,
          runId,
          () => this.active() && this.sessions.get(sessionId)?.cap === cap,
        );
      } catch {
        return;
      }
      this.sessions.set(sessionId, { runId, cap });
    }
  }
  async run(request: OperationLedgerRequest, current: () => boolean) {
    if (!current()) throw new Error("Operation executor stopped");
    const session = this.sessions.get(request?.sessionId);
    if (!session || session.runId !== request.runId) throw new Error("Operation Run unavailable");
    return session.cap.run(request);
  }
  close() {
    for (const session of this.sessions.values()) session.cap.close();
    this.sessions.clear();
  }
}
