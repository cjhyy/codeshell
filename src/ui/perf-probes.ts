/**
 * UI perf probes — diagnostic logging for "spinner frozen / UI stuck" bugs.
 *
 * Five independent probes, all routed to ui-ink-*.log via cat:"ui":
 *   1. StatusLine tick heartbeat (in StatusLine.tsx)
 *   2. Ink frame timing (subscribed via render onFrame in ui/index.tsx)
 *   3. Event-loop delay sampler (startEventLoopMonitor)
 *   4. Stream event rate aggregator (recordStreamEvent + reporter)
 *   5. App re-render counter (recordAppRender + reporter)
 *
 * Toggle with CODESHELL_UI_PERF=0 to silence. Default on; volume is bounded
 * by 1s aggregation windows so the ui-ink bucket doesn't drown.
 */
import { logger } from "../logging/logger.js";

const uiLog = logger.child({ cat: "ui" });

// Off by default — these probes are for developer debugging of UI stalls
// ("frozen spinner", dropped frames). End users would just see extra noise
// in ~/.code-shell/logs/ui-ink-*.log. Set CODESHELL_UI_PERF=1 to enable.
export const PERF_ENABLED = process.env.CODESHELL_UI_PERF === "1";

// ─── 3. Event-loop delay sampler ──────────────────────────────────
//
// setImmediate fires after I/O; the gap between scheduling and firing is a
// proxy for how long the event loop was busy with sync work. Anything over
// ~50ms means a frame was dropped.

let eventLoopMonitorTimer: ReturnType<typeof setInterval> | null = null;

export function startEventLoopMonitor(intervalMs = 250, warnThresholdMs = 50): void {
  if (!PERF_ENABLED || eventLoopMonitorTimer) return;
  eventLoopMonitorTimer = setInterval(() => {
    const scheduled = performance.now();
    setImmediate(() => {
      const lag = performance.now() - scheduled;
      if (lag > warnThresholdMs) {
        uiLog.info("debug.ui.eventloop_lag", { lag_ms: Math.round(lag) });
      }
    });
  }, intervalMs);
  eventLoopMonitorTimer.unref?.();
}

export function stopEventLoopMonitor(): void {
  if (eventLoopMonitorTimer) {
    clearInterval(eventLoopMonitorTimer);
    eventLoopMonitorTimer = null;
  }
}

// ─── 4. Stream event rate aggregator ──────────────────────────────
//
// Per-call logging at stream-event sites is already in place (debug.stream.event).
// This adds a 1s rolling aggregation so we can see bursts without grepping
// thousands of lines.

interface StreamBucket {
  count: number;
  byAgent: Map<string, number>;
  byType: Map<string, number>;
  firstAt: number;
}

let streamBucket: StreamBucket | null = null;
let streamReporter: ReturnType<typeof setInterval> | null = null;

export function recordStreamEvent(type: string, agentId: string | undefined): void {
  if (!PERF_ENABLED) return;
  const now = performance.now();
  if (!streamBucket) {
    streamBucket = { count: 0, byAgent: new Map(), byType: new Map(), firstAt: now };
  }
  streamBucket.count++;
  const a = agentId ?? "(main)";
  streamBucket.byAgent.set(a, (streamBucket.byAgent.get(a) ?? 0) + 1);
  streamBucket.byType.set(type, (streamBucket.byType.get(type) ?? 0) + 1);
}

export function startStreamRateReporter(windowMs = 1000): void {
  if (!PERF_ENABLED || streamReporter) return;
  streamReporter = setInterval(() => {
    if (!streamBucket || streamBucket.count === 0) return;
    const elapsed = performance.now() - streamBucket.firstAt;
    uiLog.info("debug.ui.stream_rate", {
      count: streamBucket.count,
      window_ms: Math.round(elapsed),
      rate_per_s: Math.round((streamBucket.count * 1000) / Math.max(elapsed, 1)),
      byAgent: Object.fromEntries(streamBucket.byAgent),
      byType: Object.fromEntries(streamBucket.byType),
    });
    streamBucket = null;
  }, windowMs);
  streamReporter.unref?.();
}

export function stopStreamRateReporter(): void {
  if (streamReporter) {
    clearInterval(streamReporter);
    streamReporter = null;
  }
}

// ─── 5. App re-render counter ─────────────────────────────────────
//
// Increment from inside App's body (every render). A 1s reporter emits the
// count + peak interval so we can correlate re-render storms with frozen UI.

let appRenderCount = 0;
let appRenderWindowStart = performance.now();
let appLastRenderAt = performance.now();
let appMaxIntervalMs = 0;
let appMinIntervalMs = Infinity;
let appRenderReporter: ReturnType<typeof setInterval> | null = null;

