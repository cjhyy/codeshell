/**
 * Per-(project, session) transcripts (renderer-side persistence).
 *
 * A project holds many UI sessions. Each session is keyed by a local
 * UI sessionId (generated client-side) and stores:
 *   - title:    short label shown in sidebar (first user prompt by default)
 *   - createdAt / updatedAt
 *   - state:    MessagesReducerState
 *
 * Two legacy localStorage keys per project:
 *   codeshell.sessionIndex.<projectBucketSegment>          → SessionIndex (list metadata)
 *   codeshell.transcript.<projectBucketSegment>.<sessionId>→ MessagesReducerState
 *
 * `projectBucketSegment` is the stable project id, or the legacy NO_REPO_KEY
 * ("__no_repo__") when the conversation runs without a project. No-project sessions
 * render under the sidebar's bottom `对话` section instead of under
 * any project.
 *
 * Why split: writing the full session list on every stream delta would
 * grow O(N · runs); keeping the index thin lets the sidebar render
 * cheaply while the heavy transcript only writes for the active session.
 */

import type { RendererStreamEvent } from "../preload/types";
import type { SessionIndex, SessionSummary } from "../shared/session-catalog";
import { getSessionPersistence } from "./sessionPersistence";
export type { SessionIndex, SessionSummary } from "../shared/session-catalog";
import type { MessagesReducerState } from "./types";
import { INITIAL_STATE, applyStreamEvent } from "./types";

const TRANSCRIPT_MSG_CAP = 500;
// Tool output and screenshots can make even a short conversation enormous.
// Disk holds the authoritative history; keep completed renderer caches small
// enough that they cannot crowd out the sidebar's session identities.
const TRANSCRIPT_CACHE_MAX_BYTES = 1024 * 1024;
const pendingSessionIndices = new WeakMap<
  Storage,
  Map<string, { previous: string | null; value: string }>
>();
/** Legacy byte value for the no-project conversation bucket. */
export const NO_REPO_KEY = "__no_repo__";

/** Fold persisted transcript stream events through the renderer's canonical reducer. */
export function applyTranscriptStreamEvent(
  state: MessagesReducerState,
  event: RendererStreamEvent,
  clock: () => number | undefined = Date.now,
): MessagesReducerState {
  if (event.type !== "context_transfer") return applyStreamEvent(state, event, clock);
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        kind: "context_boundary",
        id: `context-transfer:${event.sourceSessionId}:${event.fromEventId}:${event.toEventId}`,
        strategy: "summary",
        before: 0,
        after: 0,
        contextTransfer: {
          summary: event.summary,
          sourceSessionId: event.sourceSessionId,
          fromEventId: event.fromEventId,
          toEventId: event.toEventId,
          sourceEventCount: event.sourceEventCount,
          estimatedTokens: event.estimatedTokens,
        },
      },
    ],
  };
}

/**
 * Placeholder title a session wears until auto-titled from the first user
 * prompt. Used BOTH as the stored default and as the "still unnamed?" test in
 * `touchSession`, so it must be a single stable constant — never a translated
 * string, or a UI-language switch would break the equality check and leave the
 * title stuck. When the sidebar gains i18n, translate this at the render site
 * only (compare against this constant, display via `t()`). The value is kept
 * as the legacy "新对话" literal so existing stored sessions still match.
 */
export const DEFAULT_SESSION_TITLE = "新对话";

function logSessionDiagnostic(event: string, details: Record<string, unknown>): void {
  try {
    if (typeof window !== "undefined" && typeof window.codeshell?.log === "function") {
      window.codeshell.log(event, details);
    }
  } catch {
    // Diagnostics must never make local session persistence fail.
  }
}

/**
 * Enforce the renderer's active-session invariant at every persistence boundary.
 * `null` is an intentional draft. Any other value must name a live, unarchived
 * row in this exact project index; invalid legacy/dangling values fail closed to
 * draft instead of guessing another conversation.
 */
