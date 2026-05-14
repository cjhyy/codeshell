/**
 * StatusLine — compact bottom status bar matching Claude Code's style.
 *
 * Layout: [running indicator] model · context bar % · $cost
 *
 * Manages its own 1s interval so the parent App doesn't re-render.
 */
import React, { useState, useEffect, type MutableRefObject } from "react";
import { Box, Text } from "../../render/index.js";
import { logger } from "../../logging/logger.js";
import { recordUIEvent } from "../../logging/session-recorder.js";

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
  useEffect(() => {
    if (!isRunning) {
      setTick(0);
      return;
    }
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);
  void tick;

  const elapsed =
    isRunning && runStartRef ? Math.floor((Date.now() - runStartRef.current) / 1000) : 0;
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
