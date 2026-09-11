import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { SessionTranscriptPage } from "../../preload/types";

import { mergeHistoryWindows } from "./mergeHistoryWindows";
import { useIdleTranscriptEviction } from "./useIdleTranscriptEviction";
import { foldTranscript } from "../automation/foldTranscript";
import { selectReplayEvents, snapshotHasUnfinishedTopLevelTurn } from "../snapshotReplay";
import {
  bucketKey,
  loadPersistedTranscript,
  loadTranscript,
  NO_REPO_KEY,
  saveTranscript,
  type SessionIndex,
} from "../transcripts";
import { subscribeSessionPersistenceFlush } from "../sessionPersistence";
import type { TranscriptsAction, TranscriptsMap } from "../transcriptsReducer";
import { applyStreamEvent, INITIAL_STATE, type MessagesReducerState } from "../types";
import {
  hasTranscriptRecovery,
  hasBufferedTranscriptRecovery,
  transcriptRecoveryFailed,
} from "../transcriptHydration";
import type { SequencedStreamEvent } from "../streamCoalescer";

export const INITIAL_CHAT_HISTORY_BYTES = 512 * 1024;
const MAX_CHAT_HISTORY_BYTES = 128 * 1024 * 1024;
const NO_PROTECTED_BUCKETS = new Set<string>();

interface HistoryPageState {
  engineId: string | undefined;
  loadedBytes: number;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
}

async function readHistoryPage(engineId: string, maxBytes: number): Promise<SessionTranscriptPage> {
  if (window.codeshell.getSessionTranscriptPage) {
    return window.codeshell.getSessionTranscriptPage(engineId, { maxBytes });
  }
  // Compatibility with older bridges; current Desktop always exposes paging.
  return {
    items: await window.codeshell.getSessionTranscript(engineId),
    loadedBytes: 0,
    hasMore: false,
  };
}

export interface TranscriptBucketsParams {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeBucket: string;
  activeProjectBucketSegment: string;
  sessionIndices: Record<string, SessionIndex>;
  transcripts: TranscriptsMap;
  dispatch: Dispatch<TranscriptsAction>;
  runningBucketRef: MutableRefObject<string | null>;
  busySinceRef: MutableRefObject<Map<string, number>>;
  setBusyKeys: Dispatch<SetStateAction<Set<string>>>;
  protectedBuckets?: ReadonlySet<string>;
}

