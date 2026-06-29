import { useEffect, useState } from "react";

/**
 * How long a browser panel may sit hidden before we evict its <webview> to
 * reclaim the renderer process. ~5 min mirrors Chrome's Memory Saver default:
 * long enough that a quick close→reopen keeps the live page, short enough that
 * a forgotten tab doesn't strand a process. Re-show reloads the url.
 */
const IDLE_EVICT_MS = 5 * 60 * 1000;

/**
 * Idle-eviction: returns `true` once the panel has been hidden past
 * IDLE_EVICT_MS. While evicted the caller unmounts the <webview> (its renderer
 * process freed); becoming visible again clears this and remounts WebviewHost,
 * reloading the tab url.
 */
export function useIdleEvict(visible: boolean): boolean {
  const [evicted, setEvicted] = useState(false);

  // Arm the idle-evict timer whenever the panel goes hidden; cancel + un-evict
  // the moment it's shown again. A visible panel is never evicted. Re-running on
  // `visible` flips means a quick close→reopen (< 5 min) clears the pending
  // timer before it fires, so the live page is preserved.
  useEffect(() => {
    if (visible) {
      setEvicted(false);
      return;
    }
    const timer = setTimeout(() => setEvicted(true), IDLE_EVICT_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  return evicted;
}
