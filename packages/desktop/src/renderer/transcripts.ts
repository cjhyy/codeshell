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
  /** True once the user manually renamed this session — blocks LLM auto-title overwrite. */
  titleManual?: boolean;
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
}

function repoKey(repoId: string | null): string {
  return repoId ?? NO_REPO_KEY;
}

/** Resolve a repo id (or null) to its bucket repo-key segment. */
export function repoKeyOf(repoId: string | null): string {
  return repoId ?? NO_REPO_KEY;
}

/**
 * Canonical transcripts-map / sidebar-status bucket key:
 *   `${repoId ?? NO_REPO_KEY}::${sessionId ?? "_none_"}`
 *
 * This is the SINGLE source of truth — App.tsx (map build), Sidebar.tsx (row
 * lookup), and streamRouting.ts all use it. The output MUST stay byte-identical
 * across versions so persisted/runtime keys keep matching. The `_none_` only
 * matters for a null sessionId (draft/global edge cases) — keep it.
 */
export function bucketKey(repoId: string | null, sessionId: string | null): string {
  return `${repoKeyOf(repoId)}::${sessionId ?? "_none_"}`;
}

/** Suffix of the shared per-repo draft bucket (null sessionId). */
export const DRAFT_BUCKET_SUFFIX = "::_none_";

/** True for the shared per-repo draft slot (`<repo>::_none_`). */
export function isDraftBucket(bucket: string): boolean {
  return bucket.endsWith(DRAFT_BUCKET_SUFFIX);
}

/**
 * Per-bucket override maps (permission/goal) are keyed by bucketKey. A DRAFT has
 * a null sessionId, so every draft in a repo collapses to the SHARED
 * `<repo>::_none_` slot — which, left unmanaged, makes one draft's choice
 * "粘连" onto the next 新对话 (#11). These two helpers keep that slot honest:
 *
 *  - migrateBucketOverride: when a draft solidifies into a real session (first
 *    send), move its override onto the real bucket so the choice FOLLOWS the
 *    session, and drop the shared draft slot.
 *  - clearBucketOverride: when entering a fresh draft (新对话), drop the shared
 *    slot so a previous draft's choice doesn't carry over.
 *
 * Generic over the value type so it serves both permissionOverrides and
 * goalOverrides. Returns the SAME object reference when nothing changed, so a
 * React setState updater can no-op cleanly.
 */
export function migrateBucketOverride<V>(
  prev: Record<string, V>,
  fromBucket: string,
  toBucket: string,
): Record<string, V> {
  if (fromBucket === toBucket) return prev;
  if (!(fromBucket in prev)) return prev;
  const value = prev[fromBucket]!;
  const { [fromBucket]: _drop, ...rest } = prev;
  return { ...rest, [toBucket]: value };
}

export function clearBucketOverride<V>(
  prev: Record<string, V>,
  bucket: string,
): Record<string, V> {
  if (!(bucket in prev)) return prev;
  const { [bucket]: _drop, ...rest } = prev;
  return rest;
}
/**
 * Per-bucket override maps (permission / model / goal) keyed by bucketKey, the
 * whole map persisted under one namespaced localStorage key.
 *
 * Why persist: these maps are renderer-local React state. Left in memory only,
 * a refresh (F5) wiped them — so a session the user had set to 完全访问 silently
 * reverted to 默认权限 (and a per-session model reverted to the default) on
 * refresh, because the effective value derives as `map[bucket] ?? default`.
 * Seeding useState from localStorage on mount fixes that. Mirrors the
 * loadPanelState/savePanelState contract above (empty clears the key).
 */
function overrideMapKey(namespace: string): string {
  return `codeshell.overrides.${namespace}`;
}

/** Load a saved override map for a namespace, or {} when absent/corrupt. */
export function loadOverrideMap<V>(namespace: string): Record<string, V> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(overrideMapKey(namespace));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, V>;
  } catch {
    return {};
  }
}

/**
 * Persist an override map. An empty map clears the key to avoid clutter.
 *
 * Draft buckets (`<repo>::_none_`) are stripped before persisting: that slot is
 * shared by every new/draft chat in a repo, so persisting a draft's choice would
 * let it survive a refresh and silently bleed onto the NEXT new chat in that repo
 * (it inherits 完全访问 / the picked model). Draft overrides are transient — they
 * migrate to the real bucket on first send (migrateBucketOverride) — so they have
 * no business in localStorage.
 */
export function saveOverrideMap<V>(namespace: string, map: Record<string, V>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const persistable: Record<string, V> = {};
    for (const [bucket, value] of Object.entries(map)) {
      if (!isDraftBucket(bucket)) persistable[bucket] = value;
    }
    if (Object.keys(persistable).length === 0) {
      localStorage.removeItem(overrideMapKey(namespace));
      return;
    }
    localStorage.setItem(overrideMapKey(namespace), JSON.stringify(persistable));
  } catch {
    // localStorage may be unavailable (SSR / private mode) — best effort.
  }
}

