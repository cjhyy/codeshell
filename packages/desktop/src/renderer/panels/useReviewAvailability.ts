import { useEffect, useRef, useState } from "react";
import type { ReviewGitStatusResult } from "../../shared/review";

export interface ReviewAvailabilityState {
  status: "loading" | "available" | "unavailable" | "error";
  available: boolean;
}

const LOADING: ReviewAvailabilityState = { status: "loading", available: false };
const UNAVAILABLE: ReviewAvailabilityState = { status: "unavailable", available: false };
const ERROR: ReviewAvailabilityState = { status: "error", available: false };
const AVAILABLE: ReviewAvailabilityState = { status: "available", available: true };

interface PendingRead {
  sessionId: string;
  promise: Promise<ReviewAvailabilityState>;
}

// Share only unfinished reads. Results must be refreshed after Git changes, and
// a workspace identity change must never join a read of the previous roots.
const pendingReads = new Map<string, PendingRead>();

function availabilityFromStatus(result: ReviewGitStatusResult): ReviewAvailabilityState {
  if (result.repositories.length > 0 || result.errors.some((error) => !!error.repoRoot)) {
    return AVAILABLE;
  }
  return result.errors.length > 0 ? ERROR : UNAVAILABLE;
}

export async function readReviewAvailability(
  sessionId: string,
  workspaceKey?: string,
): Promise<ReviewAvailabilityState> {
  if (!sessionId) return UNAVAILABLE;
  const key = JSON.stringify([sessionId, workspaceKey ?? null]);
  const existing = pendingReads.get(key);
  if (existing) return existing.promise;

  const promise = Promise.resolve()
    .then(() => window.codeshell.getReviewStatus(sessionId))
    .then(availabilityFromStatus)
    .catch(() => ERROR)
    .finally(() => {
      if (pendingReads.get(key)?.promise === promise) pendingReads.delete(key);
    });
  pendingReads.set(key, { sessionId, promise });
  return promise;
}

function invalidatePendingReads(sessionId: string): void {
  for (const [key, pending] of pendingReads) {
    if (pending.sessionId === sessionId) pendingReads.delete(key);
  }
}

/** Repository presence across the Session's mounted roots, independent of
 * branch names and dirty entries. Historical turn snapshots use separate rules. */
export function useReviewAvailability(
  sessionId: string | null,
  workspaceKey: string | null,
  active = true,
): ReviewAvailabilityState {
  const targetKey =
    sessionId && workspaceKey !== null ? JSON.stringify([sessionId, workspaceKey]) : null;
  const targetRef = useRef(targetKey);
  const targetRevisionRef = useRef(0);
  const activeRef = useRef(active);
  const requestId = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    targetKey: string;
    targetRevision: number;
    state: ReviewAvailabilityState;
  } | null>(null);

  // Invalidate during render: a stale callback can run before passive effect
  // cleanup, and even one render must not expose another workspace's result.
  if (targetRef.current !== targetKey || activeRef.current !== active) {
    if (targetRef.current !== targetKey) targetRevisionRef.current += 1;
    targetRef.current = targetKey;
    activeRef.current = active;
    requestId.current += 1;
  }
  const targetRevision = targetRevisionRef.current;

  useEffect(() => {
    if (!active || !sessionId || workspaceKey === null || targetKey === null) return;
    let disposed = false;
    let refreshQueued = false;
    const isCurrent = () => !disposed && activeRef.current && targetRef.current === targetKey;
    const refresh = async () => {
      if (!isCurrent()) return;
      const id = ++requestId.current;
      const state = await readReviewAvailability(sessionId, workspaceKey);
      if (isCurrent() && requestId.current === id) {
        setSnapshot({ targetKey, targetRevision, state });
      }
    };
    const refreshAfterChange = () => {
      if (!isCurrent()) return;
      invalidatePendingReads(sessionId);
      requestId.current += 1;
      if (refreshQueued) return;
      refreshQueued = true;
      // All consumers invalidate first, then join one fresh read. Starting a
      // read in each event listener would let later listeners invalidate it.
      queueMicrotask(() => {
        refreshQueued = false;
        void refresh();
      });
    };

    void refresh();
    const offWorkspace = window.codeshell.onWorkspaceChanged?.((event) => {
      if (event.sessionId === sessionId) refreshAfterChange();
    });
    const offStream = window.codeshell.onStreamEvent?.(({ sessionId: ownerId, event }) => {
      if (ownerId !== sessionId || ("agentId" in event && event.agentId !== undefined)) return;
      if (
        event.type === "turn_complete" ||
        event.type === "error" ||
        (event.type === "session_started" && event.sessionId === sessionId)
      ) {
        refreshAfterChange();
      }
    });
    window.addEventListener("focus", refreshAfterChange);
    // Branch changes may affect any secondary mounted root. The opaque
    // workspace key is an identity, not a path to use for filtering events.
    window.addEventListener("codeshell:git-branches-changed", refreshAfterChange);
    return () => {
      disposed = true;
      requestId.current += 1;
      offWorkspace?.();
      offStream?.();
      window.removeEventListener("focus", refreshAfterChange);
      window.removeEventListener("codeshell:git-branches-changed", refreshAfterChange);
    };
  }, [active, sessionId, targetKey, targetRevision, workspaceKey]);

  if (targetKey === null) return UNAVAILABLE;
  return snapshot?.targetKey === targetKey && snapshot.targetRevision === targetRevision
    ? snapshot.state
    : LOADING;
}
