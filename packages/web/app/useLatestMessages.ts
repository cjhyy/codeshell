import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatItem } from "../src/lib/streamReducer.js";

function visibleOutput(item: ChatItem): boolean {
  return (
    item.kind !== "user" &&
    !(item.kind === "assistant" && item.done && !item.text && !item.reasoning)
  );
}

/** Transport snapshots can recreate objects without adding visible output. */
export function outputChanged(previous: ChatItem | undefined, item: ChatItem): boolean {
  if (!visibleOutput(item) || previous === item) return false;
  if (!previous || previous.kind !== item.kind) return true;
  switch (item.kind) {
    case "user":
      return false;
    case "assistant":
      return (
        previous.kind === "assistant" &&
        (previous.text !== item.text ||
          previous.reasoning !== item.reasoning ||
          previous.done !== item.done)
      );
    case "tool":
      return (
        previous.kind === "tool" &&
        (previous.result !== item.result ||
          previous.summary !== item.summary ||
          previous.done !== item.done ||
          previous.error !== item.error ||
          JSON.stringify(previous.args) !== JSON.stringify(item.args))
      );
    case "subagent":
      return (
        previous.kind === "subagent" &&
        (previous.label !== item.label || previous.status !== item.status)
      );
    case "system":
    case "system_error":
      return (
        (previous.kind === "system" || previous.kind === "system_error") &&
        previous.text !== item.text
      );
  }
}

/** Follow the live tail until the reader scrolls up. Session changes and explicit
 * jumps resume following; reconnect/history hydration clear notices without
 * disturbing an older paragraph the reader has chosen to keep on screen. */
export function useLatestMessages({
  items,
  scope,
  connection,
  loading,
  active,
  approvalCount,
}: {
  items: ChatItem[];
  scope: string;
  connection: string;
  loading: boolean;
  active: boolean;
  approvalCount: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const programmaticTop = useRef<number | null>(null);
  const snappedSize = useRef<{ width: number; height: number } | null>(null);
  const previous = useRef(new Map<string, ChatItem>());
  const unread = useRef(new Set<string>());
  const identity = useRef({ scope, connection, loading, active });
  const [showJump, setShowJump] = useState(false);
  const [newOutputCount, setNewOutputCount] = useState(0);
  const clearNotices = useCallback(() => {
    unread.current.clear();
    setNewOutputCount(0);
  }, []);
  const snap = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    programmaticTop.current = list.scrollTop;
    snappedSize.current = { width: list.clientWidth, height: list.clientHeight };
  }, []);
  const resume = useCallback(() => {
    following.current = true;
    clearNotices();
    setShowJump(false);
    snap();
  }, [clearNotices, snap]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || !active) return;
    const size = snappedSize.current;
    // Viewport/composer reflow can dispatch scroll before ResizeObserver. Keep
    // an existing follow decision through that layout event, then measure anew.
    if (
      following.current &&
      size &&
      (size.width !== list.clientWidth || size.height !== list.clientHeight)
    ) {
      snap();
      setShowJump(false);
      return;
    }
    const near = list.scrollHeight - list.scrollTop - list.clientHeight <= 100;
    // A bottom snap dispatches its scroll event after more content may arrive.
    // Do not mistake that delayed event for the reader leaving the live tail.
    if (
      programmaticTop.current !== null &&
      Math.abs(list.scrollTop - programmaticTop.current) <= 2
    ) {
      programmaticTop.current = null;
      setShowJump(!near && !following.current);
      return;
    }
    programmaticTop.current = null;
    following.current = near;
    setShowJump(!near);
    if (near) clearNotices();
  }, [active, clearNotices, snap]);

  useLayoutEffect(() => {
    const before = identity.current;
    const changedScope = before.scope !== scope;
    const reset =
      changedScope ||
      before.connection !== connection ||
      before.loading !== loading ||
      before.active !== active;
    identity.current = { scope, connection, loading, active };
    const next = new Map(items.filter(visibleOutput).map((item) => [item.id, item]));
    if (reset) {
      clearNotices();
      if (changedScope) {
        following.current = true;
        programmaticTop.current = null;
        setShowJump(false);
      }
    } else if (active && connection === "open" && !loading && !following.current) {
      for (const item of items) {
        if (outputChanged(previous.current.get(item.id), item)) unread.current.add(item.id);
      }
      for (const id of unread.current) if (!next.has(id)) unread.current.delete(id);
      setNewOutputCount(unread.current.size);
    }
    previous.current = next;
    if (active && following.current) snap();
  }, [items, scope, connection, loading, active, approvalCount, clearNotices, snap]);

  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!active || !list || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) snap();
      else if (list.scrollHeight - list.scrollTop - list.clientHeight <= 100) resume();
      else setShowJump(true);
    });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, resume, snap]);

  const jumpToLatest = useCallback(() => {
    resume();
    listRef.current?.focus({ preventScroll: true });
  }, [resume]);
  return { listRef, contentRef, onScroll, showJump, newOutputCount, jumpToLatest, resume };
}
