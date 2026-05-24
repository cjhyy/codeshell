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
 *   codeshell.sessionIndex.<repoId>          → SessionIndex (list metadata)
 *   codeshell.transcript.<repoId>.<sessionId>→ MessagesReducerState
 *
 * Why split: writing the full session list on every stream delta would
 * grow O(N · runs); keeping the index thin lets the sidebar render
 * cheaply while the heavy transcript only writes for the active session.
 *
 * Legacy single-bucket transcripts (`codeshell.transcript.<repoId>`)
 * are migrated lazily on first read: their content becomes session
 * "legacy" under the repo, so users don't lose history.
 */

import type { MessagesReducerState } from "./types";
import { INITIAL_STATE } from "./types";

const TRANSCRIPT_MSG_CAP = 500;
const GLOBAL_REPO = "__global__";

export interface SessionSummary {
  /** Local UI session id (NOT the engine session id; see types.ts `sessionId`). */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionIndex {
  /** Sessions ordered most-recently-updated first. */
  sessions: SessionSummary[];
  activeSessionId: string | null;
}

function repoKey(repoId: string | null): string {
  return repoId ?? GLOBAL_REPO;
}
function indexKey(repoId: string | null): string {
  return `codeshell.sessionIndex.${repoKey(repoId)}`;
}
function transcriptKey(repoId: string | null, sessionId: string): string {
  return `codeshell.transcript.${repoKey(repoId)}.${sessionId}`;
}
function legacyKey(repoId: string | null): string {
  return `codeshell.transcript.${repoKey(repoId)}`;
}

let idCounter = 0;
export function makeSessionId(): string {
  idCounter += 1;
  return `s-${Date.now().toString(36)}-${idCounter}`;
}

/** Read the session index for a repo, migrating legacy single-bucket
 * data on first access so existing users keep their history. */
export function loadSessionIndex(repoId: string | null): SessionIndex {
  try {
    const raw = localStorage.getItem(indexKey(repoId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionIndex>;
      if (parsed && Array.isArray(parsed.sessions)) {
        return {
          sessions: parsed.sessions,
          activeSessionId: parsed.activeSessionId ?? parsed.sessions[0]?.id ?? null,
        };
      }
    }
  } catch {
    // fall through to migration / empty
  }
  // Migration: a legacy `codeshell.transcript.<repoId>` blob means this
  // repo has one historical conversation. Adopt it as a single session
  // titled "legacy" so users don't lose context.
  try {
    const legacy = localStorage.getItem(legacyKey(repoId));
    if (legacy) {
      const id = makeSessionId();
      const now = Date.now();
      const summary: SessionSummary = {
        id,
        title: "迁移自旧版",
        createdAt: now,
        updatedAt: now,
      };
      // Move payload to its new key.
      localStorage.setItem(transcriptKey(repoId, id), legacy);
      const idx: SessionIndex = { sessions: [summary], activeSessionId: id };
      localStorage.setItem(indexKey(repoId), JSON.stringify(idx));
      localStorage.removeItem(legacyKey(repoId));
      return idx;
    }
  } catch {
    // best effort
  }
  return { sessions: [], activeSessionId: null };
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
      if (firstUserText && (s.title === "新对话" || s.title === "迁移自旧版")) {
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
