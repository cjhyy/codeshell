import React from "react";

/**
 * Self-fetching closure reminders for the work tree. Pulls
 * `window.codeshell.pet.getSummaries()` on mount and whenever the projection
 * snapshot version advances (debounced), with a sequence guard so a slow
 * response can never overwrite a newer one. Returns a stable
 * `Map<sessionId, reminder>` carrying only entries with non-empty text; a
 * completed/follow-up work-tree row uses it as its one-line follow-up detail.
 *
 * Pass `null` while the projection is not ready to skip fetching entirely (the
 * hook stays on the empty map until a real version arrives).
 *
 * Lifted from the former standalone "Mimi 小结" block — the fetch/debounce/seq
 * shape is identical; only the consumer changed from a list to row enrichment.
 */
const FETCH_DEBOUNCE_MS = 2_000;

const EMPTY: ReadonlyMap<string, string> = new Map();

export function useClosureReminders(snapshotVersion: number | null): ReadonlyMap<string, string> {
  const [reminders, setReminders] = React.useState<ReadonlyMap<string, string>>(EMPTY);
  const seqRef = React.useRef(0);
  const loadedOnceRef = React.useRef(false);

  React.useEffect(() => {
    if (snapshotVersion === null) return;
    let disposed = false;
    const run = (): void => {
      const seq = (seqRef.current += 1);
      const getSummaries = window.codeshell.pet?.getSummaries;
      if (!getSummaries) return;
      void Promise.resolve(getSummaries())
        .then((rows) => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          const next = new Map<string, string>();
          for (const row of rows) {
            const text = row.text?.trim();
            if (text) next.set(row.sessionId, text);
          }
          setReminders(next);
        })
        .catch(() => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
        });
    };
    const timer = setTimeout(run, loadedOnceRef.current ? FETCH_DEBOUNCE_MS : 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [snapshotVersion]);

  return reminders;
}
