/** Default idle threshold: two minutes without input means the owner stepped away. */
export const DEFAULT_PRESENCE_IDLE_SEC = 120;

export interface PresenceDetectorOptions {
  /** Seconds since the last system-wide input (Electron `powerMonitor.getSystemIdleTime`). */
  getSystemIdleTimeSec: () => number;
  /** True when a CodeShell window has focus (`BrowserWindow.getFocusedWindow() !== null`). */
  hasFocusedWindow: () => boolean;
  idleSec?: number;
}

export interface PresenceDetector {
  /** The owner is at this computer and looking at CodeShell. */
  isPresent(): boolean;
}

/**
 * Presence for notice routing: recently active AND a focused CodeShell
 * window. Any probe failure reads as "away", so a notice errs toward IM
 * rather than a desktop surface nobody is looking at.
 */
export function createPresenceDetector(options: PresenceDetectorOptions): PresenceDetector {
  const idleSec = options.idleSec ?? DEFAULT_PRESENCE_IDLE_SEC;
  return {
    isPresent(): boolean {
      try {
        const idle = options.getSystemIdleTimeSec();
        if (typeof idle !== "number" || !Number.isFinite(idle) || idle >= idleSec) return false;
        return options.hasFocusedWindow() === true;
      } catch {
        return false;
      }
    },
  };
}
