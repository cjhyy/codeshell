/**
 * Per-(repo, session) transcripts (renderer-side persistence).
 *
 * A repo holds many UI sessions. Each session is keyed by a local
 * UI sessionId (generated client-side) and stores:
 *   - title:    short label shown in sidebar (first user prompt by default)
 *   - createdAt / updatedAt
 *   - state:    MessagesReducerState
 *
 * Two localStorage keys per repo:
 *   codeshell.sessionIndex.<repoKey>          → SessionIndex (list metadata)
 *   codeshell.transcript.<repoKey>.<sessionId>→ MessagesReducerState
 *
 * `repoKey` is the repo id, or NO_REPO_KEY ("__no_repo__") when the
 * conversation runs without a project. Sessions in the no-repo bucket
 * render under the sidebar's bottom `对话` section instead of under
 * any project.
 *
 * Why split: writing the full session list on every stream delta would
 * grow O(N · runs); keeping the index thin lets the sidebar render
 * cheaply while the heavy transcript only writes for the active session.
 */

import type { MessagesReducerState } from "./types";
import { INITIAL_STATE } from "./types";

const TRANSCRIPT_MSG_CAP = 500;
/** Bucket key for sessions that have no associated repo. */
export const NO_REPO_KEY = "__no_repo__";

export interface SessionSummary {
  /** Local UI session id (NOT the engine session id; see `engineSessionId`). */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** True when the user has archived this session — hidden from the
   *  main list, accessible under a collapsed "已归档" group. */
  archived?: boolean;
  /**
   * Engine sessionId bound to this UI session. Empty until the first
   * agent/run for this UI session completes (or session_started fires).
   * On subsequent sends we MUST pass this value as `sessionId` so the
   * worker resumes the right engine session instead of letting the
   * engine auto-pick the last active one — that's the bug that made
   * '新对话' resume the previous chat's context.
   */
  engineSessionId?: string;
}

export interface SessionIndex {
  /** Sessions ordered most-recently-updated first. */
  sessions: SessionSummary[];
  activeSessionId: string | null;
}

function repoKey(repoId: string | null): string {
  return repoId ?? NO_REPO_KEY;
}
function indexKey(repoId: string | null): string {
  return `codeshell.sessionIndex.${repoKey(repoId)}`;
}
function transcriptKey(repoId: string | null, sessionId: string): string {
  return `codeshell.transcript.${repoKey(repoId)}.${sessionId}`;
}

/**
 * One-shot wipe of legacy session data. Pre-2026-05-26 the renderer
 * could (a) hand the same `s-…` id to multiple BrowserWindows and (b)
 * route stream events to the wrong bucket, so on-disk transcripts and
 * session indices from before the multi-session fix are unreliable.
 *
 * We blow them away on first boot after the migration lands and stamp
 * a schema marker so the wipe never repeats. User preferences
 * (codeshell.repos / activeRepoId / view / theme / history) are kept.
 */
const SCHEMA_KEY = "codeshell.schema";
const SCHEMA_VERSION = "2026-05-26-multi-session";
function migrateSessionStorageIfNeeded(): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(SCHEMA_KEY) === SCHEMA_VERSION) return;
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("codeshell.transcript.") || k.startsWith("codeshell.sessionIndex.")) {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
    localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
    if (stale.length > 0 && typeof console !== "undefined") {
      console.info(`[codeshell] cleared ${stale.length} legacy session entries`);
    }
  } catch {
    // localStorage may be unavailable (SSR / private mode) — best effort.
  }
}
migrateSessionStorageIfNeeded();

export function makeSessionId(): string {
  // crypto.randomUUID() is collision-proof across renderer processes;
  // a module-level counter would reset on reload and run independently
  // per BrowserWindow, so two windows opening "新对话" in the same
  // millisecond used to produce identical ids that then clobbered each
  // other's localStorage bucket.
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `s-${Date.now().toString(36)}-${rand}`;
}

