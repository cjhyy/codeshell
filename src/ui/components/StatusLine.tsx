/**
 * StatusLine — compact bottom status bar matching Claude Code's style.
 *
 * Layout: [running indicator] model · context bar % · $cost
 *
 * Manages its own 1s interval so the parent App doesn't re-render.
 */
import React, { useState, useEffect, useRef, type MutableRefObject } from "react";
import { Box, Text } from "../../render/index.js";
import { logger } from "../../logging/logger.js";
import { recordUIEvent } from "../../logging/session-recorder.js";
import { PERF_ENABLED } from "../perf-probes.js";

// UI-scoped — routes to ui-ink-*.log.
const uiLog = logger.child({ cat: "ui" });

interface StatusLineProps {
  model: string;
  effort: string;
  tokens: number;
  cost: number;
  sessionId?: string;
  /**
   * Authoritative live context size. The engine emits `usage_update` at every
   * message-array mutation (post-tool-result, post-compact, post-LLM), so this
   * tracks the real prompt token count without UI-side accumulation.
   */
  baseContextTokens?: number;
  maxContextTokens?: number;
  gitBranch?: string;
  isRunning?: boolean;
  streamingTokensRef?: MutableRefObject<number>;
  runStartRef?: MutableRefObject<number>;
}

export function StatusLine({
  model,
  effort,
  tokens,
  cost,
  sessionId,
  baseContextTokens,
  maxContextTokens,
  gitBranch,
  isRunning,
  streamingTokensRef,
  runStartRef,
}: StatusLineProps) {
  const modelShort = shortModel(model);

  // Own 1s interval — only this component re-renders, not App
  const [tick, setTick] = useState(0);
  // Perf probe refs: track interval fires vs renders to detect when the
  // setInterval has died (or is firing but ink is dropping the repaint).
  const lastTickAtRef = useRef<number>(performance.now());
  const lastRenderAtRef = useRef<number>(performance.now());
  const tickFiredCountRef = useRef<number>(0);
  const renderCountRef = useRef<number>(0);

  useEffect(() => {
    if (PERF_ENABLED) {
      uiLog.info("debug.statusline.mount", { isRunning: !!isRunning });
    }
    return () => {
      if (PERF_ENABLED) uiLog.info("debug.statusline.unmount", {});
    };
  }, []);

  useEffect(() => {
    if (!isRunning) {
      setTick(0);
      if (PERF_ENABLED) {
        uiLog.info("debug.statusline.interval", { action: "skip_not_running" });
      }
      return;
    }
    if (PERF_ENABLED) {
      uiLog.info("debug.statusline.interval", { action: "start" });
    }
    const timer = setInterval(() => {
      const now = performance.now();
      const sinceLast = now - lastTickAtRef.current;
      lastTickAtRef.current = now;
      tickFiredCountRef.current++;
      if (PERF_ENABLED) {
        // Log every fire — only ~1Hz so volume is fine.
        uiLog.info("debug.statusline.tick_fire", {
          n: tickFiredCountRef.current,
          sinceLast_ms: Math.round(sinceLast),
          drift_ms: Math.round(sinceLast - 1000),
        });
      }
      setTick((t) => t + 1);
    }, 1000);
    return () => {
      if (PERF_ENABLED) {
        uiLog.info("debug.statusline.interval", { action: "clear" });
      }
      clearInterval(timer);
    };
  }, [isRunning]);
  void tick;

  // Render heartbeat — proves whether React is actually re-rendering this
  // component. If tick_fire keeps firing but render_beat stops, React is
  // batching us out. If render_beat fires but the screen looks frozen, ink
  // is dropping the patch.
  if (PERF_ENABLED && isRunning) {
    const now = performance.now();
    const sinceLastRender = now - lastRenderAtRef.current;
    lastRenderAtRef.current = now;
    renderCountRef.current++;
    // Only log every 5th render to avoid drowning during streams; pair with
    // tick_fire which is 1Hz to triangulate.
    if (renderCountRef.current % 5 === 0) {
      uiLog.info("debug.statusline.render_beat", {
        n: renderCountRef.current,
        sinceLast_ms: Math.round(sinceLastRender),
        tickState: tick,
        tickFires: tickFiredCountRef.current,
      });
    }
  }

  const elapsed =
    isRunning && runStartRef ? Math.floor((Date.now() - runStartRef.current) / 1000) : 0;
  // Probe: surface the raw inputs to elapsed so we can tell if runStartRef
  // was reset mid-turn (would explain a "frozen" looking timer).
  if (PERF_ENABLED && isRunning && renderCountRef.current % 10 === 0) {
    uiLog.info("debug.statusline.elapsed_inputs", {
      elapsed_s: elapsed,
      runStartRef: runStartRef?.current ?? 0,
      ageOfRunStart_ms: runStartRef ? Date.now() - runStartRef.current : 0,
    });
  }
  const streamingTokens =
    isRunning && streamingTokensRef ? streamingTokensRef.current : 0;
  void streamingTokens;

  // ctx bar reflects what the engine has actually built: usage_update events
  // are emitted after every mutation (tool result append, compact, LLM resp),
  // so this is the same number the context manager will use to decide on
  // compaction. No UI-side adders — those caused 750k phantom readings.
  const ctxPct =
    maxContextTokens && maxContextTokens > 0
      ? Math.min(((baseContextTokens ?? 0) / maxContextTokens) * 100, 100)
      : 0;

  useEffect(() => {
    const payload = {
      baseContextTokens: baseContextTokens ?? 0,
      maxContextTokens: maxContextTokens ?? 0,
      pct: Math.round(ctxPct),
    };
    uiLog.info("debug.ctx.render", payload);
    recordUIEvent(sessionId, "ui.ctx.render", payload);
  }, [baseContextTokens, maxContextTokens, ctxPct, sessionId]);
  const ctxColor = ctxPct > 80 ? "ansi:red" : ctxPct > 60 ? "ansi:yellow" : "ansi:green";

  // Context mini-bar (8 chars)
  const barWidth = 8;
  const filled = Math.round((ctxPct / 100) * barWidth);
  const ctxBar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  return (
    <Box>
      {/* Running indicator */}
      {isRunning && (
        <>
          <Text color="ansi:cyan">{"● "}</Text>
          <Text color="ansi:cyan">{formatElapsed(elapsed)}</Text>
          {streamingTokens > 0 && <Text dim> {formatNumber(streamingTokens)} tok</Text>}
          <Text dim> │ </Text>
        </>
      )}

      {/* Model — alt+m switches; only show hint when terminal has room */}
      <Text dim>{modelShort}</Text>
      {(process.stdout.columns ?? 80) >= 100 && <Text dim>{" (alt+m)"}</Text>}

      {/* Context bar */}
      <Text dim> │ </Text>
      <Text color={ctxColor}>{ctxBar}</Text>
      <Text dim> {ctxPct.toFixed(0)}% ctx</Text>

      {/* Cost */}
      {cost > 0 && (
        <>
          <Text dim> │ </Text>
          <Text color="ansi:green">${cost.toFixed(2)}</Text>
        </>
      )}

      {/* Git branch */}
      {gitBranch && (
        <>
          <Text dim> │ </Text>
          <Text color="ansi:magenta">{gitBranch}</Text>
        </>
      )}
    </Box>
  );
}

function shortModel(model: string): string {
  const name = model.split("/").pop() ?? model;
  // Keep it readable but compact
  return name
    .replace("claude-opus-4-6", "opus")
    .replace("claude-sonnet-4-6", "sonnet")
    .replace("claude-haiku-4-5", "haiku")
    .replace("claude-", "")
    .replace("gpt-4o", "4o")
    .replace("gpt-4", "gpt4");
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
