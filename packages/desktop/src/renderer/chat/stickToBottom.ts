import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AnchoredLayoutChange } from "./TranscriptScrollContext";
import {
  nextFollowState,
  showJumpButton,
  INITIAL_FOLLOW_STATE,
  type FollowState,
} from "./followState";

export interface StickApi<T extends HTMLElement> {
  /** Attach to the scroll container. */
  ref: React.RefObject<T | null>;
  /** Viewport is within `threshold` px of the bottom (drives jump-button UI). */
  atBottom: boolean;
  /** Currently auto-following streaming content. */
  following: boolean;
  /** Whether to show the jump-to-bottom affordance. */
  showJump: boolean;
  /** Explicit "take me to now": re-arm follow + snap to bottom. */
  scrollToBottom: () => void;
  /** A deliberate disclosure is a reading action: pause follow and keep its header in place. */
  preserveScrollOnChange: AnchoredLayoutChange;
}

interface StickOptions {
  /**
   * Changes on every content mutation (message count, streaming tail length).
   * When following, the container snaps to the bottom on each change. A
   * ResizeObserver also handles pure height changes (e.g. `<pre>` → rendered
   * markdown) that don't move this key.
   */
  trigger: unknown;
  /**
   * Session identity. Changing it unconditionally snaps to the bottom before
   * paint (no scroll-from-top flash) and re-arms follow.
   */
  jumpKey?: unknown;
  /**
   * Monotonic counter bumped when the user sends a message. Changing it
   * unconditionally re-arms follow + snaps to bottom — kept SEPARATE from
   * jumpKey so a send never masquerades as a session switch (S4).
   */
  sendEpoch?: number;
  /** Distance (px) from bottom that still counts as "at bottom". */
  threshold?: number;
}

/**
 * Stick-to-bottom for a scrollable container, upgraded to an explicit
 * follow-state machine (see ./followState.ts). Auto-scrolls only while
 * following; the user scrolling up pauses it; sending / clicking jump /
 * switching session re-arms it.
 *
 * The high-frequency follow decision lives in a ref (no per-frame setState);
 * `atBottom`/`following` are mirrored to state only to drive the jump button.
 */