function normalizeSessionIndex(
  projectId: string | null,
  idx: SessionIndex,
  source: string,
): SessionIndex {
  const requested = idx.activeSessionId as string | null | undefined;
  if (requested === null) return idx;
  const summary =
    typeof requested === "string"
      ? idx.sessions.find((session) => session.id === requested)
      : undefined;
  if (summary && !summary.archived) return idx;

  logSessionDiagnostic("session.active_normalized", {
    repoId: projectId,
    source,
    previousActiveSessionId: requested ?? null,
    reason:
      requested === undefined
        ? "missing"
        : summary?.archived
          ? "archived"
          : typeof requested === "string"
            ? "dangling"
            : "invalid",
  });
  return { ...idx, activeSessionId: null };
}

/** Resolve a project id (or null) to its byte-compatible bucket segment. */
export function projectBucketSegment(projectId: string | null): string {
  return projectId ?? NO_REPO_KEY;
}

/** @deprecated Use projectBucketSegment; retained for renderer API compatibility. */
export const repoKeyOf = projectBucketSegment;

/**
 * Canonical transcripts-map / sidebar-status bucket key:
 *   `${projectId ?? NO_REPO_KEY}::${sessionId ?? "_none_"}`
 *
 * This is the SINGLE source of truth — App.tsx (map build), Sidebar.tsx (row
 * lookup), and streamRouting.ts all use it. The output MUST stay byte-identical
 * across versions so persisted/runtime keys keep matching. The `_none_` only
 * matters for a null sessionId (draft/global edge cases) — keep it.
 */
export function bucketKey(projectId: string | null, sessionId: string | null): string {
  return `${projectBucketSegment(projectId)}::${sessionId ?? "_none_"}`;
}

/** Suffix of the shared per-project draft bucket (null sessionId). */
export const DRAFT_BUCKET_SUFFIX = "::_none_";

/** True for the shared per-project draft slot (`<project-id>::_none_`). */
export function isDraftBucket(bucket: string): boolean {
  return bucket.endsWith(DRAFT_BUCKET_SUFFIX);
}

/**
 * Per-bucket override maps (permission/goal) are keyed by bucketKey. A DRAFT has
 * a null sessionId, so every draft in a project collapses to the SHARED
 * `<project-id>::_none_` slot — which, left unmanaged, makes one draft's choice
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

export function clearBucketOverride<V>(prev: Record<string, V>, bucket: string): Record<string, V> {
  if (!(bucket in prev)) return prev;
  const { [bucket]: _drop, ...rest } = prev;
  return rest;
}

export function migrateProjectBucketOverrides<V>(
  prev: Record<string, V>,
  projectIdRemap: Record<string, string>,
): Record<string, V> {
  const remaps = Object.entries(projectIdRemap).filter(([from, to]) => from && to && from !== to);
  if (remaps.length === 0) return prev;

  let next: Record<string, V> | null = null;
  for (const [bucket, value] of Object.entries(prev)) {
    for (const [from, to] of remaps) {
      const prefix = `${from}::`;
      if (!bucket.startsWith(prefix)) continue;
      const targetBucket = `${to}${bucket.slice(from.length)}`;
      next ??= { ...prev };
      delete next[bucket];
      if (!(targetBucket in next)) next[targetBucket] = value;
      break;
    }
  }
  return next ?? prev;
}

/** @deprecated Use migrateProjectBucketOverrides. */
export const migrateRepoBucketOverrides = migrateProjectBucketOverrides;
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

