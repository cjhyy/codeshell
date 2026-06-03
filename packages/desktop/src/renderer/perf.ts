/**
 * Toggleable renderer performance instrumentation.
 *
 * Off by default — flip on in DevTools with `localStorage.setItem("cs:perf","1")`
 * then reload, or call `window.csPerf(true)`. When on, hot-path timings are
 * logged to the engine log (window.codeshell.log) under the `perf.*` keys so
 * they land in ~/.code-shell/logs and can be queried with scripts/logs.sh.
 *
 * Designed for near-zero overhead when off: `perfEnabled` is read once at
 * module load, and `time()` short-circuits to calling the fn directly with no
 * timing or allocation. Keep the call sites cheap — wrap whole phases (a
 * reducer batch, one MessageStream build), not individual array ops.
 */

let perfEnabled = false;
try {
  perfEnabled = localStorage.getItem("cs:perf") === "1";
} catch {
  // localStorage may be unavailable in some test/headless contexts; stay off.
}

/** Runtime toggle so you don't have to reload to flip it (next event picks it up). */
declare global {
  interface Window {
    csPerf?: (on?: boolean) => boolean;
  }
}
if (typeof window !== "undefined") {
  window.csPerf = (on?: boolean): boolean => {
    perfEnabled = on === undefined ? !perfEnabled : on;
    try {
      localStorage.setItem("cs:perf", perfEnabled ? "1" : "0");
    } catch {
      /* ignore */
    }
    return perfEnabled;
  };
}

export function perfOn(): boolean {
  return perfEnabled;
}

/**
 * Time a synchronous phase. When perf is off this is just `fn()` with no
 * overhead. When on, logs `perf.<label>` with elapsed ms (and any extra fields
 * the caller passes) only if it exceeds `minMs` — so we don't drown the log in
 * sub-millisecond noise.
 */
export function timePhase<T>(
  label: string,
  fn: () => T,
  extra?: () => Record<string, unknown>,
  minMs = 1,
): T {
  if (!perfEnabled) return fn();
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  if (ms >= minMs) {
    try {
      window.codeshell?.log(`perf.${label}`, {
        ms: Math.round(ms * 100) / 100,
        ...(extra ? extra() : {}),
      });
    } catch {
      /* logging must never throw into the hot path */
    }
  }
  return out;
}

/** Log a one-off perf marker with arbitrary fields (only when perf is on). */
export function perfMark(label: string, data: Record<string, unknown>): void {
  if (!perfEnabled) return;
  try {
    window.codeshell?.log(`perf.${label}`, data);
  } catch {
    /* ignore */
  }
}