export function useStickToBottom<T extends HTMLElement>({
  trigger,
  jumpKey,
  sendEpoch,
  threshold = 32,
}: StickOptions): StickApi<T> {
  const ref = useRef<T>(null);
  // Authoritative, high-frequency follow decision. State below mirrors it for UI.
  const followRef = useRef<FollowState>(INITIAL_FOLLOW_STATE);
  const [uiState, setUiState] = useState<FollowState>(INITIAL_FOLLOW_STATE);
  // scrollTop we last set ourselves; lets onScroll reject its own snap (S2).
  const lastProgrammaticTopRef = useRef<number | null>(null);
  const readingAnchorRef = useRef<{ container: T; element: HTMLElement; top: number } | null>(null);

  const sync = useCallback((next: FollowState) => {
    followRef.current = next;
    // Only re-render when the UI-relevant projection actually changes.
    setUiState((prev) =>
      prev.following === next.following && prev.atBottom === next.atBottom ? prev : next,
    );
  }, []);

  const snapToBottom = useCallback((el: T) => {
    readingAnchorRef.current = null;
    el.scrollTop = el.scrollHeight;
    lastProgrammaticTopRef.current = el.scrollTop;
  }, []);

  const restoreReadingAnchor = useCallback((el: T) => {
    const anchor = readingAnchorRef.current;
    if (!anchor) return;
    if (anchor.container !== el || !el.contains(anchor.element) || followRef.current.following) {
      readingAnchorRef.current = null;
      return;
    }
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta;
      lastProgrammaticTopRef.current = el.scrollTop;
      // Accept unavoidable clamping when the remaining content is too short.
      anchor.top = anchor.element.getBoundingClientRect().top;
    }
  }, []);

  const measurePosition = useCallback(
    (el: T) => {
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
      sync({ following: followRef.current.following, atBottom: distance <= threshold });
    },
    [sync, threshold],
  );

  const preserveScrollOnChange = useCallback<AnchoredLayoutChange>(
    (anchor, change) => {
      const el = ref.current;
      if (!el || !el.contains(anchor)) {
        change();
        return;
      }
      const beforeTop = anchor.getBoundingClientRect().top;
      readingAnchorRef.current = { container: el, element: anchor, top: beforeTop };
      // This ref must change before React commits and ResizeObserver can run.
      sync({ following: false, atBottom: uiPosition(el, threshold) });
      lastProgrammaticTopRef.current = null;
      // Discrete user actions commit synchronously so no later restoration can
      // race a send, Session switch, or explicit jump-to-bottom request.
      flushSync(change);
      if (ref.current !== el || !el.contains(anchor) || followRef.current.following) return;
      restoreReadingAnchor(el);
      lastProgrammaticTopRef.current = el.scrollTop;
      measurePosition(el);
    },
    [measurePosition, restoreReadingAnchor, sync, threshold],
  );

  // (1) Manual scroll detection — via the pure reducer, rejecting our own snap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let userScrollUntil = 0;
    let draggingScrollbar = false;
    let primaryPointerDown = false;
    const noteUserScroll = () => {
      readingAnchorRef.current = null;
      lastProgrammaticTopRef.current = null;
      userScrollUntil = performance.now() + 1000;
    };
    const pauseForReading = () => sync({ following: false, atBottom: uiPosition(el, threshold) });
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      noteUserScroll();
      if (event.deltaY < 0) pauseForReading();
    };
    const onTouchMove = () => {
      noteUserScroll();
      pauseForReading();
    };
    const onPointerDown = (event: PointerEvent) => {
      readingAnchorRef.current = null;
      primaryPointerDown = event.button === 0 && event.isPrimary;
      // Native scrollbar interaction targets the scroll container itself.
      draggingScrollbar = event.target === el;
      if (draggingScrollbar) {
        noteUserScroll();
        pauseForReading();
      }
    };
    const onPointerUp = () => {
      if (draggingScrollbar) noteUserScroll();
      draggingScrollbar = false;
      primaryPointerDown = false;
    };
    const pauseForSelection = () => {
      const selection = window.getSelection();
      if (
        !primaryPointerDown ||
        !selection ||
        selection.isCollapsed ||
        !el.contains(selection.anchorNode) ||
        !el.contains(selection.focusNode)
      )
        return false;
      noteUserScroll();
      pauseForReading();
      return true;
    };
    const onPointerMove = () => {
      pauseForSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Keyboard focus navigation can scroll a link or button into view too.
      if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        noteUserScroll();
        pauseForReading();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable=false])",
        ) ||
        event.altKey ||
        ((event.ctrlKey || event.metaKey) &&
          !["Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) ||
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) ||
        (event.key === " " && target?.closest("button, a"))
      )
        return;
      noteUserScroll();
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        pauseForReading();
    };
    const onScroll = () => {
      // Dragging a selection beyond the viewport causes native auto-scroll.
      if (pauseForSelection()) {
        measurePosition(el);
        return;
      }
      // Chromium can scroll when its layout anchor moves or content shrinks.
      // Those events must not turn a paused reader back into an auto-follower.
      if (readingAnchorRef.current || (!draggingScrollbar && performance.now() > userScrollUntil)) {
        restoreReadingAnchor(el);
        measurePosition(el);
        return;
      }
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
      const { state } = nextFollowState(followRef.current, {
        kind: "scroll",
        distance,
        threshold,
        scrollTop: el.scrollTop,
        lastProgrammaticTop: lastProgrammaticTopRef.current,
      });
      sync(state);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [measurePosition, restoreReadingAnchor, threshold, sync]);

  // (2) Height changes (ResizeObserver): when following, stay pinned to the
  // bottom even if the key didn't move — e.g. streaming `<pre>` swapping to
  // rendered markdown changes height without changing the trigger (S3). Gated
  // by `following`, so it never fights a user who scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (followRef.current.following) snapToBottom(el);
      else restoreReadingAnchor(el);
      measurePosition(el);
    });
    // Observe the content wrapper (first child) so we react to content growth,
    // not just the fixed-height scroll container.
    const target = el.firstElementChild ?? el;
    ro.observe(target);
    return () => ro.disconnect();
  }, [measurePosition, restoreReadingAnchor, snapToBottom]);

  // (3) Session switch (jumpKey): unconditional snap before paint + re-arm.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    snapToBottom(el);
    sync({ following: true, atBottom: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpKey]);

  // (4) Send (sendEpoch): unconditional re-arm + snap. Separate dep from
  // jumpKey so a send is never treated as a session switch (S4). Skip the
  // initial mount (epoch 0 / undefined) so it doesn't double-fire with jumpKey.
  const sentOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (!sentOnceRef.current) {
      sentOnceRef.current = true;
      return;
    }
    const el = ref.current;
    if (!el) return;
    snapToBottom(el);
    sync({ following: true, atBottom: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendEpoch]);

  // (5) Content change (trigger): snap only while following.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (followRef.current.following) snapToBottom(el);
    else restoreReadingAnchor(el);
    measurePosition(el);
  }, [trigger, measurePosition, restoreReadingAnchor, snapToBottom]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    snapToBottom(el);
    sync({ following: true, atBottom: true });
  }, [snapToBottom, sync]);

  return {
    ref,
    atBottom: uiState.atBottom,
    following: uiState.following,
    showJump: showJumpButton(uiState),
    scrollToBottom,
    preserveScrollOnChange,
  };
}

function uiPosition(el: HTMLElement, threshold: number): boolean {
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= threshold;
}
