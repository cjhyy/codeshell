/**
 * SpinnerWithVerb — animated spinner with random verbs, elapsed time, and token count.
 */
import { useState, useEffect, useRef, type MutableRefObject } from "react";
import { Box, Text } from "../../ink/index.js";

function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*'];
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
}

const SPINNER_VERBS = [
  'Thinking', 'Pondering', 'Crafting', 'Computing', 'Processing',
  'Generating', 'Brewing', 'Cooking', 'Simmering', 'Composing',
  'Architecting', 'Orchestrating', 'Synthesizing', 'Crystallizing',
  'Cogitating', 'Ruminating', 'Tinkering', 'Hatching', 'Forging',
  'Weaving', 'Channeling', 'Manifesting', 'Conjuring', 'Assembling',
];

const DEFAULT_CHARACTERS = getDefaultCharacters();
const FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

const TOOL_VERBS = [
  "Running tool",
  "Executing",
  "Processing",
  "Working",
];

export type SpinnerMode = "responding" | "tool-use" | "thinking";

interface SpinnerWithVerbProps {
  mode: SpinnerMode;
  streamingCharsRef?: MutableRefObject<number>;
  runStartRef?: MutableRefObject<number>;
  thinkingContent?: string;
}

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function SpinnerWithVerb({
  mode,
  streamingCharsRef,
  runStartRef,
  thinkingContent,
}: SpinnerWithVerbProps) {
  const [tick, setTick] = useState(0);
  const verbRef = useRef(pickRandom(SPINNER_VERBS));
  const lastVerbChangeRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(timer);
  }, []);

  // Change verb every ~8 seconds
  if (Date.now() - lastVerbChangeRef.current > 8000) {
    const verbs = mode === "tool-use" ? TOOL_VERBS : SPINNER_VERBS;
    verbRef.current = pickRandom(verbs);
    lastVerbChangeRef.current = Date.now();
  }

  const frame = FRAMES[tick % FRAMES.length];
  const elapsed = runStartRef
    ? Math.floor((Date.now() - runStartRef.current) / 1000)
    : 0;
  const tokens = streamingCharsRef
    ? Math.round(streamingCharsRef.current / 4)
    : 0;

  const verb = verbRef.current;
  const color = mode === "thinking" ? "ansi:magenta" : "ansi:cyan";

  return (
    <Box flexDirection="column" marginLeft={2} marginY={1}>
      <Box>
        <Text color={color}>{frame}</Text>
        <Text>{"  "}{verb}…</Text>
        {elapsed > 0 && <Text dim>{"  "}{elapsed}s</Text>}
        {tokens > 0 && <Text dim>{" · "}{formatTokens(tokens)}</Text>}
      </Box>
      {thinkingContent && (
        <Box marginLeft={4}>
          <Text dim italic>
            {truncateThinking(thinkingContent)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M tokens";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K tokens";
  return `${n} tokens`;
}

function truncateThinking(text: string): string {
  // Show last ~80 chars of thinking content
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > 80) return "…" + clean.slice(-79);
  return clean;
}
