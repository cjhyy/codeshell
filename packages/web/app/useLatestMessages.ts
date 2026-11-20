import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatItem } from "../src/lib/streamReducer.js";

function visibleOutput(item: ChatItem): boolean {
  return (
    item.kind !== "user" &&
    !(
      item.kind === "assistant" &&
      item.done &&
      !item.text &&
      !item.reasoning &&
      !item.textDetailRef &&
      !item.reasoningDetailRef
    )
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
          previous.textDetailRef !== item.textDetailRef ||
          previous.reasoningDetailRef !== item.reasoningDetailRef ||
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
  const readingEarlier = useRef(false);
  const programmaticTop = useRef<number | null>(null);
  const snappedSize = useRef<{ width: number; height: number } | null>(null);
  // A press inside the list pins the pressed element in place and holds the
  // follow snap until its click is targeted.
  const pressed = useRef<{ target: Element; top: number } | null>(null);
  const heldSnap = useRef(false);
  const previous = useRef(new Map<string, ChatItem>());
  const unread = useRef(new Set<string>());
  const identity = useRef({ scope, connection, loading, active });
  const [showJump, setShowJump] = useState(false);
  const [newOutputCount, setNewOutputCount] = useState(0);
  const clearNotices = useCallback(() => {
    unread.current.clear();
    setNewOutputCount(0);
  }, []);
  /** Undo any shift of the pressed element, including the browser's own scroll
   * anchoring, which can keep the tail pinned while output is appended. */
  const pin = useCallback(() => {
    const list = listRef.current;
    const press = pressed.current;
    if (!list || !press?.target.isConnected) return;
    const shift = press.target.getBoundingClientRect().top - press.top;
    if (Math.abs(shift) < 0.5) return;
    list.scrollTop += shift;
    programmaticTop.current = list.scrollTop;
  }, []);
  const snap = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (pressed.current) {
      heldSnap.current = true;
      pin();
      return;
    }
    list.scrollTop = list.scrollHeight;
    programmaticTop.current = list.scrollTop;
    snappedSize.current = { width: list.clientWidth, height: list.clientHeight };
  }, [pin]);
  const resume = useCallback(() => {
    following.current = true;
    readingEarlier.current = false;
    clearNotices();
    setShowJump(false);
    snap();
  }, [clearNotices, snap]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || !active) return;
    // A press that turns into a drag is cancelled first, so any scroll seen
    // while it is held moved the content, not the finger.
    if (pressed.current) {
      pin();
      return;
    }
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
    // Restoring a history anchor also dispatches scroll. Even when that anchor
    // happens to be near the tail, keep it until the reader scrolls or jumps.
    if (readingEarlier.current) {
      setShowJump(!near);
      return;
    }
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
  }, [active, clearNotices, snap, pin]);

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
        readingEarlier.current = false;
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
    else if (active) pin();
  }, [items, scope, connection, loading, active, approvalCount, clearNotices, snap, pin]);

  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!active || !list || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      pin();
      if (following.current) snap();
      else if (
        !readingEarlier.current &&
        list.scrollHeight - list.scrollTop - list.clientHeight <= 100
      )
        resume();
      else setShowJump(true);
    });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, resume, snap, pin]);

  // Chromium hit-tests a tap's click after touchend, so output or layout that
  // lands while the finger is down would slide another row under it. Release
  // when that click is dispatched (capture runs before its handlers), or
  // shortly after a lift that produced none, then catch up if still following.
  useEffect(() => {
    const list = listRef.current;
    if (!active || !list) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      clearTimeout(timer);
      if (!pressed.current) return;
      pressed.current = null;
      list.style.removeProperty("overflow-anchor");
      if (heldSnap.current && following.current) snap();
      heldSnap.current = false;
    };
    const press = (event: PointerEvent) => {
      // A mouse click targets the common ancestor of press and release, and a
      // held button may be selecting text that the browser auto-scrolls.
      if (event.pointerType === "mouse") return;
      clearTimeout(timer);
      const target = event.target instanceof Element ? event.target : list;
      pressed.current = { target, top: target.getBoundingClientRect().top };
      // Native anchoring adjusts after this hook's layout reads; pin instead.
      list.style.overflowAnchor = "none";
    };
    const lift = () => {
      clearTimeout(timer);
      if (pressed.current) timer = setTimeout(release, 400);
    };
    list.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", lift, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("click", release, true);
    return () => {
      list.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", lift, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("click", release, true);
      clearTimeout(timer);
      pressed.current = null;
      heldSnap.current = false;
      list.style.removeProperty("overflow-anchor");
    };
  }, [active, snap]);

  const jumpToLatest = useCallback(() => {
    resume();
    listRef.current?.focus({ preventScroll: true });
  }, [resume]);
  const pauseFollowing = useCallback(() => {
    following.current = false;
    readingEarlier.current = true;
    programmaticTop.current = null;
    setShowJump(true);
  }, []);
  const onScrollIntent = useCallback(() => {
    readingEarlier.current = false;
    programmaticTop.current = null;
  }, []);
  return {
    listRef,
    contentRef,
    onScroll,
    onScrollIntent,
    showJump,
    newOutputCount,
    jumpToLatest,
    resume,
    pauseFollowing,
  };
}
