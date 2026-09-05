/** A host-authorized project Session that may receive a model-sent message. */
export interface SessionMessageTarget {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  workspaceProfile?: string;
}

export interface RouteSessionMessageInput {
  sourceSessionId: string;
  target: SessionMessageTarget;
  message: string;
  /** Sender tool cancellation; never serialized or supplied by the model. */
  signal?: AbortSignal;
  /** Full same-project catalog so the target can send a later message onward. */
  catalog: readonly SessionMessageTarget[];
}

/** One dispatch acknowledgement, not a subscription to future target turns. */
export interface SessionMessageReceipt {
  messageId: string;
  status: "queued" | "started" | "completed";
  /** Present when the target finished before the dispatch returned. */
  result?: { text: string; reason: import("../types.js").TerminalReason };
}

export type SessionMessageRouter = (
  input: RouteSessionMessageInput,
) => Promise<SessionMessageReceipt | void>;

export interface SessionMessageToolService {
  targets: readonly SessionMessageTarget[];
  send(input: {
    targetSessionId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<SessionMessageTarget & { receipt?: SessionMessageReceipt }>;
}
