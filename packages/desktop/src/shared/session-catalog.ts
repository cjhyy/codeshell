/** Lightweight sidebar metadata shared by Main and renderer. Chat history stays in Session files. */

export interface SessionSummary {
  /** Local UI session id (NOT the engine session id; see `engineSessionId`). */
  id: string;
  title: string;
  /** True once the user manually renamed this session — blocks LLM auto-title overwrite. */
  titleManual?: boolean;
  createdAt: number;
  updatedAt: number;
  /** True when the user has archived this session — hidden from the
   *  main list, accessible under a collapsed "已归档" group. */
  archived?: boolean;
  /** Pinned sessions stay at the front of their project's sidebar list. */
  pinned?: boolean;
  /**
   * Engine sessionId bound to this UI session. Empty until the first
   * agent/run for this UI session completes (or session_started fires).
   * On subsequent sends we MUST pass this value as `sessionId` so the
   * worker resumes the right engine session instead of letting the
   * engine auto-pick the last active one — that's the bug that made
   * '新对话' resume the previous chat's context.
   */
  engineSessionId?: string;
  /**
   * Team this Session was summoned as part of, and its role in it. Set once at
   * creation; lets the sidebar show which Sessions belong together instead of
   * leaving the user to infer it from titles.
   */
  teamId?: string;
  teamRole?: "lead" | "member";
  /**
   * Standing brief injected as system context on every run of this Session.
   * Persisted here (not just in engine state) because a planned Session has no
   * engine state until its first run.
   */
  sessionBrief?: string;
  /** Current, switchable digital-human identity for this project Session. */
  workspaceProfile?: string;
  /** "automation" when imported from a cron run; absent for manual chats. */
  source?: "automation";
  /** RunStore run id, when source === "automation" — used for unified delete. */
  runId?: string;
  /** Run status at import time (e.g. "running" | "completed"). Lets the
   *  backfill dedup re-import a still-running import once it completes. */
  runStatus?: string;
  /** Cron job id that owns this automation run, when known (live-announced
   *  sessions). Lets delete cancel a still-running run via
   *  cancelAutomationRun(cronJobId) before removing the on-disk session dir. */
  cronJobId?: string;
}

export interface SessionIndex {
  /** Sessions ordered most-recently-updated first. */
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /**
   * Project label captured at delete time. Set ONLY when the owning project was
   * removed from the sidebar — the project is gone from the live project list,
   * so the archived-sessions view can no longer resolve its name. We stash the
   * label here so those archived sessions still show "原项目名" instead of
   * "未知项目". Absent for live projects (their name comes from `projects`).
   */
  deletedProjectLabel?: string;
}

export interface SessionCatalogSnapshot {
  revision: number;
  indices: Record<string, SessionIndex>;
}

export interface SessionCatalogPatch {
  projectKey: string;
  upserts?: Array<{
    id: string;
    values: Partial<SessionSummary>;
    removeFields?: Array<keyof SessionSummary>;
  }>;
  deletedSessionIds?: string[];
  /** Omitted preserves the current selection; null explicitly selects a draft. */
  activeSessionId?: string | null;
  /** null removes the remembered project label. */
  deletedProjectLabel?: string | null;
}

export interface SessionTranscriptCacheKey {
  projectKey: string;
  sessionId: string;
}

export interface SessionTranscriptCacheRead {
  value: string | null;
  hasEarlier: boolean;
}

export interface SessionCatalogApi {
  load(): Promise<SessionCatalogSnapshot>;
  importLegacy(indices: Record<string, SessionIndex>): Promise<SessionCatalogSnapshot>;
  apply(patch: SessionCatalogPatch): Promise<SessionCatalogSnapshot>;
  onChanged(listener: (snapshot: SessionCatalogSnapshot) => void): () => void;
  /** Let Main wait for queued renderer edits before normal application quit. */
  onFlushRequested?(listener: () => Promise<void>): () => void;
  writeTranscript(
    input: SessionTranscriptCacheKey & { value: string; legacy?: boolean },
  ): Promise<void>;
  readTranscript(
    input: SessionTranscriptCacheKey & { maxBytes?: number },
  ): Promise<SessionTranscriptCacheRead>;
  deleteTranscript(input: SessionTranscriptCacheKey): Promise<void>;
}
