import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";

import { chooseHydrateBase } from "../automation/hydrateOrder";
import { foldTranscript } from "../automation/foldTranscript";
import { selectReplayEvents, snapshotHasUnfinishedTopLevelTurn } from "../snapshotReplay";
import { loadTranscript, saveTranscript, type SessionIndex } from "../transcripts";
import type {
  TranscriptsAction,
  TranscriptsMap,
} from "../transcriptsReducer";
import { applyStreamEvent, INITIAL_STATE, type MessagesReducerState } from "../types";

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
}: TranscriptBucketsParams): {
  state: MessagesReducerState;
  awaitingHydration: boolean;
  appliedSeqRef: MutableRefObject<Map<string, number>>;
  setBusyForKey: (key: string, val: boolean) => void;
} {
  const appliedSeqRef = useRef<Map<string, number>>(new Map());
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
    if (!activeSessionId) return;
    if (transcripts[activeBucket]) return;
    const local = loadTranscript(activeProjectId, activeSessionId);
    const summary = sessionIndices[activeProjectBucketSegment]?.sessions.find(
      (session) => session.id === activeSessionId,
    );
    const engineId = summary?.engineSessionId;
    const bucket = activeBucket;
    let cancelled = false;
    window.codeshell.log("session.hydrate.begin", {
      bucket,
      uiSessionId: activeSessionId,
      engineSessionId: engineId ?? null,
    });

    void (async () => {
      let snapshotShowsRunning = false;
      let base = local;
      if (engineId) {
        try {
          const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
          base = chooseHydrateBase(disk, local);
        } catch (error) {
          window.codeshell.log("session.hydrate.fail", {
            bucket,
            stage: "transcript",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let state = base;
      if (engineId) {
        try {
          const sinceSeq = base.snapshotSeq ?? 0;
          const snapshot = await window.codeshell.subscribeSession(engineId, 0);
          snapshotShowsRunning = snapshotHasUnfinishedTopLevelTurn(snapshot);
          const { events, cursor } = selectReplayEvents(snapshot, sinceSeq);
          if (events.length > 0) {
            appliedSeqRef.current.set(bucket, cursor);
            let acc = base;
            for (const event of events) acc = applyStreamEvent(acc, event as StreamEvent);
            state = { ...acc, snapshotSeq: Math.max(acc.snapshotSeq, cursor) };
          } else {
            appliedSeqRef.current.set(bucket, sinceSeq);
          }
        } catch (error) {
          window.codeshell.log("session.hydrate.fail", {
            bucket,
            stage: "snapshot",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (state.messages.length === 0) {
          try {
            const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
            if (disk.messages.length > 0) state = disk;
          } catch (error) {
            window.codeshell.log("session.hydrate.fail", {
              bucket,
              stage: "transcript_fallback",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (engineId && !cancelled) {
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
      }

      if (!cancelled) {
        dispatch({ type: "hydrate", bucket, state });
        if (snapshotShowsRunning) {
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
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeBucket,
    activeProjectId,
    activeSessionId,
    activeProjectBucketSegment,
    sessionIndices,
    transcripts,
    dispatch,
    runningBucketRef,
    setBusyForKey,
  ]);

  useEffect(() => {
    if (!activeSessionId) return;
    const handle = setTimeout(() => {
      const state = transcripts[activeBucket];
      if (state) saveTranscript(activeProjectId, activeSessionId, state);
    }, 600);
    return () => clearTimeout(handle);
  }, [transcripts, activeBucket, activeProjectId, activeSessionId]);

  const fallbackState = useMemo<MessagesReducerState>(() => {
    if (!activeSessionId) return INITIAL_STATE;
    const local = loadTranscript(activeProjectId, activeSessionId);
    return local.messages.length > 0 ? local : INITIAL_STATE;
    // activeBucket captures both project and session identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBucket]);
  const state = transcripts[activeBucket] ?? fallbackState;
  const awaitingHydration =
    activeSessionId !== null &&
    transcripts[activeBucket] === undefined &&
    state.messages.length === 0;

  return { state, awaitingHydration, appliedSeqRef, setBusyForKey };
}
