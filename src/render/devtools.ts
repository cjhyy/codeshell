/**
 * Render devtools — opt-in perf counters.
 *
 * Activated by env:
 *   CODESHELL_RENDER_DEBUG=1        -> 1s summary lines
 *   CODESHELL_RENDER_DEBUG=verbose  -> per-frame lines
 *
 * Output: `~/.code-shell/logs/ui-ink/render-perf.log` (append). One JSON line
 * per emission.
 *
 * Frame stats are sourced from `FrameEvent.phases` (see frame.ts). Mapping:
 *   - dirtyNodes  := phases.yogaVisited
 *   - patches     := phases.patches  (proxy for "cells written"; pre-optimize)
 *   - cacheHitRatio := phases.yogaCacheHits / max(1, phases.yogaVisited)
 *   - yogaLive    := phases.yogaLive  (cumulative live yoga nodes; growth = leak)
 *
 * Note: "blit ratio" / "cells reused" from spec §6.1 has no direct FrameEvent
 * field. `yogaCacheHits / yogaVisited` is the closest available proxy — it
 * measures the single-slot layout cache hit rate, not a screen-buffer blit
 * ratio. True blit ratio would require a deeper hook into render-node-to-output.
 *
 * "scroll hints" from spec §6.1 is not available via FrameEvent (it lives in
 * the Frame struct, not the FrameEvent). This counter is omitted.
 *
 * This module does NOT replace `src/ui/perf-probes.ts` (which aggregates the
 * same FrameEvent into the shared ui-ink log via the logger). It writes to a
 * dedicated file so render-only investigations don't have to grep the noisier
 * ui-ink bucket.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FrameEvent } from "./frame.js";

type Mode = "off" | "summary" | "verbose";

function detectMode(): Mode {
  const v = process.env.CODESHELL_RENDER_DEBUG;
  if (!v) return "off";
  if (v === "verbose") return "verbose";
  return "summary";
}

const MODE: Mode = detectMode();

interface FrameSample {
  durMs: number;
  dirtyNodes: number;
  patches: number;
  yogaCacheHits: number;
  yogaLive: number;
}

let stream: WriteStream | null = null;
function getStream(): WriteStream | null {
  if (MODE === "off") return null;
  if (stream) return stream;
  const dir = join(homedir(), ".code-shell", "logs", "ui-ink");
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, "render-perf.log"), { flags: "a" });
  } catch {
    return null;
  }
  return stream;
}

const frameBuf: FrameSample[] = [];
let windowStart = Date.now();

export function recordFrame(event: FrameEvent): void {
  if (MODE === "off") return;
  const p = event.phases;
  if (!p) return; // phases optional; skip if not populated
  // Reset the window start time on the first sample after idle so that
  // windowMs reflects the actual observation window, not the wall-clock gap
  // since module load or last flush (which could be minutes).
  if (frameBuf.length === 0) {
    windowStart = Date.now();
  }
  const s: FrameSample = {
    durMs: event.durationMs,
    dirtyNodes: p.yogaVisited,
    patches: p.patches,
    yogaCacheHits: p.yogaCacheHits,
    yogaLive: p.yogaLive,
  };
  if (MODE === "verbose") {
    write({ t: Date.now(), kind: "frame", ...s });
    return;
  }
  frameBuf.push(s);
  const now = Date.now();
  if (now - windowStart >= 1000) {
    flushSummary(now);
  }
}

function flushSummary(now: number) {
  if (frameBuf.length === 0) {
    windowStart = now;
    return;
  }
  const sum = frameBuf.reduce(
    (a, b) => ({
      durMs: a.durMs + b.durMs,
      dirtyNodes: a.dirtyNodes + b.dirtyNodes,
      patches: a.patches + b.patches,
      yogaCacheHits: a.yogaCacheHits + b.yogaCacheHits,
      yogaLive: Math.max(a.yogaLive, b.yogaLive),
    }),
    { durMs: 0, dirtyNodes: 0, patches: 0, yogaCacheHits: 0, yogaLive: 0 },
  );
  const frames = frameBuf.length;
  const cacheRatio = sum.dirtyNodes === 0 ? 0 : sum.yogaCacheHits / sum.dirtyNodes;
  write({
    t: now,
    kind: "summary",
    windowMs: now - windowStart,
    frames,
    avgFrameMs: Number((sum.durMs / frames).toFixed(2)),
    dirtyNodes: sum.dirtyNodes,
    patches: sum.patches,
    cacheHitRatio: Number(cacheRatio.toFixed(3)),
    yogaLive: sum.yogaLive,
  });
  frameBuf.length = 0;
  windowStart = now;
}

function write(obj: Record<string, unknown>): void {
  const s = getStream();
  if (!s) return;
  s.write(JSON.stringify(obj) + "\n");
}

export const renderDevtools = {
  enabled: MODE !== "off",
  mode: MODE,
  recordFrame,
};
