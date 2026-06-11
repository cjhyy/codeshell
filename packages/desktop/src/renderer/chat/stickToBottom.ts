import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Stick-to-bottom for a scrollable container. Auto-scrolls only if
 * the user is already within `threshold` px of the bottom. Once they
 * scroll up, auto-scroll pauses until they return to the bottom.
 *
 * `jumpKey` forces an UNCONDITIONAL, instant snap to the bottom when it
 * changes (e.g. on session switch) — regardless of the stuck state — and does
 * it in a layout effect (before paint) so the new conversation appears already
 * at the bottom instead of visibly scrolling down from the top.
 *
 * Returns a ref to attach to the scroll container.
 */
export function useStickToBottom<T extends HTMLElement>(
  trigger: unknown,
  threshold = 32,
  jumpKey?: unknown,
) {
  const ref = useRef<T>(null);
  const stickRef = useRef(true);

  // Track manual scroll: stick when at bottom, release when above.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
      stickRef.current = distance <= threshold;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [threshold]);

  // Session switch (jumpKey change): snap to the bottom before paint, no
  // animation, no intermediate frame. Re-arm stick so subsequent streaming
  // keeps following. Layout effect (not effect) is what avoids the "scroll
  // down from the top" flash the user sees on switch.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpKey]);

  // Auto-scroll when content changes — but only if we're stuck.
  useEffect(() => {
    const el = ref.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [trigger]);

  return ref;
}
