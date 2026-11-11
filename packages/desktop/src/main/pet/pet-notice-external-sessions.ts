import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { persistedExternalRuntimeModelKey } from "../mobile-remote/external-runtime-commands.js";

export type ExternalNoticeRuntimeKind = "codex" | "claude-code";

/**
 * A work Session this desktop runs on an external runtime (Codex / Claude Code
 * through `ExternalRuntimeService`). Not the same thing as
 * `DesktopPetSession.external`, which is a standalone CLI rollout the pet only
 * tails: the worker projection never lists either of them.
 */
export interface ExternalNoticeSession {
  sessionId: string;
  runtime: ExternalNoticeRuntimeKind;
  title?: string;
  /** A provider turn (or Goal run) is in flight. */
  running: boolean;
  /**
   * More work waits behind the current turn (a queued send or background
   * wake). The rule watcher's "busy": a closing turn with queued work leaves
   * its done to the follow-up turn. A running turn alone is not busy, or no
   * turn could ever report done.
   */
  busy: boolean;
  /** A runtime is live in this desktop; false: known from its persisted state only. */
  live: boolean;
}

/**
 * What the notice pipeline knows about desktop external-runtime Sessions.
 *
 * Known (eligible for notice rules, the bell and decision prompts) means a
 * top-level work Session that either has a live runtime here, or whose
 * persisted state says it runs on an external runtime and is not archived.
 * The persisted half is deliberate: a rule outlives its runtime (a window
 * reload stops it, a fault replaces it, the app restarts), Mimi may arm a rule
 * before her message starts the runtime, and the owner can open an idle
 * Session whose runtime only starts on the next send. Events only ever come
 * from a live runtime, so a known-but-idle Session simply reports nothing.
 */
export interface ExternalNoticeSessionCatalog {
  get(sessionId: string): ExternalNoticeSession | undefined;
  has(sessionId: string): boolean;
}

/** `ExternalRuntimeService.noticeProbe`: only live runtimes answer. */
export interface ExternalRuntimeNoticeProbe {
  noticeProbe(
    sessionId: string,
  ): { kind: ExternalNoticeRuntimeKind; running: boolean; queuedTurns: number } | undefined;
}

/** The fields of a Session's persisted state (core `SessionState`) read here. */
export interface PersistedExternalSessionState {
  kind?: string;
  provider?: string;
  model?: string;
  title?: string;
  summary?: string;
  parentSessionId?: string | null;
  archivedAt?: number;
}

export function createExternalSessionCatalog(deps: {
  /** The service, once main started it (`externalRuntime.service`). */
  runtime: () => ExternalRuntimeNoticeProbe | null | undefined;
  /** The Session store's state (`SessionManager.readSessionState`). */
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
    const title = text(persisted?.title) ?? text(persisted?.summary);
    if (live)
      return {
        sessionId,
        runtime: live.kind,
        ...(title ? { title } : {}),
        running: live.running,
        busy: live.queuedTurns > 0,
        live: true,
      };
    const runtime = persistedRuntime(persisted);
    if (!runtime) return undefined;
    return {
      sessionId,
      runtime,
      ...(title ? { title } : {}),
      running: false,
      busy: false,
      live: false,
    };
  };
  return { get, has: (sessionId) => get(sessionId) !== undefined };
}

function persistedRuntime(
  state: PersistedExternalSessionState | undefined,
): ExternalNoticeRuntimeKind | undefined {
  if (!state || (state.kind !== undefined && state.kind !== "work")) return undefined;
  if (state.parentSessionId || state.archivedAt !== undefined) return undefined;
  return parseExternalRuntimeModelKey(persistedExternalRuntimeModelKey(state))?.kind;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
