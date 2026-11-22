import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  persistedGoalAttention,
  type ExternalGoalAttention,
  type GoalAttentionState,
} from "../external-runtime-goal-attention.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { NOTICE_DEDUPE_RETENTION_MS } from "./pet-notice-ledger.js";
import { errorText } from "./pet-notice-types.js";
import { SessionOutcomeDeriver, type SessionOutcome } from "./session-outcome.js";

/**
 * Goal pauses and open questions of desktop external-runtime Sessions, read
 * back from persisted state.
 *
 * Their notices are raised from the live pause / wait event. An app that
 * quits between that event and the notice, or an event that fires before the
 * notice pipeline is wired, leaves the owner untold while the Session's state
 * still says the Goal is stopped. So on startup, and whenever a Session is
 * opened again, the state is read and what it says is reported once more,
 * through the same interpreter (`SessionOutcomeDeriver`), rule watcher and
 * router as the live event:
 *
 * - a Goal a limit paused, or one waiting for the user's answer to a recorded
 *   question, is reported with the dedupe key its live outcome has (the run
 *   that paused or asked is persisted with the Goal). The ledger remembers
 *   that key whether the notice was sent, still waits, or was withdrawn, so
 *   there is at most one notice per pause, across any number of restarts;
 * - a Goal that is no longer stopped (resumed, completed, cleared, or paused
 *   by the user) raises nothing, and a notice about it that still waits for a
 *   channel or the digest is withdrawn, as a live Goal clear withdraws it.
 *
 * Rules, priority, quiet hours and channels are the pipeline's: nothing here
 * sends anything itself.
 */

/**
 * A stop older than this is left alone. The ledger remembers dedupe keys for
 * its retention window, counted from the notice (never earlier than the
 * stop): inside this age a key that was recorded is still known.
 */
export const GOAL_NOTICE_MAX_AGE_MS = NOTICE_DEDUPE_RETENTION_MS - 24 * 60 * 60_000;

const STAT_CONCURRENCY = 16;

type BlockedOutcome = Extract<SessionOutcome, { kind: "blocked" }>;

/** Where the persisted Goal state of desktop external-runtime Sessions is read. */
export interface ExternalGoalNoticeSource {
  /** Sessions whose persisted state was written at or after `sinceMs`. */
  recentSessions(sinceMs: number): Promise<readonly string[]>;
  /** The Session store's state (`SessionManager.readSessionState`). */
  readState?(sessionId: string): GoalAttentionState | undefined;
  /** The worker returns only eligible persisted external work and the attention it needs. */
  inspect?(sessionId: string): Promise<{ attention?: ExternalGoalAttention } | null>;
  /** A run of the Session is in flight: its own events report what it does. */
  isRunning(sessionId: string): boolean;
}

export interface GoalNoticeReconcilerDeps {
  source: ExternalGoalNoticeSource;
  isMimiSession?(sessionId: string): boolean;
  /** A top-level work Session on a desktop external runtime (the notice catalog's `has`). */
  isExternalSession(sessionId: string): boolean;
  /** The ledger already holds this outcome's notice (sent, waiting, dropped or withdrawn). */
  isReported(outcome: BlockedOutcome): boolean | Promise<boolean>;
  /** Report like a live outcome (`PetSessionRuleWatcher.reportBlocked`). */
  report(outcome: BlockedOutcome): Promise<void>;
  /** Sessions with a goal-pause notice that still waits (`PetNoticeRouter.goalPauseSessions`). */
  waitingSessions(): readonly string[] | Promise<readonly string[]>;
  /** Withdraw a Session's waiting goal-pause notices (`PetNoticeRouter.revokeSessionBlocked`). */
  withdraw(sessionId: string): Promise<void>;
  now(): number;
  log(event: string, data: Record<string, unknown>): void;
}

export interface GoalNoticeReconciler {
  /** Every recently written Session, and every Session with a waiting goal-pause notice. */
  all(): Promise<void>;
  /** One Session (it was opened again). */
  session(sessionId: string): Promise<void>;
}

/**
 * The outcome the Goal's live events produced when it stopped, rebuilt from
 * the events themselves so the one interpreter states it (question text,
 * options, run identity) exactly as it did then.
 */