export function loadSessionIndex(repoId: string | null): SessionIndex {
  try {
    const raw = localStorage.getItem(indexKey(repoId));
    if (!raw) return { sessions: [], activeSessionId: null };
    const parsed = JSON.parse(raw) as Partial<SessionIndex>;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return { sessions: [], activeSessionId: null };
    }
    return {
      sessions: parsed.sessions,
      activeSessionId: parsed.activeSessionId ?? parsed.sessions[0]?.id ?? null,
    };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

export function saveSessionIndex(repoId: string | null, idx: SessionIndex): void {
  try {
    localStorage.setItem(indexKey(repoId), JSON.stringify(idx));
  } catch {
    // best effort
  }
}

export function loadTranscript(
  repoId: string | null,
  sessionId: string,
): MessagesReducerState {
  try {
    const raw = localStorage.getItem(transcriptKey(repoId, sessionId));
    if (!raw) return INITIAL_STATE;
    const parsed = JSON.parse(raw) as Partial<MessagesReducerState>;
    if (!parsed || !Array.isArray(parsed.messages)) return INITIAL_STATE;
    return {
      messages: parsed.messages,
      streamingAssistantId: parsed.streamingAssistantId ?? null,
      streamingThinkingId: parsed.streamingThinkingId ?? null,
      sessionId: parsed.sessionId ?? null,
      promptTokens: parsed.promptTokens ?? 0,
      activeAgents: parsed.activeAgents ?? {},
    };
  } catch {
    return INITIAL_STATE;
  }
}

export function saveTranscript(
  repoId: string | null,
  sessionId: string,
  state: MessagesReducerState,
): void {
  try {
    const capped: MessagesReducerState =
      state.messages.length <= TRANSCRIPT_MSG_CAP
        ? state
        : {
            ...state,
            messages: state.messages.slice(state.messages.length - TRANSCRIPT_MSG_CAP),
          };
    localStorage.setItem(transcriptKey(repoId, sessionId), JSON.stringify(capped));
  } catch {
    // best effort
  }
}

export function clearTranscript(repoId: string | null, sessionId: string): void {
  try {
    localStorage.removeItem(transcriptKey(repoId, sessionId));
  } catch {
    // best effort
  }
}

/** Create a new session under `repoId` and make it active. */
export function createSession(
  repoId: string | null,
  title?: string,
): { index: SessionIndex; sessionId: string } {
  const idx = loadSessionIndex(repoId);
  const id = makeSessionId();
  const now = Date.now();
  const summary: SessionSummary = {
    id,
    title: title?.trim() ? title.trim() : "新对话",
    createdAt: now,
    updatedAt: now,
  };
  const next: SessionIndex = {
    sessions: [summary, ...idx.sessions],
    activeSessionId: id,
  };
  saveSessionIndex(repoId, next);
  return { index: next, sessionId: id };
}

export function deleteSessionLocal(
  repoId: string | null,
  sessionId: string,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const remaining = idx.sessions.filter((s) => s.id !== sessionId);
  const nextActive =
    idx.activeSessionId === sessionId
      ? remaining[0]?.id ?? null
      : idx.activeSessionId;
  const next: SessionIndex = { sessions: remaining, activeSessionId: nextActive };
  saveSessionIndex(repoId, next);
  clearTranscript(repoId, sessionId);
  return next;
}

/** Persist the engine sessionId on a UI session after the first run resolves. */
export function bindEngineSession(
  repoId: string | null,
  sessionId: string,
  engineSessionId: string,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) =>
      s.id === sessionId ? { ...s, engineSessionId } : s,
    ),
  };
  saveSessionIndex(repoId, next);
  return next;
}

export function archiveSession(
  repoId: string | null,
  sessionId: string,
  archived: boolean,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) =>
      s.id === sessionId ? { ...s, archived } : s,
    ),
    // If we just archived the active session, clear it (the chat surface
    // returns to draft state until the user picks another).
    activeSessionId:
      archived && idx.activeSessionId === sessionId ? null : idx.activeSessionId,
  };
  saveSessionIndex(repoId, next);
  return next;
}

export function renameSessionLocal(
  repoId: string | null,
  sessionId: string,
  title: string,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) =>
      s.id === sessionId ? { ...s, title: title.trim() || s.title, updatedAt: Date.now() } : s,
    ),
  };
  saveSessionIndex(repoId, next);
  return next;
}

export function touchSession(
  repoId: string | null,
  sessionId: string,
  firstUserText?: string,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const now = Date.now();
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const out: SessionSummary = { ...s, updatedAt: now };
      // Auto-title from first user prompt if the session is still
      // wearing the default placeholder.
      if (firstUserText && s.title === "新对话") {
        out.title = firstUserText.slice(0, 60);
      }
      return out;
    }),
  };
  saveSessionIndex(repoId, next);
  return next;
}

export function setActiveSession(
  repoId: string | null,
  sessionId: string | null,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = { ...idx, activeSessionId: sessionId };
  saveSessionIndex(repoId, next);
  return next;
}
