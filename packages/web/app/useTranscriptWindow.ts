import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatItem } from "../src/lib/streamReducer.js";

const PAGE_SIZE = 80;
interface WindowState {
  scope: string;
  firstId?: string;
  all: boolean;
}

/** Limit initial DOM work, keeping the complete recovered transcript in its
 * controller. Once chosen, the boundary stays fixed while live items arrive. */
export function useTranscriptWindow({
  items,
  scope,
  loading,
  listRef,
  pauseFollowing,
}: {
  items: ChatItem[];
  scope: string;
  loading: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  pauseFollowing: () => void;
}) {
  const [window, setWindow] = useState<WindowState>({ scope, all: false });
  const initialized = window.scope === scope && (window.all || window.firstId !== undefined);
  const anchorIndex =
    initialized && !window.all ? items.findIndex((item) => item.id === window.firstId) : -1;
  const hidden =
    initialized && window.all
      ? 0
      : anchorIndex >= 0
        ? anchorIndex
        : Math.max(0, items.length - PAGE_SIZE);
  const prepend = useRef<{ scope: string; top: number; height: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const before = prepend.current;
    prepend.current = undefined;
    if (before?.scope === scope && listRef.current) {
      listRef.current.scrollTop = before.top + listRef.current.scrollHeight - before.height;
    }
    // Even an empty, still-loading conversation is a real navigation. Otherwise
    // A -> empty B -> A would accidentally reuse A's previously expanded window.
    if (window.scope !== scope) {
      setWindow({
        scope,
        all: !loading && items.length > 0 && hidden === 0,
        firstId: !loading && hidden ? items[hidden].id : undefined,
      });
      return;
    }
    // History may arrive in several batches. Pin the first visible ID only
    // when the initial recovery is complete; reconnect does not reset it.
    if (!loading && items.length && (!initialized || (!window.all && anchorIndex < 0))) {
      setWindow({ scope, all: hidden === 0, firstId: hidden ? items[hidden].id : undefined });
    }
  }, [items, scope, loading, hidden, initialized, anchorIndex, window.all, window.scope, listRef]);

  const showEarlier = useCallback(() => {
    if (!hidden) return;
    const list = listRef.current;
    pauseFollowing();
    if (list) prepend.current = { scope, top: list.scrollTop, height: list.scrollHeight };
    const next = Math.max(0, hidden - PAGE_SIZE);
    setWindow({ scope, all: next === 0, firstId: next ? items[next].id : undefined });
  }, [hidden, items, listRef, pauseFollowing, scope]);

  return { items: hidden ? items.slice(hidden) : items, hidden, showEarlier };
}
