/**
 * Toggleable renderer performance instrumentation.
 *
 * ON by default — hot-path timings are logged to the engine log
 * (window.codeshell.log) under the `perf.*` keys so they land in
 * ~/.code-shell/logs and can be queried with scripts/logs.sh, no manual
 * opt-in. Turn it off with `localStorage.setItem("cs:perf","0")` then reload,
 * or `window.csPerf(false)`. Only timings above a small threshold are logged
 * (see timePhase minMs), so steady-state noise stays low.
 *
 * Designed for near-zero overhead: `perfEnabled` is read once at module load,
 * and when off `timePhase()` short-circuits to calling the fn directly with no
 * timing or allocation. Keep the call sites cheap — wrap whole phases (a
 * reducer batch, one MessageStream build), not individual array ops.
 */

let perfEnabled = true;
try {
  // Default on; only an explicit "0" disables it.
  perfEnabled = localStorage.getItem("cs:perf") !== "0";
} catch {
  // localStorage may be unavailable in some test/headless contexts; keep on.
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

/** Per-label rolling stats. Flushed as a `perf.<label>.summary` line so a
 *  session ALWAYS produces output while active — even when every phase is
 *  fast. That removes the "no logs == is it broken or just fast?" ambiguity
 *  that made the first runs unreadable. */
interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
  maxExtra?: Record<string, unknown>;
  lastFlush: number;
}
const stats = new Map<string, Stat>();
const SUMMARY_EVERY_MS = 2000; // flush a per-label summary at most this often
const SPIKE_MS = 8; // individual phases slower than this are logged immediately

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function flushSummary(label: string, s: Stat, nowMs: number): void {
  try {
    window.codeshell?.log(`perf.${label}.summary`, {
      n: s.count,
      avgMs: round(s.totalMs / Math.max(1, s.count)),
      maxMs: round(s.maxMs),
      ...(s.maxExtra ?? {}),
    });
  } catch {
    /* never throw into the hot path */
  }
  s.count = 0;
  s.totalMs = 0;
  s.maxMs = 0;
  s.maxExtra = undefined;
  s.lastFlush = nowMs;
}

/**
 * Time a synchronous phase. When perf is off this is just `fn()` with no
 * overhead. When on it (1) accumulates per-label stats flushed as a rolling
 * `perf.<label>.summary` every ~2s of activity — so you always see avg/max even
 * if nothing is slow — and (2) logs an immediate `perf.<label>` spike line for
 * any single phase over SPIKE_MS, so a real stall stands out at once.
 */
export function timePhase<T>(
  label: string,
  fn: () => T,
  extra?: () => Record<string, unknown>,
): T {
  if (!perfEnabled) return fn();
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  const now = t0 + ms;

  let s = stats.get(label);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, lastFlush: now };
    stats.set(label, s);
  }
  s.count += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) {
    s.maxMs = ms;
    s.maxExtra = extra ? extra() : undefined;
  }

  if (ms >= SPIKE_MS) {
    try {
      window.codeshell?.log(`perf.${label}`, {
        ms: round(ms),
        spike: true,
        ...(extra ? extra() : {}),
      });
    } catch {
      /* ignore */
    }
  }

  if (now - s.lastFlush >= SUMMARY_EVERY_MS) flushSummary(label, s, now);
  return out;
}

/** Feed a pre-measured duration into the same rolling-summary machinery as
 *  timePhase (for costs you can't wrap in a sync fn, e.g. a render→commit delta
 *  captured in a layout effect). Logs `perf.<label>.summary` every ~2s plus an
 *  immediate spike line over SPIKE_MS. */
export function perfSample(label: string, ms: number, extra?: Record<string, unknown>): void {
  if (!perfEnabled) return;
  const now = performance.now();
  let s = stats.get(label);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, lastFlush: now };
    stats.set(label, s);
  }
  s.count += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) {
    s.maxMs = ms;
    s.maxExtra = extra;
  }
  if (ms >= SPIKE_MS) {
    try {
      window.codeshell?.log(`perf.${label}`, { ms: round(ms), spike: true, ...(extra ?? {}) });
    } catch {
      /* ignore */
    }
  }
  if (now - s.lastFlush >= SUMMARY_EVERY_MS) flushSummary(label, s, now);
}

/** Count how often something happens (e.g. a component render), flushed as a
 *  rolling `perf.<label>.count` every ~2s. Use to catch a runaway re-render
 *  loop: if a component that should be idle shows hundreds of renders per
 *  window, something upstream is thrashing its props/state. Near-zero cost. */
const counters = new Map<string, { n: number; lastFlush: number }>();
export function perfCount(label: string): void {
  if (!perfEnabled) return;
  const now = performance.now();
  let c = counters.get(label);
  if (!c) {
    c = { n: 0, lastFlush: now };
    counters.set(label, c);
  }
  c.n += 1;
  if (now - c.lastFlush >= SUMMARY_EVERY_MS) {
    try {
      window.codeshell?.log(`perf.${label}.count`, { n: c.n, perSec: round(c.n / ((now - c.lastFlush) / 1000)) });
    } catch {
      /* ignore */
    }
    c.n = 0;
    c.lastFlush = now;
  }
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
