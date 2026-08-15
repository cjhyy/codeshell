import type { RegisteredTool, StreamEvent } from "../types.js";
import type { ToolContext } from "./context.js";
import type { PendingApprovalMetadata } from "../protocol/types.js";

export interface ExtensionTool {
  definition: RegisteredTool;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
}

export type ExtensionQueryHandler = (
  params: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

/** Read-only live-session state exposed to protocol observers. */
export interface ProtocolLiveSession {
  sessionId: string;
  busy: boolean;
  queueDepth: number;
  lastActivityAt: number;
  kind: string;
}

/**
 * Domain-agnostic protocol lifecycle observer. An extension module can attach
 * one per AgentServer to project protocol activity (runs, stream events,
 * approvals, session/server teardown) into its own state — without the server
 * carrying any domain-specific logic. Observer callbacks must be cheap and
 * must never throw (the server isolates exceptions per observer regardless).
 */
export interface ProtocolObserver {
  /** A session was created/attached by agent/run (before the turn is queued). */
  onSessionAttached?: (sessionId: string, lastActivityAt: number) => void;
  /** Every StreamEvent forwarded to the client for a session's run. */
  onSessionStream?: (sessionId: string, event: StreamEvent) => void;
  /** Run lifecycle boundary: turn accepted (start), finished (end) or threw (error). */
  onRunBoundary?: (sessionId: string, phase: "start" | "end" | "error") => void;
  /**
   * A pending approval was registered. May return replacement metadata (e.g.
   * to override `surfaceable`); returning nothing keeps the input metadata.
   */
  onApprovalCreated?: (metadata: PendingApprovalMetadata) => PendingApprovalMetadata | void;
  /** A pending approval left the pending state (resolved/expired/cancelled/owner-lost). */
  onApprovalTransition?: (metadata: PendingApprovalMetadata, status: string) => void;
  /** A session was explicitly closed (agent/closeSession). */
  onSessionClosed?: (sessionId: string) => void;
  /** The server is shutting down. */
  onServerClose?: () => void;
  /** Resolver-free pending-decision projections for host/debug snapshots. */
  snapshotPendingDecisions?: () => readonly unknown[];
}

/** Capabilities the AgentServer lends to a protocol observer. */
export interface ProtocolObserverHost {
  /** Snapshot of live chat sessions (empty in legacy single-engine mode). */
  getLiveSessionSnapshot: () => readonly ProtocolLiveSession[];
  /** Host lifecycle generation attached to projection snapshots/deltas. */
  projectionGeneration: () => number;
  /** Persisted session kind, when the session is live and its engine knows it. */
  getSessionKind: (sessionId: string) => string | undefined;
  /** True once the server's transport owner disconnected. */
  isTransportDisconnected: () => boolean;
  /** Server → client notification. */
  notify: (method: string, params: Record<string, unknown>) => void;
  /** Register a protocol-method/query alias handled by this extension. */
  registerQuery: (type: string, handler: ExtensionQueryHandler) => void;
}
