import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskInboxListResult, TaskInboxRecordV1 } from "../../preload/task-inbox-api";

/** Publish complete snapshots; source updates queue behind pagination instead of starving it. */
export function useTaskInboxSnapshot() {
  const [snapshot, setSnapshot] = useState<TaskInboxListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const currentVersion = useRef(-1);
  const notifiedVersion = useRef(-1);
  const inFlight = useRef(true);
  const refresh = useCallback(() => {
    inFlight.current = true;
    setRevision((value) => value + 1);
  }, []);

  useEffect(
    () =>
      window.codeshell.taskInbox.onChanged((version) => {
        if (version <= Math.max(currentVersion.current, notifiedVersion.current)) return;
        notifiedVersion.current = version;
        if (!inFlight.current) refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;
    const notifiedAtStart = notifiedVersion.current;
    let published = false;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // Retry an expired/mixed snapshot at most twice. A broken provider must
        // surface a recoverable error instead of spinning forever.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const records = new Map<string, TaskInboxRecordV1>();
          const cursors = new Set<string>();
          let first: TaskInboxListResult | null = null;
          let cursor: string | undefined;
          let mixed = false;
          do {
            const page = await window.codeshell.taskInbox.list({
              limit: 200,
              ...(cursor ? { cursor } : {}),
            });
            if (cancelled) return;
            if (!first) first = page;
            if (page.version !== first.version) {
              mixed = true;
              break;
            }
            for (const record of page.records) records.set(record.taskKey, record);
            cursor = page.nextCursor;
            if (cursor) {
              if (cursors.has(cursor)) throw new Error("Task pagination did not advance");
              cursors.add(cursor);
            }
          } while (cursor);
          if (mixed) continue;
          if (first) {
            currentVersion.current = first.version;
            setSnapshot({ ...first, records: [...records.values()], nextCursor: undefined });
            published = true;
          }
          return;
        }
        throw new Error("Task snapshot changed repeatedly. Please refresh to retry.");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) {
          inFlight.current = false;
          setLoading(false);
          // A newer notification during a failed read must not be swallowed.
          // Only follow genuinely new notifications to avoid a hot retry loop.
          if (notifiedVersion.current > (published ? currentVersion.current : notifiedAtStart))
            refresh();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, refresh]);

  return { snapshot, loading, error, refresh };
}
