import { isExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { persistedExternalRuntimeModelKey } from "../mobile-remote/external-runtime-commands.js";

/**
 * A work Session this desktop runs on an external runtime (Codex / Claude Code
 * through `ExternalRuntimeService`). Not the same thing as
 * `DesktopPetSession.external`, which is a standalone CLI rollout the pet only
 * tails: the worker projection never lists either of them.
 */
export interface ExternalNoticeSession {
  sessionId: string;
  title?: string;
  /**
   * User or host sends were queued behind the last turn when its turn_complete
   * was published. The rule watcher's "busy": a closing turn with queued work
   * leaves its done to the follow-up turn. Sampled at the terminal, because
   * the watcher reads it later, after the next queued turn may have started;
   * and a running turn alone is not busy, or no turn could ever report done.
   * Background wakes do not count (as native queue depth): one may resolve
   * to an empty slot and never report the carried work.
   */
  busy: boolean;
}

/**
 * What the notice pipeline knows about desktop external-runtime Sessions.
 *
 * Known (eligible for notice rules, the bell and decision prompts) means a
 * Session that either has a live runtime here, or whose persisted state says
 * it runs on an external runtime. Either way, persisted state that marks it
 * as not a top-level work Session (pet / other kind, sub-agent, child,
 * ephemeral) or as archived excludes it, as the pet's disclosure catalog does.
 * The persisted half is deliberate: a rule outlives its runtime (a window
 * reload stops it, a fault replaces it, the app restarts), Mimi may arm a rule
 * before her message starts the runtime, and the owner can open an idle
 * Session whose runtime only starts on the next send. Events only ever come
 * from a live runtime, so a known-but-idle Session simply reports nothing.
 */
export interface ExternalNoticeSessionCatalog {
  get(sessionId: string): ExternalNoticeSession | undefined;
  has(sessionId: string): boolean;
  /**
   * A runtime of this Session is live in this desktop: every external Session
   * event comes from one. Cheap (no persisted state is read), for per-event
   * checks; says nothing about eligibility (`has`).
   */
  isLive(sessionId: string): boolean;
}

/** `ExternalRuntimeService.noticeProbe`: only live runtimes answer. */
export interface ExternalRuntimeNoticeProbe {
  noticeProbe(sessionId: string): { queuedAtTerminal: number } | undefined;
}

/** The fields of a Session's persisted state (core `SessionState`) read here. */
export interface PersistedExternalSessionState {
  kind?: string;
  origin?: string;
  ephemeral?: boolean;
  provider?: string;
  model?: string;
  title?: string;
  summary?: string;
  parentSessionId?: string | null;
  archivedAt?: unknown;
}

export function createExternalSessionCatalog(deps: {
  /** The service, once main started it (`externalRuntime.service`). */
  runtime: () => ExternalRuntimeNoticeProbe | null | undefined;
  /** The Session store's state (`SessionManager.readSessionState`, one shared instance). */
  readState: (sessionId: string) => PersistedExternalSessionState | undefined;
}): ExternalNoticeSessionCatalog {
  const probe = (sessionId: string) => {
    try {
      return deps.runtime()?.noticeProbe(sessionId);
    } catch {
      return undefined;
    }
  };
  const state = (sessionId: string) => {
    try {
      return deps.readState(sessionId);
    } catch {
      return undefined;
    }
  };
  const get = (sessionId: string): ExternalNoticeSession | undefined => {
    const live = probe(sessionId);
    const persisted = state(sessionId);
    if (persisted && !isTopLevelWork(persisted)) return undefined;
    const title = text(persisted?.title) ?? text(persisted?.summary);
    if (!live && !persistedOnExternalRuntime(persisted)) return undefined;
    return {
      sessionId,
      ...(title ? { title } : {}),
      busy: live !== undefined && live.queuedAtTerminal > 0,
    };
  };
  return {
    get,
    has: (sessionId) => get(sessionId) !== undefined,
    isLive: (sessionId) => probe(sessionId) !== undefined,
  };
}

/** Not Mimi's, a sub-agent's, a child, ephemeral or archived (pet `readWorkSessionOnDisk`). */
function isTopLevelWork(state: PersistedExternalSessionState): boolean {
  return (
    (state.kind === undefined || state.kind === "work") &&
    state.origin !== "subagent" &&
    !state.parentSessionId &&
    state.ephemeral !== true &&
    typeof state.archivedAt !== "number"
  );
}

function persistedOnExternalRuntime(state: PersistedExternalSessionState | undefined): boolean {
  return state !== undefined && isExternalRuntimeModelKey(persistedExternalRuntimeModelKey(state));
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