function isTransientOverrideBucket(bucket: string): boolean {
  return isDraftBucket(bucket) || bucket.startsWith("__quick_chat__::");
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
 * Draft buckets (`<project-id>::_none_`) and ephemeral quick-chat buckets are stripped
 * before persisting. A draft slot is shared by every new chat in a project; a quick
 * chat is destroyed on close/exit. Persisting either would leave a stale access,
 * model, or goal choice that can bleed into a later conversation.
 */
export function saveOverrideMap<V>(namespace: string, map: Record<string, V>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const persistable: Record<string, V> = {};
    for (const [bucket, value] of Object.entries(map)) {
      if (!isTransientOverrideBucket(bucket)) persistable[bucket] = value;
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

function indexKey(projectId: string | null): string {
  return `codeshell.sessionIndex.${projectBucketSegment(projectId)}`;
}
function transcriptKey(projectId: string | null, sessionId: string): string {
  return `codeshell.transcript.${projectBucketSegment(projectId)}.${sessionId}`;
}

/**
 * Per-(project, session) right-dock panel state (open/tabs/activeId). The dock's
 * visibility and tab set ride with the conversation: switching sessions
 * restores that session's panels. `panelWidth` stays global (not keyed here).
 *
 * Draft sessions (null sessionId) collapse to the shared `<project-id>::_none_` slot
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
    if (typeof localStorage === "undefined")
      return { ...(EMPTY_PANEL_STATE as PanelStateSnapshot<K>) };
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

/**
 * Drop a bucket's saved panel state entirely. Used when starting a fresh
 * draft so the shared per-project "_none_" slot doesn't carry a previous
 * draft's panel layout into the new conversation (mirrors how permission/
 * goal/model overrides clear the draft bucket).
 */
export function clearPanelState(bucket: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(panelStateKey(bucket));
  } catch {
    // localStorage may be unavailable (SSR / private mode) — best effort.
  }
}

/** Persist a bucket's panel state. Closed + empty clears the key to avoid clutter. */
export function savePanelState<K extends string>(
  bucket: string,
  state: PanelStateSnapshot<K>,
): void {
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
    // Main's new importer keeps a backup before acknowledging legacy data.
    // Running the obsolete wipe first would destroy older installations.
    if (getSessionPersistence()) return;
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

export function loadSessionIndex(projectId: string | null): SessionIndex {
  const persistence = getSessionPersistence();
  if (persistence) {
    return normalizeSessionIndex(
      projectId,
      persistence.getIndex(projectBucketSegment(projectId)),
      "load",
    );
  }
  try {
    const key = indexKey(projectId);
    const persisted = localStorage.getItem(key);
    const pending = pendingSessionIndices.get(localStorage)?.get(key);
    // Retain a failed write within this window so create -> touch -> bind never
    // reloads an older list. A successful write in another window wins.
    const raw = pending?.previous === persisted ? pending.value : persisted;
    if (pending && pending.previous !== persisted)
      pendingSessionIndices.get(localStorage)?.delete(key);
    if (!raw) return { sessions: [], activeSessionId: null };
    const parsed = JSON.parse(raw) as Partial<SessionIndex>;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return { sessions: [], activeSessionId: null };
    }
    const loaded = {
      sessions: parsed.sessions,
      // A persisted `null` is the legitimate draft state. Missing, dangling,
      // archived, and malformed values are normalized below; never guess
      // sessions[0], because that can silently route a send into an old chat.
      activeSessionId: parsed.activeSessionId as string | null,
      // Carry the deleted-project label through so the archived-sessions view
      // can still name a removed project. Only string values survive.
      ...(typeof parsed.deletedProjectLabel === "string"
        ? { deletedProjectLabel: parsed.deletedProjectLabel }
        : {}),
    } satisfies SessionIndex;
    const normalized = normalizeSessionIndex(projectId, loaded, "load");
    if (normalized !== loaded) {
      try {
        localStorage.setItem(indexKey(projectId), JSON.stringify(normalized));
      } catch {
        // best effort
      }
    }
    return normalized;
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

export function saveSessionIndex(projectId: string | null, idx: SessionIndex): void {
  const persistence = getSessionPersistence();
  if (persistence) {
    persistence.saveIndex(
      projectBucketSegment(projectId),
      normalizeSessionIndex(projectId, idx, "save"),
    );
    return;
  }
  try {
    const normalized = normalizeSessionIndex(projectId, idx, "save");
    const key = indexKey(projectId);
    const value = JSON.stringify(normalized);
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
      if (!reclaimTranscriptCacheForIndex(key, value)) {
        let pending = pendingSessionIndices.get(localStorage);
        if (!pending) {
          pending = new Map();
          pendingSessionIndices.set(localStorage, pending);
        }
        pending.set(key, { previous: localStorage.getItem(key), value });
        throw error;
      }
    }
    pendingSessionIndices.get(localStorage)?.delete(key);
  } catch (error) {
    logSessionDiagnostic("session.index_save_failed", {
      repoId: projectId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

const INDEX_KEY_PREFIX = "codeshell.sessionIndex.";

function isStorageQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** Only discard completed, engine-bound caches, never an unflushed user tail. */
function isRecoverableTranscriptCache(
  state: Partial<MessagesReducerState>,
  engineSessionId: string,
): boolean {
  if (
    state.sessionId !== engineSessionId ||
    state.streamingAssistantId ||
    state.streamingThinkingId ||
    Object.keys(state.activeAgents ?? {}).length > 0 ||
    !Array.isArray(state.messages)
  )
    return false;
  let completed = false;
  for (const message of state.messages) {
    if (message.kind === "user") {
      if (message.pending) return false;
      completed = false;
    } else if (
      message.kind === "assistant" ||
      message.kind === "thinking" ||
      message.kind === "agent"
    ) {
      if (!message.done) return false;
      if (
        message.kind === "agent" &&
        message.toolCalls.some((tool) => tool.status === "queued" || tool.status === "running")
      )
        return false;
      if (message.kind === "assistant") completed = true;
    } else if (message.kind === "tool") {
      if (message.status === "queued" || message.status === "running") return false;
      completed = false;
    } else if (message.kind === "ask_user" && message.answer === undefined) {
      return false;
    } else if (message.kind === "turn_end" || message.kind === "turn_usage") {
      completed = true;
    }
  }
  return completed;
}

/** Quota recovery runs only after a failed index write, not on every delta. */
function reclaimTranscriptCacheForIndex(key: string, value: string): boolean {
  const candidates: Array<{ key: string; raw: string; engineSessionId: string }> = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const candidateKey = localStorage.key(i);
    if (!candidateKey?.startsWith(INDEX_KEY_PREFIX)) continue;
    let index: SessionIndex;
    try {
      index = JSON.parse(localStorage.getItem(candidateKey) ?? "null") as SessionIndex;
      if (!Array.isArray(index?.sessions)) continue;
    } catch {
      continue;
    }
    const projectId = candidateKey.slice(INDEX_KEY_PREFIX.length);
    for (const summary of index.sessions) {
      if (!summary.engineSessionId || summary.id === index.activeSessionId) continue;
      const cacheKey = transcriptKey(projectId, summary.id);
      const raw = localStorage.getItem(cacheKey);
      if (raw) candidates.push({ key: cacheKey, raw, engineSessionId: summary.engineSessionId });
    }
  }
  // Free the fewest caches possible, and parse large JSON only on this rare path.
  candidates.sort((a, b) => b.raw.length - a.raw.length);
  let reclaimedBytes = 0;
  let removed = 0;
  for (const candidate of candidates) {
    try {
      if (!isRecoverableTranscriptCache(JSON.parse(candidate.raw), candidate.engineSessionId))
        continue;
    } catch {
      continue;
    }
    localStorage.removeItem(candidate.key);
    reclaimedBytes += (candidate.key.length + candidate.raw.length) * 2;
    removed += 1;
    try {
      localStorage.setItem(key, value);
      logSessionDiagnostic("session.index_quota_recovered", { removed, reclaimedBytes });
      return true;
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
    }
  }
  return false;
}

/**
 * Find session indices for projects that were DELETED (carry deletedProjectLabel)
 * but whose projectId is no longer in the live project set. On reload App seeds
 * `sessionIndices` only from `loadProjects()`, so a deleted project's all-archived
 * index would otherwise vanish from the 已归档 view after a restart. This scans
 * localStorage for those orphaned-but-archived indices so they survive a refresh.
 * Returns a `{ projectId: SessionIndex }` map (never includes the no-repo bucket).
 */
export function loadDeletedArchivedIndices(
  liveProjectIds: Set<string>,
): Record<string, SessionIndex> {
  const out: Record<string, SessionIndex> = {};
  const persistence = getSessionPersistence();
  if (persistence) {
    for (const [key, idx] of Object.entries(persistence.getIndices())) {
      if (
        key !== NO_REPO_KEY &&
        !liveProjectIds.has(key) &&
        idx.deletedProjectLabel &&
        idx.sessions.length
      )
        out[key] = idx;
    }
    return out;
  }
  try {
    if (typeof localStorage === "undefined") return out;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(INDEX_KEY_PREFIX)) continue;
      const projectBucketSegment = key.slice(INDEX_KEY_PREFIX.length);
      if (projectBucketSegment === NO_REPO_KEY || liveProjectIds.has(projectBucketSegment))
        continue;
      const idx = loadSessionIndex(projectBucketSegment);
      // Only surface indices we deliberately stamped at delete time — never
      // resurrect arbitrary stale buckets.
      if (idx.deletedProjectLabel && idx.sessions.length > 0) out[projectBucketSegment] = idx;
    }
  } catch {
    // best effort — a malformed localStorage shouldn't break startup.
  }
  return out;
}

export function loadTranscript(projectId: string | null, sessionId: string): MessagesReducerState {
  const persistence = getSessionPersistence();
  if (persistence)
    return parseTranscriptSnapshot(
      persistence.getTranscript(projectBucketSegment(projectId), sessionId),
    );
  try {
    return parseTranscriptSnapshot(localStorage.getItem(transcriptKey(projectId, sessionId)));
  } catch {
    return INITIAL_STATE;
  }
}

export async function loadPersistedTranscript(
  projectId: string | null,
  sessionId: string,
  maxBytes?: number,
): Promise<{ state: MessagesReducerState; hasEarlier: boolean }> {
  const persistence = getSessionPersistence();
  if (!persistence) return { state: loadTranscript(projectId, sessionId), hasEarlier: false };
  const result = await persistence.readTranscript(
    projectBucketSegment(projectId),
    sessionId,
    maxBytes,
  );
  return { state: parseTranscriptSnapshot(result.value), hasEarlier: result.hasEarlier };
}

function parseTranscriptSnapshot(raw: string | null): MessagesReducerState {
  try {
    if (!raw) return INITIAL_STATE;
    const parsed = JSON.parse(raw) as Partial<MessagesReducerState>;
    if (!parsed || !Array.isArray(parsed.messages)) return INITIAL_STATE;
    return {
      messages: parsed.messages,
      streamingAssistantId: parsed.streamingAssistantId ?? null,
      streamingThinkingId: parsed.streamingThinkingId ?? null,
      sessionId: parsed.sessionId ?? null,
      promptTokens: parsed.promptTokens ?? 0,
      singleTurnPromptTokens: parsed.singleTurnPromptTokens ?? 0,
      singleTurnCacheReadTokens: parsed.singleTurnCacheReadTokens ?? 0,
      singleTurnCacheCreationTokens: parsed.singleTurnCacheCreationTokens ?? 0,
      // Whole-session cache/prompt totals: persisted so the cumulative hit-rate
      // tooltip survives a refresh / localStorage reload. Legacy saved
      // transcripts used session* names, so fall back to those.
      cumulativePromptTokens: parsed.cumulativePromptTokens ?? parsed.sessionPromptTokens ?? 0,
      cumulativeCacheReadTokens:
        parsed.cumulativeCacheReadTokens ?? parsed.sessionCacheReadTokens ?? 0,
      cumulativeCacheCreationTokens:
        parsed.cumulativeCacheCreationTokens ?? parsed.sessionCacheCreationTokens ?? 0,
      sessionCacheReadTokens:
        parsed.cumulativeCacheReadTokens ?? parsed.sessionCacheReadTokens ?? 0,
      sessionCacheCreationTokens:
        parsed.cumulativeCacheCreationTokens ?? parsed.sessionCacheCreationTokens ?? 0,
      sessionPromptTokens: parsed.cumulativePromptTokens ?? parsed.sessionPromptTokens ?? 0,
      activeAgents: parsed.activeAgents ?? {},
      agentMessageIndex: parsed.agentMessageIndex ?? {},
      snapshotSeq: parsed.snapshotSeq ?? 0,
      ...(typeof parsed.snapshotEpoch === "string" && parsed.snapshotEpoch
        ? { snapshotEpoch: parsed.snapshotEpoch }
        : {}),
      turnEpoch: parsed.turnEpoch ?? 0,
      // Persisted so the active-goal marker + popover survive a refresh /
      // localStorage reload (core also persists it in session state, but the
      // goal_set event isn't replayed from the transcript). Absent on legacy
      // saved transcripts → null.
      activeGoal: parsed.activeGoal
        ? {
            ...parsed.activeGoal,
            // Legacy localStorage projections predate pause/resume. Treat an
            // absent flag as running so old sessions remain loadable.
            paused: parsed.activeGoal.paused ?? false,
          }
        : null,
    };
  } catch {
    return INITIAL_STATE;
  }
}

export function saveTranscript(
  projectId: string | null,
  sessionId: string,
  state: MessagesReducerState,
): void {
  const persistence = getSessionPersistence();
  if (persistence) {
    persistence.saveTranscript(projectBucketSegment(projectId), sessionId, JSON.stringify(state));
    return;
  }
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
    const serialized = JSON.stringify(capped);
    const key = transcriptKey(projectId, sessionId);
    if ((key.length + serialized.length) * 2 > TRANSCRIPT_CACHE_MAX_BYTES) {
      const summary = loadSessionIndex(projectId).sessions.find(
        (session) => session.id === sessionId,
      );
      if (
        summary?.engineSessionId &&
        isRecoverableTranscriptCache(capped, summary.engineSessionId)
      ) {
        // Replace an older, potentially unfinished snapshot with disk hydration,
        // rather than leaving a giant streaming cache permanently ineligible.
        localStorage.removeItem(key);
        return;
      }
    }
    localStorage.setItem(key, serialized);
  } catch {
    // best effort
  }
}

export function clearTranscript(projectId: string | null, sessionId: string): void {
  const persistence = getSessionPersistence();
  if (persistence) {
    persistence.saveTranscript(projectBucketSegment(projectId), sessionId, null);
    return;
  }
  try {
    localStorage.removeItem(transcriptKey(projectId, sessionId));
  } catch {
    // best effort
  }
}

/** Merge one project bucket into another, moving index rows and transcript blobs. */
export async function migrateProjectSessionBucket(
  fromProjectId: string,
  toProjectId: string,
): Promise<SessionIndex> {
  if (fromProjectId === toProjectId) return loadSessionIndex(toProjectId);
  const from = loadSessionIndex(fromProjectId);
  const to = loadSessionIndex(toProjectId);
  const existing = new Set(to.sessions.map((s) => s.engineSessionId || s.id));
  const moved = from.sessions.filter((s) => !existing.has(s.engineSessionId || s.id));
  const persistence = getSessionPersistence();
  for (const s of moved) {
    if (persistence) persistence.copyTranscript(fromProjectId, toProjectId, s.id);
    else saveTranscript(toProjectId, s.id, loadTranscript(fromProjectId, s.id));
  }
  if (persistence) {
    // Keep the source catalog authoritative until every complete snapshot has
    // been copied. A failed copy or process exit leaves the original route usable.
    await persistence.flush();
    const currentFrom = loadSessionIndex(fromProjectId);
    const currentTo = loadSessionIndex(toProjectId);
    const copiedIds = new Set(from.sessions.map((session) => session.id));
    const known = new Set(
      currentTo.sessions.map((session) => session.engineSessionId || session.id),
    );
    const copied = currentFrom.sessions.filter(
      (session) => copiedIds.has(session.id) && !known.has(session.engineSessionId || session.id),
    );
    const next: SessionIndex = {
      ...currentTo,
      sessions: [...copied, ...currentTo.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
      activeSessionId: currentTo.activeSessionId ?? currentFrom.activeSessionId,
    };
    saveSessionIndex(toProjectId, next);
    saveSessionIndex(fromProjectId, {
      ...currentFrom,
      sessions: currentFrom.sessions.filter((session) => !copiedIds.has(session.id)),
      activeSessionId: null,
    });
    await persistence.flush();
    // Source snapshots are deleted only after both directory patches commit.
    for (const session of moved) persistence.saveTranscript(fromProjectId, session.id, null);
    await persistence.flush();
    return next;
  }
  const next: SessionIndex = {
    sessions: [...moved, ...to.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    activeSessionId: to.activeSessionId ?? from.activeSessionId,
  };
  saveSessionIndex(toProjectId, next);
  try {
    localStorage.removeItem(indexKey(fromProjectId));
    for (const s of from.sessions) localStorage.removeItem(transcriptKey(fromProjectId, s.id));
  } catch {
    // best effort
  }
  return next;
}

/** @deprecated Use migrateProjectSessionBucket. */
export const migrateRepoSessionBucket = migrateProjectSessionBucket;

export interface CreateSessionOptions {
  /** Defaults to true. Background producers such as Mimi must not steal the active chat. */
  activate?: boolean;
  /** Bind the new Session to one workspace profile/digital human. */
  workspaceProfile?: string;
  /** Mark the Session as part of a summoned team (see SessionSummary.teamId). */
  teamId?: string;
  teamRole?: "lead" | "member";
  /** See SessionSummary.sessionBrief. */
  sessionBrief?: string;
}

/** Create a new session under `projectId`, active by default. */
export function createSession(
  projectId: string | null,
  title?: string,
  options: CreateSessionOptions = {},
): { index: SessionIndex; sessionId: string } {
  const idx = loadSessionIndex(projectId);
  const id = makeSessionId();
  const now = Date.now();
  const summary: SessionSummary = {
    id,
    title: title?.trim() ? title.trim() : DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    ...(options.workspaceProfile ? { workspaceProfile: options.workspaceProfile } : {}),
    ...(options.teamId ? { teamId: options.teamId } : {}),
    ...(options.teamRole ? { teamRole: options.teamRole } : {}),
    ...(options.sessionBrief ? { sessionBrief: options.sessionBrief } : {}),
  };
  const next: SessionIndex = {
    sessions: [summary, ...idx.sessions],
    activeSessionId: options.activate === false ? idx.activeSessionId : id,
  };
  saveSessionIndex(projectId, next);
  return { index: next, sessionId: id };
}

export function deleteSessionLocal(projectId: string | null, sessionId: string): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const remaining = idx.sessions.filter((s) => s.id !== sessionId);
  const next = normalizeSessionIndex(
    projectId,
    {
      sessions: remaining,
      activeSessionId: idx.activeSessionId === sessionId ? null : idx.activeSessionId,
    },
    "delete",
  );
  saveSessionIndex(projectId, next);
  clearTranscript(projectId, sessionId);
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
  projectId: string | null,
  sessionId: string,
  runStatus: string,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) => (s.id === sessionId ? { ...s, runStatus } : s)),
  };
  saveSessionIndex(projectId, next);
  return next;
}

/** Persist the engine sessionId on a UI session after the first run resolves. */
export function bindEngineSession(
  projectId: string | null,
  sessionId: string,
  engineSessionId: string,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) => (s.id === sessionId ? { ...s, engineSessionId } : s)),
  };
  saveSessionIndex(projectId, next);
  return next;
}