function indexKey(repoId: string | null): string {
  return `codeshell.sessionIndex.${repoKey(repoId)}`;
}
function transcriptKey(repoId: string | null, sessionId: string): string {
  return `codeshell.transcript.${repoKey(repoId)}.${sessionId}`;
}

/**
 * Per-(repo, session) right-dock panel state (open/tabs/activeId). The dock's
 * visibility and tab set ride with the conversation: switching sessions
 * restores that session's panels. `panelWidth` stays global (not keyed here).
 *
 * Draft sessions (null sessionId) collapse to the shared `<repo>::_none_` slot
 * via bucketKey, matching how permission/goal overrides bucket drafts.
 */
export interface PanelStateSnapshot<K extends string = string> {
  open: boolean;
  tabs: { id: string; kind: K }[];
  activeId: string | null;
}

const EMPTY_PANEL_STATE: PanelStateSnapshot = { open: false, tabs: [], activeId: null };

function panelStateKey(bucket: string): string {
  return `codeshell.panelState.${bucket}`;
}

/** Load the saved panel state for a bucket, or a closed/empty default. */
export function loadPanelState<K extends string = string>(bucket: string): PanelStateSnapshot<K> {
  try {
    if (typeof localStorage === "undefined") return { ...(EMPTY_PANEL_STATE as PanelStateSnapshot<K>) };
    const raw = localStorage.getItem(panelStateKey(bucket));
    if (!raw) return { ...(EMPTY_PANEL_STATE as PanelStateSnapshot<K>) };
    const parsed = JSON.parse(raw) as Partial<PanelStateSnapshot<K>>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter(
          (t): t is { id: string; kind: K } =>
            !!t && typeof t.id === "string" && typeof (t as { kind?: unknown }).kind === "string",
        )
      : [];
    return {
      open: parsed.open === true,
      tabs,
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
    };
  } catch {
    return { ...(EMPTY_PANEL_STATE as PanelStateSnapshot<K>) };
  }
}

/** Persist a bucket's panel state. Closed + empty clears the key to avoid clutter. */
export function savePanelState<K extends string>(bucket: string, state: PanelStateSnapshot<K>): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!state.open && state.tabs.length === 0) {
      localStorage.removeItem(panelStateKey(bucket));
      return;
    }
    localStorage.setItem(panelStateKey(bucket), JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (SSR / private mode) — best effort.
  }
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
      // A persisted `null` is the legitimate "draft" state (user hit 新对话
      // and hasn't sent a message). Only fall back to the first session when
      // the field is genuinely absent (legacy data missing the key) — using
      // `??` here would resurrect a closed draft and auto-jump to sessions[0].
      activeSessionId:
        parsed.activeSessionId !== undefined
          ? parsed.activeSessionId
          : parsed.sessions[0]?.id ?? null,
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
      agentMessageIndex: parsed.agentMessageIndex ?? {},
      turnEpoch: parsed.turnEpoch ?? 0,
      // Persisted so the active-goal marker + popover survive a refresh /
      // localStorage reload (core also persists it in session state, but the
      // goal_set event isn't replayed from the transcript). Absent on legacy
      // saved transcripts → null.
      activeGoal: parsed.activeGoal ?? null,
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
            // Indices were computed against the un-capped array; clearing
            // them is correct because any agent whose AgentMessage survived
            // the cap will no longer be subject to in-flight updates after
            // restore — the session has already been persisted.
            agentMessageIndex: {},
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

/**
 * Update the runStatus of an automation session (keyed by local UI id), e.g.
 * flip a live-announced run from "running" to its terminal status once it
 * finishes. Without this the runStatus stays frozen at "running", which makes
 * the delete handler treat a long-finished run as still in flight. No-op if
 * the session isn't found.
 */
export function updateSessionRunStatus(
  repoId: string | null,
  sessionId: string,
  runStatus: string,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) =>
      s.id === sessionId ? { ...s, runStatus } : s,
    ),
  };
  saveSessionIndex(repoId, next);
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

/**
 * Insert or update an imported (automation) session summary in a repo's
 * index, keyed by engineSessionId. Returns the new index. Does NOT write
 * the transcript (caller does that via saveTranscript). Idempotent: a second
 * call with the same engineSessionId updates in place instead of duplicating.
 */
export function upsertImportedSession(
  repoId: string | null,
  summary: SessionSummary,
): SessionIndex {
  if (!summary.engineSessionId) {
    throw new Error("upsertImportedSession: summary must have engineSessionId");
  }
  const idx = loadSessionIndex(repoId);
  const without = idx.sessions.filter(
    (s) => !(summary.engineSessionId && s.engineSessionId === summary.engineSessionId),
  );
  const next: SessionIndex = {
    sessions: [summary, ...without].sort((a, b) => b.updatedAt - a.updatedAt),
    activeSessionId: idx.activeSessionId,
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
  manual = false,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            title: title.trim() || s.title,
            ...(manual ? { titleManual: true } : {}),
            updatedAt: Date.now(),
          }
        : s,
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
