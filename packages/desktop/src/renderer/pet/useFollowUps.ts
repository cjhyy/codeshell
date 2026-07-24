import React from "react";
import type { PetSessionSummaryRow } from "../../preload/types";

/**
 * Self-fetching follow-up rows for the standalone "需要跟进" block. Pulls
 * `window.codeshell.pet.getSummaries()` on mount and whenever the projection
 * snapshot version advances (debounced), with a sequence guard so a slow
 * response can never overwrite a newer one. Returns the full summary rows
 * (title / workspace / terminalAt / text) — the block needs more than the text,
 * so unlike the former reminder hook it keeps the whole row, not just a Map.
 *
 * Only rows with non-empty follow-up text are kept: the service already records
 * NONE/empty sessions as an empty-marker, but we filter defensively.
 *
 * Pass `null` while the projection is not ready to skip fetching entirely (the
 * hook stays on the empty list until a real version arrives).
 */
const FETCH_DEBOUNCE_MS = 2_000;

const EMPTY: readonly PetSessionSummaryRow[] = [];

export function useFollowUps(snapshotVersion: number | null): readonly PetSessionSummaryRow[] {
  const [rows, setRows] = React.useState<readonly PetSessionSummaryRow[]>(EMPTY);
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
        .then((next) => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          setRows(next.filter((row) => Boolean(row.text?.trim())));
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

  return rows;
}
