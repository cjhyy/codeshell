/**
 * Spinner — loading indicator with elapsed time and token count.
 *
 * Uses a 1-second interval instead of 80ms to avoid triggering
 * Ink's full re-render cycle too frequently, which causes scroll
 * position to jump back to the top of the terminal.
 */
import { useState, useEffect, useRef } from "react";
import { Text } from "../../render/index.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface SpinnerProps {
  label?: string;
  color?: string;
  showElapsed?: boolean;
  tokens?: number;
}

export function Spinner({ label, color = "cyan", showElapsed = true, tokens }: SpinnerProps) {
  const [tick, setTick] = useState(0);
  const startTime = useRef(Date.now());

  useEffect(() => {
    // Update once per second — fast enough for elapsed time,
    // slow enough to not cause scroll issues.
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const frame = FRAMES[tick % FRAMES.length];
  const elapsed = Math.floor((Date.now() - startTime.current) / 1000);
  const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : "";
  const tokenStr = tokens && tokens > 0 ? ` · ${formatTokens(tokens)}` : "";

  return (
    <Text>
      <Text color={color}>{frame}</Text>
      <Text> {label ?? "Working…"}</Text>
      {showElapsed && <Text dim>{elapsedStr}{tokenStr}</Text>}
    </Text>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M tokens";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K tokens";
  return `${n} tokens`;
}
