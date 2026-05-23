import { useEffect, useRef } from "react";

/**
 * Stick-to-bottom for a scrollable container. Auto-scrolls only if
 * the user is already within `threshold` px of the bottom. Once they
 * scroll up, auto-scroll pauses until they return to the bottom.
 *
 * Returns a ref to attach to the scroll container.
 */
export function useStickToBottom<T extends HTMLElement>(
  trigger: unknown,
  threshold = 32,
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

  // Auto-scroll when content changes — but only if we're stuck.
  useEffect(() => {
    const el = ref.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [trigger]);

  return ref;
}
