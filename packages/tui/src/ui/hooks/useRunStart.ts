import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * Start time of the current running period, read by the status line elapsed
 * clock and the final turn_duration. It restarts when running begins from
 * idle and when a foreground query starts or ends, but not when background
 * agents start or finish under an unchanged foreground query.
 */
export function useRunStart(
  isQueryActive: boolean,
  hasRunningBgAgents: boolean,
): MutableRefObject<number> {
  const runStartRef = useRef(0);
  const isRunning = isQueryActive || hasRunningBgAgents;
  useEffect(() => {
    if (isRunning) {
      runStartRef.current = Date.now();
    }
    // hasRunningBgAgents is deliberately not a dependency: it only matters
    // through isRunning (idle ↔ running).
  }, [isRunning, isQueryActive]);
  return runStartRef;
}