/** Owns transcript hydration/persistence and the retained snapshot cursor. */
export function useTranscriptBuckets({
  activeProjectId,
  activeSessionId,
  activeBucket,
  activeProjectBucketSegment,
  sessionIndices,
  transcripts,
  dispatch,
  runningBucketRef,
  busySinceRef,
  setBusyKeys,
  protectedBuckets = NO_PROTECTED_BUCKETS,
}: TranscriptBucketsParams): {
  state: MessagesReducerState;
  awaitingHydration: boolean;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyFailed: boolean;
  historyLimitReached: boolean;
  loadEarlierHistory: () => Promise<void>;
  appliedSeqRef: MutableRefObject<Map<string, number>>;
  setBusyForKey: (key: string, val: boolean) => void;
} {
  const appliedSeqRef = useRef<Map<string, number>>(new Map());
  const hydratedBucketsRef = useRef(new Map<string, string | undefined>());
  const [historyPages, setHistoryPages] = useState<Record<string, HistoryPageState>>({});
  const historyPagesRef = useRef(historyPages);
  historyPagesRef.current = historyPages;
  const pagingRequestsRef = useRef(new Set<string>());
  const hydrationGenerationsRef = useRef(new Map<string, number>());
  const [retryEpoch, setRetryEpoch] = useState(0);
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const sessionIndicesRef = useRef(sessionIndices);
  sessionIndicesRef.current = sessionIndices;
  const engineId = sessionIndices[activeProjectBucketSegment]?.sessions.find(
    (session) => session.id === activeSessionId,
  )?.engineSessionId;
  useIdleTranscriptEviction({
    activeBucket,
    transcripts,
    sessionIndices,
    protectedBuckets,
    hydratedBucketsRef,
    dispatch,
  });
  useEffect(
    () =>
      subscribeSessionPersistenceFlush(() => {
        for (const [projectKey, index] of Object.entries(sessionIndicesRef.current)) {
          const projectId = projectKey === NO_REPO_KEY ? null : projectKey;
          for (const session of index.sessions) {
            const bucket = bucketKey(projectId, session.id);
            const state = transcriptsRef.current[bucket];
            // Never flush a partial hydration over the durable snapshot. The
            // live-run case covers background buckets created by host events.
            const hydrated =
              hydratedBucketsRef.current.has(bucket) &&
              hydratedBucketsRef.current.get(bucket) === session.engineSessionId;
            const liveRun =
              session.engineSessionId &&
              state?.sessionId === session.engineSessionId &&
              state.turnEpoch > 0;
            if (
              state &&
              (hydrated || liveRun) &&
              !hasTranscriptRecovery(transcriptsRef.current, bucket)
            )
              saveTranscript(projectId, session.id, state);
          }
        }
      }),
    [],
  );
  const setBusyForKey = useCallback(
    (key: string, val: boolean): void => {
      if (val) {
        if (!busySinceRef.current.has(key)) busySinceRef.current.set(key, Date.now());
      } else {
        busySinceRef.current.delete(key);
      }
      setBusyKeys((prev) => {
        const had = prev.has(key);
        if (val === had) return prev;
        const next = new Set(prev);
        if (val) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [busySinceRef, setBusyKeys],
  );
  useEffect(() => {
    for (const [bucket, state] of Object.entries(transcripts)) {
      if (hasTranscriptRecovery(transcripts, bucket)) continue;
      appliedSeqRef.current.set(bucket, state.snapshotSeq);
    }
    if (transcriptRecoveryFailed(transcripts, activeBucket)) {
      hydratedBucketsRef.current.delete(activeBucket);
      setHistoryPages((pages) => {
        const page = pages[activeBucket];
        return page && (!page.failed || page.loading)
          ? { ...pages, [activeBucket]: { ...page, loading: false, failed: true } }
          : pages;
      });
    }
  }, [transcripts, activeBucket]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (
      hydratedBucketsRef.current.has(activeBucket) &&
      hydratedBucketsRef.current.get(activeBucket) === engineId &&
      transcriptsRef.current[activeBucket]
    )
      return;
    let local = loadTranscript(activeProjectId, activeSessionId);
    const bucket = activeBucket;
    hydrationGenerationsRef.current.set(
      bucket,
      (hydrationGenerationsRef.current.get(bucket) ?? 0) + 1,
    );
    const token = hydrationGenerationsRef.current.get(bucket)!;
    dispatch({ type: "hydrate_begin", bucket, token, sessionId: engineId });
    const goalAtStart = transcriptsRef.current[bucket]
      ? transcriptsRef.current[bucket].activeGoal
      : local.activeGoal;
    let cancelled = false;
    const canCommit = () =>
      !cancelled || hasBufferedTranscriptRecovery(transcriptsRef.current, bucket, token);
    setHistoryPages((previous) => ({
      ...previous,
      [bucket]: { engineId, loadedBytes: 0, hasMore: false, loading: true, failed: false },
    }));
    window.codeshell.log("session.hydrate.begin", {
      bucket,
      uiSessionId: activeSessionId,
      engineSessionId: engineId ?? null,
    });

    void (async () => {
      let snapshotShowsRunning = false;
      let base: MessagesReducerState;
      let historyLoaded = false;
      let persistedLoaded = false;
      let persistedHasEarlier = false;
      let replaySnapshot: SequencedStreamEvent[] = [];
      let snapshotEpoch: string | undefined;
      let snapshotLoaded = !engineId;
      let page: SessionTranscriptPage | undefined;
      const [persistedResult, canonicalResult] = await Promise.allSettled([
        loadPersistedTranscript(activeProjectId, activeSessionId, INITIAL_CHAT_HISTORY_BYTES),
        engineId
          ? readHistoryPage(engineId, INITIAL_CHAT_HISTORY_BYTES)
          : Promise.resolve(undefined),
      ]);
      if (!canCommit()) return;
      if (persistedResult.status === "fulfilled") {
        local = persistedResult.value.state;
        persistedHasEarlier = persistedResult.value.hasEarlier;
        persistedLoaded = true;
      } else {
        window.codeshell.log("session.hydrate.fail", {
          bucket,
          stage: "persisted_snapshot",
          error: String(persistedResult.reason),
        });
      }
      if (canonicalResult.status === "fulfilled") {
        page = canonicalResult.value;
        base = page ? mergeHistoryWindows(foldTranscript(page.items), local) : local;
        historyLoaded = persistedLoaded;
      } else {
        base = local;
        window.codeshell.log("session.hydrate.fail", {
          bucket,
          stage: "transcript",
          error: String(canonicalResult.reason),
        });
      }

      let state = base;
      if (engineId) {
        try {
          const snapshot = await window.codeshell.subscribeSession(engineId, 0);
          if (!canCommit()) return;
          snapshotEpoch = snapshot.epoch;
          snapshotLoaded = true;
          if (
            (snapshotEpoch && base.snapshotEpoch !== snapshotEpoch) ||
            (base.sessionId && base.sessionId !== engineId)
          ) {
            base = state = {
              ...base,
              snapshotEpoch,
              snapshotSeq: 0,
              sessionId: engineId,
              streamingAssistantId: null,
              streamingThinkingId: null,
              agentMessageIndex: {},
              activeAgents: {},
            };
          }
          const sinceSeq = base.snapshotSeq ?? 0;
          replaySnapshot = snapshot.events.map((entry) => ({
            ...entry,
            event: entry.event as StreamEvent,
            epoch: snapshotEpoch,
          }));
          snapshotShowsRunning = snapshotHasUnfinishedTopLevelTurn(snapshot);
          // A live bucket already receives this stream through the host
          // coalescer. Replaying it here would duplicate its current turn.
          const { events, cursor } = selectReplayEvents(snapshot, sinceSeq);
          if (events.length > 0) {
            let acc = base;
            for (const event of events) acc = applyStreamEvent(acc, event as StreamEvent);
            state = { ...acc, snapshotSeq: Math.max(acc.snapshotSeq, cursor) };
          }
        } catch (error) {
          historyLoaded = false;
          window.codeshell.log("session.hydrate.fail", {
            bucket,
            stage: "snapshot",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (state.messages.length === 0 && !page?.hasMore) {
          try {
            page = await readHistoryPage(engineId, INITIAL_CHAT_HISTORY_BYTES);
            const disk = foldTranscript(page.items);
            if (disk.messages.length > 0) state = base = mergeHistoryWindows(disk, local);
            historyLoaded = persistedLoaded;
          } catch (error) {
            window.codeshell.log("session.hydrate.fail", {
              bucket,
              stage: "transcript_fallback",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (canCommit()) {
        historyLoaded = historyLoaded && snapshotLoaded;
        if (historyLoaded) hydratedBucketsRef.current.set(bucket, engineId);
        setHistoryPages((previous) => ({
          ...previous,
          [bucket]: {
            engineId,
            loadedBytes: INITIAL_CHAT_HISTORY_BYTES,
            hasMore: (page?.hasMore ?? false) || persistedHasEarlier,
            loading: false,
            failed: !historyLoaded,
          },
        }));
        // Reconcile inside the reducer, against the latest live state (including
        // batches queued while the disk, snapshot, or goal request was pending).
        dispatch({
          type: "hydrate_history",
          bucket,
          state,
          history: base,
          goalAtStart,
          token: snapshotLoaded ? token : undefined,
          snapshot: replaySnapshot,
          epoch: snapshotEpoch,
          sessionId: engineId,
        });
        // Existing live buckets already get authoritative busy changes from the
        // host subscription, including a completion during the awaited reads.
        if (snapshotShowsRunning && !transcriptsRef.current[bucket]) {
          setBusyForKey(bucket, true);
          runningBucketRef.current = bucket;
          window.codeshell.log("session.busy_restored", {
            bucket,
            engineSessionId: engineId ?? null,
            source: "snapshot",
          });
        }
        window.codeshell.log("session.hydrate.end", {
          bucket,
          messageCount: state.messages.length,
          snapshotSeq: state.snapshotSeq,
        });
      }

      // Goal metadata must not delay committing a replayed stream prefix.
      if (engineId && !cancelled) {
        const goalBeforeLookup = state.activeGoal;
        try {
          const { ok, goal, goalId, paused, revision } = await window.codeshell.goalGet(engineId);
          if (ok !== false && goal) {
            const persistedGoalId = goalId ?? state.activeGoal?.goalId;
            const persistedRevision = revision ?? state.activeGoal?.revision;
            const replacesLocalGoal =
              state.activeGoal?.goalId !== undefined &&
              goalId !== undefined &&
              state.activeGoal.goalId !== goalId;
            state = applyStreamEvent(state, {
              type: replacesLocalGoal ? "goal_set" : "goal_updated",
              goalId: persistedGoalId,
              revision: persistedRevision,
              objective: goal,
              paused: paused ?? false,
              ...(replacesLocalGoal ? { replaced: true } : {}),
            } as StreamEvent);
          } else if (ok !== false && state.activeGoal) {
            state = applyStreamEvent(state, {
              type: "goal_cleared",
              goalId: state.activeGoal.goalId,
              revision: state.activeGoal.revision,
            } as StreamEvent);
          }
        } catch (error) {
          window.codeshell.log("session.hydrate.fail", {
            bucket,
            stage: "goal",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!cancelled && state.activeGoal !== goalBeforeLookup) {
          dispatch({
            type: "goal_reconcile",
            bucket,
            expected: goalBeforeLookup,
            goal: state.activeGoal,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      dispatch({ type: "hydrate_cancel", bucket, token });
    };
  }, [
    activeBucket,
    activeProjectId,
    activeSessionId,
    engineId,
    dispatch,
    runningBucketRef,
    setBusyForKey,
    retryEpoch,
  ]);

  const loadEarlierHistory = useCallback(async (): Promise<void> => {
    if (!activeSessionId || pagingRequestsRef.current.has(activeBucket)) return;
    const previous = historyPagesRef.current[activeBucket];
    if (!previous || previous.engineId !== engineId || previous.loading) return;
    if (
      !hydratedBucketsRef.current.has(activeBucket) ||
      hydratedBucketsRef.current.get(activeBucket) !== engineId
    ) {
      setRetryEpoch((epoch) => epoch + 1);
      return;
    }
    if (!previous.hasMore) return;
    const maxBytes = Math.min(
      MAX_CHAT_HISTORY_BYTES,
      Math.max(INITIAL_CHAT_HISTORY_BYTES, previous.loadedBytes * 2),
    );
    if (maxBytes <= previous.loadedBytes) return;
    const bucket = activeBucket;
    const generation = hydrationGenerationsRef.current.get(bucket);
    const goalAtStart = transcriptsRef.current[bucket]?.activeGoal ?? null;
    pagingRequestsRef.current.add(bucket);
    setHistoryPages((pages) => ({
      ...pages,
      [bucket]: { ...previous, loading: true, failed: false },
    }));
    try {
      const [persistedResult, canonicalResult] = await Promise.allSettled([
        loadPersistedTranscript(activeProjectId, activeSessionId, maxBytes),
        engineId ? readHistoryPage(engineId, maxBytes) : Promise.resolve(undefined),
      ]);
      if (persistedResult.status === "rejected") throw persistedResult.reason;
      if (canonicalResult.status === "rejected") throw canonicalResult.reason;
      // A newly bound engine starts its own hydration. An older cache-only
      // request must not replace that session's pagination metadata.
      if (generation !== hydrationGenerationsRef.current.get(bucket)) return;
      const page = canonicalResult.value;
      const history = page
        ? mergeHistoryWindows(foldTranscript(page.items), persistedResult.value.state)
        : persistedResult.value.state;
      dispatch({ type: "hydrate_history", bucket, state: history, history, goalAtStart });
      setHistoryPages((pages) => ({
        ...pages,
        [bucket]: {
          engineId,
          loadedBytes: maxBytes,
          hasMore: (page?.hasMore ?? false) || persistedResult.value.hasEarlier,
          loading: false,
          failed: false,
        },
      }));
    } catch (error) {
      if (generation !== hydrationGenerationsRef.current.get(bucket)) return;
      setHistoryPages((pages) => ({
        ...pages,
        [bucket]: { ...previous, loading: false, failed: true },
      }));
      window.codeshell.log("session.history.page.fail", {
        bucket,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pagingRequestsRef.current.delete(bucket);
    }
  }, [activeBucket, activeProjectId, activeSessionId, engineId, dispatch]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (
      !hydratedBucketsRef.current.has(activeBucket) ||
      hydratedBucketsRef.current.get(activeBucket) !== engineId
    )
      return;
    const handle = setTimeout(() => {
      const state = transcripts[activeBucket];
      if (state && !hasTranscriptRecovery(transcriptsRef.current, activeBucket))
        saveTranscript(activeProjectId, activeSessionId, state);
    }, 600);
    return () => clearTimeout(handle);
  }, [transcripts, activeBucket, activeProjectId, activeSessionId, engineId]);

  const fallbackState = useMemo<MessagesReducerState>(() => {
    if (!activeSessionId) return INITIAL_STATE;
    const local = loadTranscript(activeProjectId, activeSessionId);
    return local.messages.length > 0 ? local : INITIAL_STATE;
    // activeBucket captures both project and session identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBucket]);
  const state = transcripts[activeBucket] ?? fallbackState;
  const historyPage = historyPages[activeBucket];
  const activeHistoryPage = historyPage?.engineId === engineId ? historyPage : undefined;
  const awaitingHydration =
    activeSessionId !== null &&
    (!hydratedBucketsRef.current.has(activeBucket) ||
      hydratedBucketsRef.current.get(activeBucket) !== engineId) &&
    state.messages.length === 0 &&
    !activeHistoryPage?.failed;

  return {
    state,
    awaitingHydration,
    historyHasMore: activeHistoryPage?.hasMore ?? false,
    historyLoading: activeHistoryPage?.loading ?? false,
    historyFailed: activeHistoryPage?.failed ?? false,
    historyLimitReached:
      !!activeHistoryPage?.hasMore && activeHistoryPage.loadedBytes >= MAX_CHAT_HISTORY_BYTES,
    loadEarlierHistory,
    appliedSeqRef,
    setBusyForKey,
  };
}
