import { useEffect, useMemo, useState } from "react";
import type { SessionContentSearchResult } from "../../preload/types";

const CONTENT_DEBOUNCE_MS = 300;

interface SearchRequest {
  enabled: boolean;
  term: string;
  attempt: number;
}

interface SettledSearch {
  request: SearchRequest;
  result: SessionContentSearchResult | null;
  failed: boolean;
}

/** Debounced content lookup; changing query, mode, or visibility invalidates old work. */
export function useSessionContentSearch(enabled: boolean, term: string) {
  const [settled, setSettled] = useState<SettledSearch | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Identity represents this visit to the query, including A→B→A. Comparing
  // only the text would temporarily reuse old A results during the new request.
  const request = useMemo(() => ({ enabled, term, attempt }), [enabled, term, attempt]);
  useEffect(() => {
    if (!request.enabled) {
      setSettled(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await window.codeshell.searchSessionContent(request.term);
        if (!cancelled) setSettled({ request, result, failed: false });
      } catch {
        if (!cancelled) setSettled({ request, result: null, failed: true });
      }
    }, CONTENT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request]);

  const current = enabled && settled?.request === request ? settled : null;
  return {
    result: current?.result ?? null,
    loading: enabled && current === null,
    failed: current?.failed ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
