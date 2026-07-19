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
  /** Full same-project catalog so the target can send a later message onward. */
  catalog: readonly SessionMessageTarget[];
}

export type SessionMessageRouter = (input: RouteSessionMessageInput) => Promise<void>;

export interface SessionMessageToolService {
  targets: readonly SessionMessageTarget[];
  send(input: { targetSessionId: string; message: string }): Promise<SessionMessageTarget>;
}