/**
 * Insert or update an imported (automation) session summary in a project's
 * index, keyed by engineSessionId. Returns the new index. Does NOT write
 * the transcript (caller does that via saveTranscript). Idempotent: a second
 * call with the same engineSessionId updates in place instead of duplicating.
 */
export function upsertImportedSession(
  projectId: string | null,
  summary: SessionSummary,
): SessionIndex {
  if (!summary.engineSessionId) {
    throw new Error("upsertImportedSession: summary must have engineSessionId");
  }
  const idx = loadSessionIndex(projectId);
  const previous = idx.sessions.find(
    (session) => summary.engineSessionId && session.engineSessionId === summary.engineSessionId,
  );
  const merged = previous?.pinned ? { ...summary, pinned: true } : summary;
  const without = idx.sessions.filter(
    (s) => !(summary.engineSessionId && s.engineSessionId === summary.engineSessionId),
  );
  const next: SessionIndex = {
    sessions: [merged, ...without].sort((a, b) => b.updatedAt - a.updatedAt),
    activeSessionId: idx.activeSessionId,
  };
  saveSessionIndex(projectId, next);
  return next;
}

export function archiveSession(
  projectId: string | null,
  sessionId: string,
  archived: boolean,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next = normalizeSessionIndex(
    projectId,
    {
      ...idx,
      sessions: idx.sessions.map((s) => (s.id === sessionId ? { ...s, archived } : s)),
      // If we just archived the active session, clear it (the chat surface
      // returns to draft state until the user picks another).
      activeSessionId: archived && idx.activeSessionId === sessionId ? null : idx.activeSessionId,
    },
    archived ? "archive" : "restore",
  );
  saveSessionIndex(projectId, next);
  return next;
}

