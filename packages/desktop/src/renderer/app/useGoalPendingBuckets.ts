import { useCallback, useState } from "react";

/**
 * Buckets whose latest Goal control (pause, resume, edit, delete) is still in
 * flight. The Goal bar keeps its controls disabled meanwhile: a second click on
 * the optimistic projection sent the opposite operation against a revision
 * main had not reached yet.
 */
export function useGoalPendingBuckets(): {
  goalPendingBuckets: ReadonlySet<string>;
  markGoalPending: (bucket: string, pending: boolean) => void;
} {
  const [goalPendingBuckets, setGoalPendingBuckets] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markGoalPending = useCallback(
    (bucket: string, pending: boolean) =>
      setGoalPendingBuckets((previous) => {
        if (previous.has(bucket) === pending) return previous;
        const next = new Set(previous);
        if (pending) next.add(bucket);
        else next.delete(bucket);
        return next;
      }),
    [],
  );
  return { goalPendingBuckets, markGoalPending };
}
