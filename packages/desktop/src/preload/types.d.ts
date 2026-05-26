/**
 * Type declarations for the preload bridge exposed as `window.codeshell`.
 *
 * StreamEvent is kept as `unknown` here to avoid importing Node/core types
 * into the renderer type graph. App.tsx narrows it with type guards after
 * receiving the envelope.
 *
 * ApprovalResult decision shape mirrors ApprovalResult from
 * @cjhyy/code-shell-core — kept inline to avoid renderer/Node coupling.
 */

/** Envelope delivered to onStreamEvent callbacks. */
export interface StreamEnvelope {
  sessionId: string;
  /** The raw StreamEvent from the engine. Use type guards to narrow. */
  event: unknown;
}

/** Envelope delivered to onApprovalRequest callbacks. */
export interface ApprovalEnvelope {
  sessionId: string;
  requestId: string;
  /** The raw ApprovalRequest from the engine. */
  request: unknown;
}

/** Decision payload sent back via approve(). */
export interface ApprovalDecision {
  approved: boolean;
  permanent?: boolean;
  always?: boolean;
  scope?: "once" | "session" | "project";
  reason?: string;
  /** Free-text answer for AskUserQuestion approvals. */
  answer?: string;
}

declare global {
  interface Window {
    codeshell: {
      /**
       * Start an agent run. sessionId must be a pre-allocated UUID.
       * T14 NOTE: sessionId is required — callers must supply it.
       */
      run(
        task: string,
        opts: { sessionId: string; cwd?: string; permissionMode?: string },
      ): Promise<unknown>;

      /** Cancel the running turn for the given session. */
      cancel(sessionId: string): Promise<unknown>;

      /** Respond to a tool approval request. */
      approve(
        sessionId: string,
        requestId: string,
        decision: ApprovalDecision,
      ): Promise<unknown>;

      /** Destroy the session and free its resources on the main process. */
      closeSession(sessionId: string): Promise<unknown>;

      /**
       * Register a callback to receive stream event envelopes.
       * The envelope carries { sessionId, event } so the renderer can
       * route events to the correct session's state bucket.
       */
      onStreamEvent(cb: (env: StreamEnvelope) => void): void;

      /** Unregister a stream event callback. */
      offStreamEvent(cb: (env: StreamEnvelope) => void): void;

      /**
       * Register a callback to receive approval request envelopes.
       * The envelope carries { sessionId, requestId, request }.
       */
      onApprovalRequest(cb: (env: ApprovalEnvelope) => void): void;

      /** Unregister an approval request callback. */
      offApprovalRequest(cb: (env: ApprovalEnvelope) => void): void;
    };
  }
}
export {};
