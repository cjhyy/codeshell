import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  bucketKey,
  clearPanelState,
  deleteSessionLocal,
  NO_REPO_KEY,
  renameSessionLocal,
  type SessionIndex,
} from "../transcripts";
import { forgetExternalRuntimeSession } from "../externalRuntimeRun";
import type { TranscriptsAction, TranscriptsMap } from "../transcriptsReducer";
import type { QueuedInputState } from "../queuedInput";
import type { ComposerDraftsMap, PanelBucketState } from "./appUtils";

interface Params {
  untitledTitle: string;
  sessionIndicesRef: MutableRefObject<Record<string, SessionIndex>>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  activeBucketRef: MutableRefObject<string>;
  setPanelByBucket: Dispatch<SetStateAction<Record<string, PanelBucketState>>>;
  transcriptsRef: MutableRefObject<TranscriptsMap>;
  dispatch: Dispatch<TranscriptsAction>;
  engineToBucketRef: MutableRefObject<Map<string, string>>;
  runningBucketRef: MutableRefObject<string | null>;
  coalescersRef: MutableRefObject<Map<string, { discard(): void }>>;
  coalescerSeqRef: MutableRefObject<Map<string, number>>;
  appliedSeqRef: MutableRefObject<Map<string, number>>;
  setBusyForKey: (bucket: string, busy: boolean) => void;
  setUnreadBuckets: Dispatch<SetStateAction<Set<string>>>;
  setQueuedInputs: Dispatch<SetStateAction<QueuedInputState>>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftsMap>>;
}

/** Reconcile a successful history-page mutation with the loaded sidebar projection. */
export function useSessionHistorySync(params: Params) {
  // An IPC may finish after its page unmounts or another session becomes active.
  const latest = useRef(params);
  latest.current = params;

  const onSessionRenamed = useCallback((engineId: string, title: string) => {
    const current = latest.current;
    const changed: Record<string, SessionIndex> = {};
    for (const [key, index] of Object.entries(current.sessionIndicesRef.current)) {
      const projectId = key === NO_REPO_KEY ? null : key;
      for (const session of index.sessions) {
        if ((session.engineSessionId ?? session.id) !== engineId) continue;
        changed[key] = renameSessionLocal(
          projectId,
          session.id,
          title.trim() || current.untitledTitle,
          true,
        );
      }
    }
    if (Object.keys(changed).length === 0) return;
    current.sessionIndicesRef.current = { ...current.sessionIndicesRef.current, ...changed };
    current.setSessionIndices((previous) => ({ ...previous, ...changed }));
  }, []);

  const onSessionDeleted = useCallback((engineId: string) => {
    const current = latest.current;
    const changed: Record<string, SessionIndex> = {};
    const deletedBuckets = new Set<string>();
    for (const [key, index] of Object.entries(current.sessionIndicesRef.current)) {
      const projectId = key === NO_REPO_KEY ? null : key;
      for (const session of index.sessions) {
        if ((session.engineSessionId ?? session.id) !== engineId) continue;
        changed[key] = deleteSessionLocal(projectId, session.id);
        const bucket = bucketKey(projectId, session.id);
        deletedBuckets.add(bucket);
        clearPanelState(bucket);
        if (current.activeBucketRef.current === bucket)
          current.activeBucketRef.current = bucketKey(projectId, null);
      }
    }
    // Main already stopped the runtime. Only forget the renderer's cached binding.
    forgetExternalRuntimeSession(engineId);
    if (deletedBuckets.size === 0) return;

    current.sessionIndicesRef.current = { ...current.sessionIndicesRef.current, ...changed };
    current.setSessionIndices((previous) => ({ ...previous, ...changed }));
    current.setPanelByBucket((previous) => {
      const next = { ...previous };
      for (const bucket of deletedBuckets) delete next[bucket];
      return next;
    });
    current.setQueuedInputs((previous) => {
      const next = { ...previous };
      for (const bucket of deletedBuckets) delete next[bucket];
      return next;
    });
    current.setComposerDrafts((previous) => {
      const next = { ...previous };
      for (const bucket of deletedBuckets) delete next[bucket];
      return next;
    });
    current.setUnreadBuckets((previous) => {
      const next = new Set(previous);
      for (const bucket of deletedBuckets) next.delete(bucket);
      return next;
    });
    for (const [id, bucket] of current.engineToBucketRef.current) {
      if (deletedBuckets.has(bucket)) current.engineToBucketRef.current.delete(id);
    }
    const remainingTranscripts = { ...current.transcriptsRef.current };
    for (const bucket of deletedBuckets) {
      current.setBusyForKey(bucket, false);
      if (current.runningBucketRef.current === bucket) current.runningBucketRef.current = null;
      // Discard buffered deltas before evicting so a delayed flush cannot restore them.
      current.coalescersRef.current.get(bucket)?.discard();
      current.coalescersRef.current.delete(bucket);
      current.coalescerSeqRef.current.delete(bucket);
      current.appliedSeqRef.current.delete(bucket);
      delete remainingTranscripts[bucket];
      current.dispatch({ type: "evict", bucket });
    }
    current.transcriptsRef.current = remainingTranscripts;
  }, []);

  return { onSessionRenamed, onSessionDeleted };
}