export function recordAppRender(): void {
  if (!PERF_ENABLED) return;
  const now = performance.now();
  const dt = now - appLastRenderAt;
  if (dt > appMaxIntervalMs) appMaxIntervalMs = dt;
  if (dt < appMinIntervalMs) appMinIntervalMs = dt;
  appLastRenderAt = now;
  appRenderCount++;
}

export function startAppRenderReporter(windowMs = 1000): void {
  if (!PERF_ENABLED || appRenderReporter) return;
  appRenderReporter = setInterval(() => {
    const now = performance.now();
    const elapsed = now - appRenderWindowStart;
    if (appRenderCount > 0) {
      uiLog.info("debug.ui.app_renders", {
        count: appRenderCount,
        window_ms: Math.round(elapsed),
        rate_per_s: Math.round((appRenderCount * 1000) / Math.max(elapsed, 1)),
        maxInterval_ms: Math.round(appMaxIntervalMs),
        minInterval_ms: appMinIntervalMs === Infinity ? null : Math.round(appMinIntervalMs),
      });
    }
    appRenderCount = 0;
    appMaxIntervalMs = 0;
    appMinIntervalMs = Infinity;
    appRenderWindowStart = now;
  }, windowMs);
  appRenderReporter.unref?.();
}

export function stopAppRenderReporter(): void {
  if (appRenderReporter) {
    clearInterval(appRenderReporter);
    appRenderReporter = null;
  }
}

// ─── 2. Ink frame aggregator (subscribed via render onFrame) ──────
//
// onFrame fires once per ink commit. We aggregate per-second and emit a
// summary: frames, total/diff/write/yoga time, max single-frame duration,
// max gap between consecutive frames (= how long the screen sat still).

interface FrameBucket {
  count: number;
  totalDuration: number;
  maxDuration: number;
  totalDiff: number;
  totalWrite: number;
  totalYoga: number;
  totalPatches: number;
  firstAt: number;
  lastAt: number;
  maxGap: number;
}

let frameBucket: FrameBucket | null = null;
let frameReporter: ReturnType<typeof setInterval> | null = null;

export function recordInkFrame(event: {
  durationMs: number;
  phases: { diff: number; write: number; yoga: number; patches: number };
}): void {
  if (!PERF_ENABLED) return;
  const now = performance.now();
  if (!frameBucket) {
    frameBucket = {
      count: 0,
      totalDuration: 0,
      maxDuration: 0,
      totalDiff: 0,
      totalWrite: 0,
      totalYoga: 0,
      totalPatches: 0,
      firstAt: now,
      lastAt: now,
      maxGap: 0,
    };
  } else {
    const gap = now - frameBucket.lastAt;
    if (gap > frameBucket.maxGap) frameBucket.maxGap = gap;
  }
  frameBucket.count++;
  frameBucket.totalDuration += event.durationMs;
  if (event.durationMs > frameBucket.maxDuration) frameBucket.maxDuration = event.durationMs;
  frameBucket.totalDiff += event.phases.diff;
  frameBucket.totalWrite += event.phases.write;
  frameBucket.totalYoga += event.phases.yoga;
  frameBucket.totalPatches += event.phases.patches;
  frameBucket.lastAt = now;
}

export function startInkFrameReporter(windowMs = 1000): void {
  if (!PERF_ENABLED || frameReporter) return;
  frameReporter = setInterval(() => {
    if (!frameBucket || frameBucket.count === 0) return;
    const c = frameBucket.count;
    uiLog.info("debug.ui.ink_frames", {
      count: c,
      window_ms: Math.round(performance.now() - frameBucket.firstAt),
      avgDuration_ms: Math.round(frameBucket.totalDuration / c),
      maxDuration_ms: Math.round(frameBucket.maxDuration),
      maxGap_ms: Math.round(frameBucket.maxGap),
      avgDiff_ms: Math.round(frameBucket.totalDiff / c),
      avgWrite_ms: Math.round(frameBucket.totalWrite / c),
      avgYoga_ms: Math.round(frameBucket.totalYoga / c),
      totalPatches: frameBucket.totalPatches,
    });
    frameBucket = null;
  }, windowMs);
  frameReporter.unref?.();
}

export function stopInkFrameReporter(): void {
  if (frameReporter) {
    clearInterval(frameReporter);
    frameReporter = null;
  }
}

// ─── Master start/stop ────────────────────────────────────────────

export function startAllPerfProbes(): void {
  if (!PERF_ENABLED) return;
  startEventLoopMonitor();
  startStreamRateReporter();
  startAppRenderReporter();
  startInkFrameReporter();
  uiLog.info("debug.ui.perf_start", {
    enabled: true,
    probes: ["eventloop", "stream_rate", "app_renders", "ink_frames", "statusline_tick"],
  });
}

export function stopAllPerfProbes(): void {
  stopEventLoopMonitor();
  stopStreamRateReporter();
  stopAppRenderReporter();
  stopInkFrameReporter();
}
