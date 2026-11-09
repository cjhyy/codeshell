/**
 * state.json file mechanics for SessionManager's CAS writer.
 *
 * Owns the per-session state lock (proper-lockfile lease plus recovery of the
 * old regular-file orphan lock), the bounded synchronous retry schedule shared
 * by every CAS loop, the tmp+rename atomic write, carrying journal-owned
 * recovery invariants across a whole-state write, and rebasing a live state
 * object onto the persisted snapshot. Revision/generation/kind decisions stay
 * in SessionManager.saveStateAttempt.
 */

import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { nanoid } from "nanoid";
import type { SessionState } from "../types.js";
import { preserveOutputCoverage } from "./output-coverage-state.js";
import { isLockHeldInProcess, lockSync } from "../utils/lockfile.js";

const SESSION_STATE_LOCK_STALE_MS = 10_000;
/** Lock retry delays; CAS loops also make `length + 1` attempts. */
export const SESSION_STATE_LOCK_RETRY_DELAYS_MS = [5, 10, 20, 40] as const;
const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

export type StateSaveAttempt =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "generation_conflict"
        | "lock_conflict"
        | "revision_conflict"
        | "kind_conflict"
        | "goal_schema_conflict";
    };

function sleepSync(ms: number): void {
  Atomics.wait(syncSleepCell, 0, 0, ms);
}

export function writeStateAtomically(target: string, state: SessionState, label = "state"): void {
  const tmp = `${target}.${process.pid}.${nanoid(8)}.${label}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, target);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Preserve the original write/rename error; cleanup is best effort.
    }
  }
}

export function acquireStateLock(target: string): (() => void) | undefined {
  // A reentrant/asynchronous holder in this process cannot release while we
  // synchronously wait, including when recording an output failure barrier.
  if (isLockHeldInProcess(target, { realpath: false })) return undefined;
  const lockPath = `${target}.lock`;
  for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
    if (!prepareLegacyStateLock(lockPath)) {
      const delay = SESSION_STATE_LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return undefined;
      sleepSync(delay);
      continue;
    }
    try {
      return lockSync(target, {
        stale: SESSION_STATE_LOCK_STALE_MS,
        update: SESSION_STATE_LOCK_STALE_MS / 2,
        retries: 0,
        realpath: false,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED" && code !== "EEXIST") throw err;
      const delay = SESSION_STATE_LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return undefined;
      sleepSync(delay);
    }
  }
  return undefined;
}

/** Recover only the old implementation's regular-file orphan lock. */
function prepareLegacyStateLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return true;
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return true;
  }
  if (stat.isDirectory()) return true;
  if (Date.now() - stat.mtimeMs <= SESSION_STATE_LOCK_STALE_MS) return false;
  try {
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * These recovery invariants can be committed by the run's journal writer
 * under the same state lock while an older Session bundle remains live, so a
 * whole-state write must carry the persisted values rather than its own.
 */
export function preservePersistedRecoveryFields(
  state: SessionState,
  persisted: SessionState | undefined,
): void {
  if (persisted?.outputJournalIdentity)
    state.outputJournalIdentity = persisted.outputJournalIdentity;
  if (persisted?.outputJournalHead)
    state.outputJournalHead = structuredClone(persisted.outputJournalHead);
  else delete state.outputJournalHead;
  if (persisted?.outputJournalStorage)
    state.outputJournalStorage = structuredClone(persisted.outputJournalStorage);
  else delete state.outputJournalStorage;
  if (persisted?.outputJournalBinding)
    state.outputJournalBinding = structuredClone(persisted.outputJournalBinding);
  else delete state.outputJournalBinding;
  if (persisted?.outputIdentityRecovery)
    state.outputIdentityRecovery = structuredClone(persisted.outputIdentityRecovery);
  else delete state.outputIdentityRecovery;
  if (persisted?.outputHistoryRecovery)
    state.outputHistoryRecovery = structuredClone(persisted.outputHistoryRecovery);
  else delete state.outputHistoryRecovery;
  if (persisted?.outputRecoveryIncomplete) state.outputRecoveryIncomplete = true;
  preserveOutputCoverage(state, persisted ?? {});
}

export function rebaseLiveState(live: SessionState, persisted: SessionState): void {
  for (const key of Object.keys(live) as Array<keyof SessionState>) {
    if (!(key in persisted)) delete live[key];
  }
  Object.assign(live, persisted);
}