export function persistedBlockedOutcome(
  sessionId: string,
  attention: Extract<ExternalGoalAttention, { kind: "limit" | "question" }>,
): BlockedOutcome | undefined {
  const deriver = new SessionOutcomeDeriver({ now: () => attention.atMs });
  const run = attention.runId ? { runId: attention.runId } : {};
  const events: Array<Record<string, unknown>> =
    attention.kind === "question"
      ? [
          {
            type: "goal_progress",
            status: "not_met",
            goalId: attention.goalId,
            revision: attention.revision,
            waitingForUser: attention.question.text,
            waitingForUserDetail: {
              level: attention.question.level,
              ...(attention.question.questions ? { questions: attention.question.questions } : {}),
            },
            timestamp: attention.atMs,
            ...run,
          },
        ]
      : [
          {
            type: "goal_progress",
            status: "not_met",
            ...(attention.limit ? { pauseReason: attention.limit } : {}),
            timestamp: attention.atMs,
            ...run,
          },
          {
            type: "turn_complete",
            reason: "completed",
            completionKind: "limit_stop",
            completedAt: attention.atMs,
            ...run,
          },
        ];
  const blocked = events
    .flatMap((event) => deriver.derive(sessionId, event))
    .find((outcome): outcome is BlockedOutcome => outcome.kind === "blocked");
  // Read back, not live: no reply is forwarded for it, and it closes no turn in flight.
  return blocked ? { ...blocked, final: true, inRun: false } : undefined;
}

export function createGoalNoticeReconciler(deps: GoalNoticeReconcilerDeps): GoalNoticeReconciler {
  const check = async (sessionId: string): Promise<void> => {
    try {
      if (deps.source.isRunning(sessionId) || deps.isMimiSession?.(sessionId)) return;
      let attention: ExternalGoalAttention | undefined;
      if (deps.source.inspect) {
        const current = await deps.source.inspect(sessionId);
        if (!current || deps.source.isRunning(sessionId) || deps.isMimiSession?.(sessionId)) return;
        attention = current.attention;
      } else {
        if (!deps.isExternalSession(sessionId)) return;
        const state = deps.source.readState?.(sessionId);
        if (!state) return;
        attention = persistedGoalAttention(state);
      }
      if (!attention) {
        // Resumed, completed, cleared or paused by the user since: nothing to say any more.
        if ((await deps.waitingSessions()).includes(sessionId)) await deps.withdraw(sessionId);
        return;
      }
      // A wait whose question was never recorded: still open, nothing to state.
      if (attention.kind === "waiting") return;
      if (deps.now() - attention.atMs > GOAL_NOTICE_MAX_AGE_MS) return;
      const outcome = persistedBlockedOutcome(sessionId, attention);
      // Asked first so a known pause adds no record; the router's own
      // dedupe still settles two reports that race.
      if (outcome && !(await deps.isReported(outcome))) await deps.report(outcome);
    } catch (error) {
      deps.log("pet.notice.goal_reconcile_failed", { sessionId, error: errorText(error) });
    }
  };
  return {
    session: check,
    async all() {
      let recent: readonly string[] = [];
      try {
        recent = await deps.source.recentSessions(deps.now() - GOAL_NOTICE_MAX_AGE_MS);
      } catch (error) {
        deps.log("pet.notice.goal_reconcile_failed", { error: errorText(error) });
      }
      // Yield between Sessions so foreground storage requests can be served during reconciliation.
      for (const sessionId of new Set([...recent, ...(await deps.waitingSessions())]))
        await check(sessionId);
    },
  };
}

export function hostedExternalGoalNoticeSource(input: {
  call: CallShellBusiness;
  isLive(sessionId: string): boolean;
  isRunning(sessionId: string): boolean;
}): ExternalGoalNoticeSource {
  return {
    recentSessions: (sinceMs) => input.call("goals/recent", { sinceMs }),
    isRunning: input.isRunning,
    async inspect(sessionId) {
      const state = await input.call("goals/attention", { sessionId });
      return state.topLevel && (state.external || input.isLive(sessionId))
        ? { attention: state.attention }
        : null;
    },
  };
}

/** The Session store on disk as an {@link ExternalGoalNoticeSource}. */
export function externalGoalNoticeSource(input: {
  sessionsRootDir: string;
  readState: ExternalGoalNoticeSource["readState"];
  isRunning: ExternalGoalNoticeSource["isRunning"];
}): ExternalGoalNoticeSource {
  return {
    recentSessions: (sinceMs) => recentSessionIds(input.sessionsRootDir, sinceMs),
    readState: input.readState,
    isRunning: input.isRunning,
  };
}

/**
 * Session directories under `sessionsRootDir` whose `state.json` was written
 * at or after `sinceMs`. Only names and mtimes are read; the caller reads the
 * few states that qualify.
 */
export async function recentSessionIds(
  sessionsRootDir: string,
  sinceMs: number,
): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(sessionsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const recent = await mapWithConcurrency(names, STAT_CONCURRENCY, async (name) => {
    try {
      const info = await stat(join(sessionsRootDir, name, "state.json"));
      return info.isFile() && info.mtimeMs >= sinceMs ? name : undefined;
    } catch {
      return undefined;
    }
  });
  return recent.filter((name): name is string => name !== undefined);
}
