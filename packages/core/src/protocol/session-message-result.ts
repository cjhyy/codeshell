import type { EngineResult } from "../engine/types.js";
import type { RouteSessionMessageInput } from "../session/session-message.js";
import type { ResultEnvelopeDraft } from "../tool-system/builtin/agent-notifications.js";

export interface SessionMessageOutcome {
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
}

export function sessionMessageFailure(error: unknown): SessionMessageOutcome {
  return {
    status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
    text: "",
    error: error instanceof Error ? error.message : String(error),
  };
}

/** A resolved Engine promise can still represent a refusal or failed run. */
export function sessionMessageOutcome(result: EngineResult): SessionMessageOutcome {
  if (result.reason === "aborted_streaming" || result.reason === "aborted_tools") {
    return {
      status: "cancelled",
      text: result.text,
      error: result.text || "Target turn was cancelled.",
    };
  }
  if (result.reason === "completed" && result.turnCount > 0) {
    return { status: "completed", text: result.text };
  }
  const detail =
    result.text ||
    (result.turnCount === 0 ? "Target turn did not start." : "Target turn did not complete.");
  return { status: "failed", text: result.text, error: `${detail} (reason: ${result.reason})` };
}

export function sessionMessageResultNotification(
  input: RouteSessionMessageInput,
  messageId: string,
  outcome: SessionMessageOutcome,
): ResultEnvelopeDraft {
  return {
    kind: "result",
    from: { sessionId: input.target.sessionId, authority: "agent" },
    to: { sessionId: input.sourceSessionId, authority: "system" },
    correlationId: messageId,
    delivery: "idle-drain",
    payload: {
      workId: messageId,
      name: input.target.title,
      description: `Reply to message ${messageId} from Session ${input.target.sessionId}: ${input.message.slice(0, 240)}`,
      workKind: "agent",
      status: outcome.status,
      finalText: outcome.text,
      ...(outcome.error ? { error: outcome.error } : {}),
      finishedAt: Date.now(),
    },
  };
}
