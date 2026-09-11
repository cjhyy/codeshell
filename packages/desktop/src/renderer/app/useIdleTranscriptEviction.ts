import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject } from "react";
import { bucketKey, NO_REPO_KEY, saveTranscript, type SessionIndex } from "../transcripts";
import { getSessionPersistence } from "../sessionPersistence";
import type { TranscriptsAction, TranscriptsMap } from "../transcriptsReducer";
import type { MessagesReducerState } from "../types";
import type { QueuedInputState } from "../queuedInput";
import type { SessionStatus } from "../sessionStatus";
import { hasTranscriptRecovery } from "../transcriptHydration";

export const RETAINED_IDLE_TRANSCRIPT_BUCKETS = 10;

/** Keep pending interaction state in memory until its owner has resolved it. */
export function useProtectedTranscriptBuckets(
  busyKeys: ReadonlySet<string>,
  queuedInputs: QueuedInputState,
  sessionStatuses: Record<string, SessionStatus>,
): ReadonlySet<string> {
  return useMemo(() => {
    const protectedBuckets = new Set(busyKeys);
    for (const [bucket, items] of Object.entries(queuedInputs)) {
      if (items.length > 0) protectedBuckets.add(bucket);
    }
    for (const [bucket, status] of Object.entries(sessionStatuses)) {
      if (status === "asking") protectedBuckets.add(bucket);
    }
    return protectedBuckets;
  }, [busyKeys, queuedInputs, sessionStatuses]);
}

function hasUnfinishedWork(state: MessagesReducerState): boolean {
  return (
    !!state.streamingAssistantId ||
    !!state.streamingThinkingId ||
    Object.keys(state.activeAgents).length > 0 ||
    state.messages.some(
      (message) =>
        (message.kind === "ask_user" && message.answer === undefined) ||
        (message.kind === "user" && message.pending === true) ||
        ((message.kind === "assistant" ||
          message.kind === "thinking" ||
          message.kind === "agent") &&
          !message.done) ||
        (message.kind === "tool" && message.status === "running"),
    )
  );
}

interface Params {
  activeBucket: string;
  transcripts: TranscriptsMap;
  sessionIndices: Record<string, SessionIndex>;
  protectedBuckets: ReadonlySet<string>;
  hydratedBucketsRef: MutableRefObject<Map<string, string | undefined>>;
  dispatch: Dispatch<TranscriptsAction>;
}

/** Release old render projections only after Main acknowledges their snapshots. */
export function useIdleTranscriptEviction(params: Params): void {
  const latestRef = useRef(params);
  latestRef.current = params;
  const visitsRef = useRef(new Map<string, number>());
  const visitEpochRef = useRef(0);
  const lastActiveRef = useRef<string | undefined>(undefined);
  const flushingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (lastActiveRef.current !== params.activeBucket) {
      lastActiveRef.current = params.activeBucket;
      visitsRef.current.set(params.activeBucket, ++visitEpochRef.current);
    }
    const persistence = getSessionPersistence();
    // The legacy synchronous cache can fail silently. It cannot provide the
    // durable acknowledgement required to release an in-memory projection.
    if (!persistence || flushingRef.current) return;
    const identities = new Map<
      string,
      { projectId: string | null; sessionId: string; engineId?: string }
    >();
    for (const [projectKey, index] of Object.entries(params.sessionIndices)) {
      const projectId = projectKey === NO_REPO_KEY ? null : projectKey;
      for (const session of index.sessions) {
        identities.set(bucketKey(projectId, session.id), {
          projectId,
          sessionId: session.id,
          engineId: session.engineSessionId,
        });
      }
    }
    const eligible = Object.entries(params.transcripts)
      .filter(([bucket, state]) => {
        const identity = identities.get(bucket);
        const hasDurableHistory =
          identity &&
          ((params.hydratedBucketsRef.current.has(bucket) &&
            params.hydratedBucketsRef.current.get(bucket) === identity.engineId) ||
            (identity.engineId && state.sessionId === identity.engineId && state.turnEpoch > 0));
        return (
          identity &&
          bucket !== params.activeBucket &&
          !params.protectedBuckets.has(bucket) &&
          !hasTranscriptRecovery(params.transcripts, bucket) &&
          hasDurableHistory &&
          !hasUnfinishedWork(state)
        );
      })
      .sort(
        ([left], [right]) =>
          (visitsRef.current.get(left) ?? 0) - (visitsRef.current.get(right) ?? 0),
      );
    const candidates = eligible.slice(
      0,
      Math.max(0, eligible.length - RETAINED_IDLE_TRANSCRIPT_BUCKETS),
    );
    if (!candidates.length) return;
    flushingRef.current = true;
    for (const [bucket, state] of candidates) {
      const identity = identities.get(bucket)!;
      saveTranscript(identity.projectId, identity.sessionId, state);
    }
    void persistence
      .flush()
      .then(() => {
        if (!mountedRef.current || getSessionPersistence() !== persistence) return;
        const current = latestRef.current;
        for (const [bucket, state] of candidates) {
          if (
            bucket === current.activeBucket ||
            current.protectedBuckets.has(bucket) ||
            hasTranscriptRecovery(current.transcripts, bucket) ||
            current.transcripts[bucket] !== state ||
            hasUnfinishedWork(state)
          )
            continue;
          // The reducer checks identity again, including stream batches already
          // queued in React but not yet reflected in latestRef.
          current.dispatch({ type: "evict_if_unchanged", bucket, state });
        }
      })
      .catch((error) => {
        window.codeshell.log("session.history.eviction_deferred", { error: String(error) });
      })
      .finally(() => {
        flushingRef.current = false;
      });
  }, [
    params.activeBucket,
    params.transcripts,
    params.sessionIndices,
    params.protectedBuckets,
    params.hydratedBucketsRef,
    params.dispatch,
  ]);
}
