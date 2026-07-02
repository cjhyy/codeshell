import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

  const sync = useCallback((next: FollowState) => {
    followRef.current = next;
    // Only re-render when the UI-relevant projection actually changes.
    setUiState((prev) =>
      prev.following === next.following && prev.atBottom === next.atBottom ? prev : next,
    );
  }, []);

  const snapToBottom = useCallback((el: T) => {
    el.scrollTop = el.scrollHeight;
    lastProgrammaticTopRef.current = el.scrollTop;
  }, []);

  // (1) Manual scroll detection — via the pure reducer, rejecting our own snap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
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
    return () => el.removeEventListener("scroll", onScroll);
  }, [threshold, sync]);

  // (2) Height changes (ResizeObserver): when following, stay pinned to the
  // bottom even if the key didn't move — e.g. streaming `<pre>` swapping to
  // rendered markdown changes height without changing the trigger (S3). Gated
  // by `following`, so it never fights a user who scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (followRef.current.following) snapToBottom(el);
    });
    // Observe the content wrapper (first child) so we react to content growth,
    // not just the fixed-height scroll container.
    const target = el.firstElementChild ?? el;
    ro.observe(target);
    return () => ro.disconnect();
  }, [snapToBottom]);

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
    if (!el || !followRef.current.following) return;
    snapToBottom(el);
  }, [trigger, snapToBottom]);

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
  };
}