/**
 * Archive EVERY session in a project's index in one write, stamping the project's
 * display label so the archived-sessions view can still name it after the
 * project is removed from `projects[]`. Used by the remove-project flow so deleting a
 * project archives its conversations (visible + restorable under 设置→高级)
 * instead of orphaning them in localStorage. Returns the updated index so the
 * caller can keep it in `sessionIndices` state (the project row is gone from
 * the sidebar regardless, since the sidebar iterates `projects`).
 */
export function archiveAllSessions(projectId: string | null, projectLabel: string): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) => (s.archived ? s : { ...s, archived: true })),
    activeSessionId: null,
    deletedProjectLabel: projectLabel,
  };
  saveSessionIndex(projectId, next);
  return next;
}

export function renameSessionLocal(
  projectId: string | null,
  sessionId: string,
  title: string,
  manual = false,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
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
  saveSessionIndex(projectId, next);
  return next;
}

/** Pin or unpin a Session without changing its last-activity timestamp. */
export function setSessionPinnedLocal(
  projectId: string | null,
  sessionId: string,
  pinned: boolean,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      if (pinned) return { ...session, pinned: true };
      const { pinned: _previous, ...unpinned } = session;
      return unpinned;
    }),
  };
  saveSessionIndex(projectId, next);
  return next;
}

/** Switch the digital human used by future turns without replacing Session history. */
/**
 * Drop a digital-human binding from every Session in the given projects.
 *
 * Deleting a profile unbinds engine state, but a Session that never ran has no
 * engine state — its binding lives only in this index. Left behind, opening that
 * Session sends `workspaceProfile` for a profile that no longer exists and the
 * run dies with "Workspace profile ... is unavailable".
 *
 * Returns the project ids actually rewritten, so callers can report honestly.
 */
export function unbindWorkspaceProfileEverywhere(
  workspaceProfile: string,
  projectIds: readonly (string | null)[],
): (string | null)[] {
  const touched: (string | null)[] = [];
  for (const projectId of projectIds) {
    const index = loadSessionIndex(projectId);
    let changed = false;
    const sessions = index.sessions.map((session) => {
      if (session.workspaceProfile !== workspaceProfile) return session;
      changed = true;
      const { workspaceProfile: _dropped, ...rest } = session;
      return { ...rest, updatedAt: Date.now() };
    });
    if (!changed) continue;
    saveSessionIndex(projectId, { ...index, sessions });
    touched.push(projectId);
  }
  return touched;
}

export function setSessionWorkspaceProfileLocal(
  projectId: string | null,
  sessionId: string,
  workspaceProfile: string | undefined,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      if (workspaceProfile) return { ...session, workspaceProfile, updatedAt: Date.now() };
      const { workspaceProfile: _previous, ...unbound } = session;
      return { ...unbound, updatedAt: Date.now() };
    }),
  };
  saveSessionIndex(projectId, next);
  return next;
}

export function touchSession(
  projectId: string | null,
  sessionId: string,
  firstUserText?: string,
): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const now = Date.now();
  const next: SessionIndex = {
    ...idx,
    sessions: idx.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const out: SessionSummary = { ...s, updatedAt: now };
      // Auto-title from first user prompt if the session is still
      // wearing the default placeholder.
      if (firstUserText && s.title === DEFAULT_SESSION_TITLE) {
        out.title = firstUserText.slice(0, 60);
      }
      return out;
    }),
  };
  saveSessionIndex(projectId, next);
  return next;
}

export function setActiveSession(projectId: string | null, sessionId: string | null): SessionIndex {
  const idx = loadSessionIndex(projectId);
  const next = normalizeSessionIndex(
    projectId,
    { ...idx, activeSessionId: sessionId },
    "set_active",
  );
  saveSessionIndex(projectId, next);
  return next;
}
