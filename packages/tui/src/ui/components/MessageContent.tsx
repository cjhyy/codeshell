/**
 * MessageContent — renders assistant text with markdown, tables, and syntax highlighting.
 *
 * Features (aligned with Claude Code):
 * - LRU token cache (500 entries) for repeated renders
 * - Fast-path: skips markdown parsing for plain text
 * - Table rendering as React flexbox components
 * - Streaming text shown as plain text with cursor
 */
import { memo, useMemo, useRef, type ReactNode } from "react";
import { Ansi, Box, Text, useStdout } from "../../render/index.js";
import { stringWidth } from "../../render/stringWidth.js";
import chalk from "chalk";
import { Marked, lexer as markedLexer } from "marked";
import { markedTerminal } from "marked-terminal";
import { logger } from "@cjhyy/code-shell-core";

const streamLog = logger.child({ cat: "stream-md" });

// ─── LRU Token Cache ────────────────────────────────────────────

const TOKEN_CACHE_MAX = 500;
const renderCache = new Map<string, string>();
const DEFAULT_MARKDOWN_WIDTH = 80;

// Hit/miss counters surfaced via the streaming diag log. Reset by
// StreamingMarkdown on each render so flush-aligned numbers show only
// the work attributable to that delta. Module-level so renderHybrid's
// internal cachedRender calls also contribute.
const cacheStats = { hits: 0, misses: 0, missMs: 0 };
// Opt-in streaming diagnostics. Rendering sits on a hot path, so normal
// sessions keep counters and parse timing off unless explicitly requested.
const STREAM_DIAG_ON = process.env.CODESHELL_DEBUG_STREAM === "1";

function normalizeMarkdownWidth(width: number | undefined): number {
  const raw =
    typeof width === "number" && Number.isFinite(width)
      ? Math.floor(width)
      : DEFAULT_MARKDOWN_WIDTH;
  return Math.max(1, Math.min(raw, 100));
}

function cacheKey(text: string, width: number): string {
  return `${width}\0${text}`;
}

function cachedRender(
  text: string,
  width: number,
  renderFn: (t: string, width: number) => string,
): string {
  const key = cacheKey(text, width);
  const cached = renderCache.get(key);
  if (cached !== undefined) {
    // MRU promotion: delete + re-insert moves to end
    renderCache.delete(key);
    renderCache.set(key, cached);
    if (STREAM_DIAG_ON) cacheStats.hits += 1;
    return cached;
  }
  const t0 = STREAM_DIAG_ON ? performance.now() : 0;
  const result = renderFn(text, width);
  if (STREAM_DIAG_ON) {
    cacheStats.misses += 1;
    cacheStats.missMs += performance.now() - t0;
  }
  if (renderCache.size >= TOKEN_CACHE_MAX) {
    // Evict oldest (first) entry
    const first = renderCache.keys().next().value;
    if (first !== undefined) renderCache.delete(first);
  }
  renderCache.set(key, result);
  return result;
}

// ─── Fast-path: detect if text contains markdown syntax ─────────

const MD_SYNTAX_RE = /[*_`~#\[|\->!]|^\s{0,3}\d+\.\s/m;

function hasMarkdownSyntax(text: string): boolean {
  return MD_SYNTAX_RE.test(text);
}

// ─── Marked instance ────────────────────────────────────────────

// Force chalk to output ANSI colors regardless of TTY detection.
// chalk v5 ESM singleton — setting level here affects marked-terminal's
// internal usage of the same chalk instance.
if (!chalk.level) {
  chalk.level = 3; // truecolor — ensure ANSI output for marked-terminal
}

const markedInstances = new Map<number, Marked>();
let markedInitFailed = false;

function getMarkedInstance(width: number): Marked | null {
  const markdownWidth = normalizeMarkdownWidth(width);
  const existing = markedInstances.get(markdownWidth);
  if (existing) return existing;
  if (markedInitFailed) return null;
  try {
    const instance = new Marked(
      markedTerminal({
        showSectionPrefix: false,
        width: markdownWidth,
        reflowText: true,
        tab: 2,
        emoji: false,
      }) as any,
    );
    markedInstances.set(markdownWidth, instance);
    return instance;
  } catch {
    markedInitFailed = true;
    return null;
  }
}

function renderMarkdown(text: string, width: number): string {
  const instance = getMarkedInstance(width);
  if (!instance) return text;
  try {
    const result = instance.parse(text, { async: false }) as string;
    return result.replace(/\n+$/, "");
  } catch {
    return text;
  }
}

export function __resetMarkdownRenderCacheForTest(): void {
  renderCache.clear();
  markedInstances.clear();
  markedInitFailed = false;
}

export function __renderMarkdownForTest(text: string, width: number): string {
  const markdownWidth = normalizeMarkdownWidth(width);
  return cachedRender(text, markdownWidth, renderMarkdown);
}

// ─── Table extraction & rendering ───────────────────────────────

const TABLE_RE = /^\|.+\|$/gm;
const TABLE_SEP_RE = /^\|\s*[-:]+[-|\s:]*\|$/m;

export interface TableData {
  headers: string[];
  rows: string[][];
}

const DEFAULT_TERMINAL_WIDTH = 80;
const MESSAGE_CONTENT_MARGIN_LEFT = 1;
const TABLE_MARGIN_LEFT = 1;
const TABLE_COLUMN_PADDING = 2;
const TABLE_MAX_COLUMN_WIDTH = 40;
const TABLE_MIN_COLUMN_WIDTH = 6;

function extractTable(text: string): { before: string; table: TableData; after: string } | null {
  const lines = text.split("\n");
  let tableStart = -1;
  let tableEnd = -1;
  let sepLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      if (tableStart === -1) tableStart = i;
      if (TABLE_SEP_RE.test(line)) sepLine = i;
      tableEnd = i;
    } else if (tableStart !== -1) {
      break;
    }
  }

  if (tableStart === -1 || sepLine === -1 || tableEnd - tableStart < 2) return null;

  const parseRow = (line: string): string[] =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

  const headers = parseRow(lines[tableStart]);
  const rows: string[][] = [];
  for (let i = sepLine + 1; i <= tableEnd; i++) {
    rows.push(parseRow(lines[i]));
  }

  return {
    before: lines.slice(0, tableStart).join("\n"),
    table: { headers, rows },
    after: lines.slice(tableEnd + 1).join("\n"),
  };
}

function sumWidths(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

export function calculateMarkdownTableColumnWidths(
  data: TableData,
  availableWidth: number,
): number[] {
  const columnCount = data.headers.length;
  if (columnCount === 0) return [];

  const widthBudget = Math.max(0, Math.floor(availableWidth));
  if (widthBudget === 0) return data.headers.map(() => 0);

  const preferredWidths = data.headers.map((header, columnIndex) => {
    let max = stringWidth(header);
    for (const row of data.rows) {
      max = Math.max(max, stringWidth(row[columnIndex] ?? ""));
    }
    return Math.max(1, Math.min(max + TABLE_COLUMN_PADDING, TABLE_MAX_COLUMN_WIDTH));
  });

  const preferredTotal = sumWidths(preferredWidths);
  if (preferredTotal <= widthBudget) return preferredWidths;

  if (widthBudget < columnCount) {
    return preferredWidths.map((_, index) => (index < widthBudget ? 1 : 0));
  }

  const minimumColumnWidth = Math.min(
    TABLE_MIN_COLUMN_WIDTH,
    Math.floor(widthBudget / columnCount),
  );
  const minimumWidths = preferredWidths.map((width) => Math.min(width, minimumColumnWidth));
  const minimumTotal = sumWidths(minimumWidths);
  if (minimumTotal >= widthBudget) return minimumWidths;

  const remainingWidth = widthBudget - minimumTotal;
  const expandableWidths = preferredWidths.map((width, index) => width - minimumWidths[index]!);
  const expandableTotal = sumWidths(expandableWidths);
  if (expandableTotal <= 0) return minimumWidths;

  const rawExtras = expandableWidths.map((width) => (width / expandableTotal) * remainingWidth);
  const extraWidths = rawExtras.map((width) => Math.floor(width));
  const colWidths = minimumWidths.map((width, index) => width + extraWidths[index]!);

  let remainder = widthBudget - sumWidths(colWidths);
  const remainderOrder = rawExtras
    .map((width, index) => ({
      index,
      fraction: width - extraWidths[index]!,
      capacity: expandableWidths[index]!,
    }))
    .sort((a, b) => b.fraction - a.fraction || b.capacity - a.capacity || a.index - b.index);

  for (const { index } of remainderOrder) {
    if (remainder <= 0) break;
    if (colWidths[index]! >= preferredWidths[index]!) continue;
    colWidths[index]! += 1;
    remainder -= 1;
  }

  return colWidths;
}

function MarkdownTable({ data }: { data: TableData }) {
  const { stdout } = useStdout();
  const availableWidth = Math.max(
    1,
    (stdout.columns ?? DEFAULT_TERMINAL_WIDTH) - MESSAGE_CONTENT_MARGIN_LEFT - TABLE_MARGIN_LEFT,
  );
  const colWidths = useMemo(
    () => calculateMarkdownTableColumnWidths(data, availableWidth),
    [data, availableWidth],
  );

  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      {/* Header */}
      <Box>
        {data.headers.map((h, i) => (
          <Box key={i} width={colWidths[i]}>
            {colWidths[i]! > 0 ? (
              <Text bold wrap="wrap">
                {h}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>
      {/* Separator */}
      <Box>
        {colWidths.map((w, i) => (
          <Box key={i} width={w}>
            {w > 0 ? <Text dim>{"─".repeat(Math.max(w - 1, 1))}</Text> : null}
          </Box>
        ))}
      </Box>
      {/* Rows */}
      {data.rows.map((row, ri) => (
        <Box key={ri}>
          {data.headers.map((_, ci) => (
            <Box key={ci} width={colWidths[ci]}>
              {colWidths[ci]! > 0 ? <Text wrap="wrap">{row[ci] ?? ""}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ─── Hybrid render: tables as React, rest as ANSI ───────────────

function renderHybrid(text: string, markdownWidth: number): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let partIdx = 0;

  while (remaining) {
    const tableResult = extractTable(remaining);
    if (!tableResult) {
      // No more tables — render rest as ANSI markdown
      const rendered = hasMarkdownSyntax(remaining)
        ? cachedRender(remaining, markdownWidth, renderMarkdown)
        : remaining;
      const display = rendered.trim() ? rendered : remaining;
      parts.push(
        <Box key={partIdx++} flexDirection="column">
          <Ansi>{display}</Ansi>
        </Box>,
      );
      break;
    }

    // Render before-table text
    if (tableResult.before.trim()) {
      const rendered = hasMarkdownSyntax(tableResult.before)
        ? cachedRender(tableResult.before, markdownWidth, renderMarkdown)
        : tableResult.before;
      parts.push(
        <Box key={partIdx++} flexDirection="column">
          <Ansi>{rendered}</Ansi>
        </Box>,
      );
    }

    // Render table as React component
    parts.push(<MarkdownTable key={partIdx++} data={tableResult.table} />);

    remaining = tableResult.after;
  }

  return parts;
}

// ─── Streaming Markdown ─────────────────────────────────────────
//
// Block-boundary split rendering, ported from Claude Code's StreamingMarkdown
// (see restored-src/src/components/Markdown.tsx). Without this, in-flight
// assistant text shows raw markdown source (`**bold**`, `* item`) until the
// turn completes — then snaps to the rendered form. The trick:
//
//   1. Run `marked.lexer()` over the accumulated stream text.
//   2. Everything up to the last non-space token is "stable" (a complete
//      block — paragraph, heading, list, code fence). Render once, memoize,
//      never re-parse.
//   3. The final trailing token is the "unstable suffix" still being
//      written. Re-parse only this on every delta.
//
// Cost per delta is O(unstable suffix), not O(total text), so even long
// answers stay snappy. The lexer correctly keeps unclosed code fences and
// block quotes as single tokens, so the split aligns with semantic blocks.

/**
 * StableBlockRenderer — memoized renderer for the settled portion of a
 * streaming assistant message. Mirrors CC's `<Markdown>` (memoized) used
 * inside `<StreamingMarkdown>`: when the `text` prop is identical across
 * renders (the common case during streaming — the stable boundary only
 * advances when the lexer sees a new block boundary), React.memo's
 * `Object.is(prevProps.text, nextProps.text)` short-circuits and the
 * `useMemo([text])` inside `Inner` never re-runs renderHybrid.
 *
 * Without this layer, the old StreamingMarkdown stored the pre-rendered
 * ReactNode in a ref and re-ran renderHybrid(newStableText) every time
 * the boundary advanced — the trip through marked.parse over the ENTIRE
 * stable prefix took 1-3 s once the assistant's response grew past a few
 * KB. The user-visible symptom was the "stream pauses 1-3 s, then dumps
 * a paragraph all at once" stutter (see ui-ink flush logs: gap=2934ms,
 * chars=199 in a single batch).
 */
let stableMissCount = 0;
const StableBlockRenderer = memo(function StableBlockInner({
  text,
  markdownWidth,
}: {
  text: string;
  markdownWidth: number;
}) {
  if (STREAM_DIAG_ON) {
    stableMissCount += 1;
    streamLog.info("debug.md.stable_memo_miss", {
      n: stableMissCount,
      len: text.length,
    });
  }
  const rendered = useMemo(() => {
    if (!STREAM_DIAG_ON) return renderHybrid(text, markdownWidth);
    const t0 = performance.now();
    const out = renderHybrid(text, markdownWidth);
    const dt = performance.now() - t0;
    if (dt > 5) {
      streamLog.info("debug.md.stable_parse", {
        ms: Math.round(dt * 10) / 10,
        len: text.length,
        cacheHits: cacheStats.hits,
        cacheMiss: cacheStats.misses,
        cacheMissMs: Math.round(cacheStats.missMs * 10) / 10,
      });
    }
    return out;
  }, [text, markdownWidth]);
  return <>{rendered}</>;
});

// Per-render cumulative wall time spent in cachedRender misses for the
// CURRENT entry (reset at the top of StreamingMarkdown each call). Used by
// the diag log below so we can attribute the work of one React render to
// one log line. NOT reset across entries — fine, the log emits before the
// next render is reached.
function resetCacheStats(): void {
  if (!STREAM_DIAG_ON) return;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.missMs = 0;
}

function StreamingMarkdown({ text, nested }: { text: string; nested?: boolean }) {
  const { stdout } = useStdout();
  const markdownWidth = normalizeMarkdownWidth(stdout.columns);
  // Mutable ref persists across renders so we don't re-parse blocks that
  // already settled. Resets implicitly when the component unmounts (i.e.
  // when this assistant_text entry is removed from the chat list).
  const stablePrefixRef = useRef<string>("");
  const renderCountRef = useRef(0);
  const lastRenderAtRef = useRef(0);

  // Wall-clock at the very top so we can log how long the whole render
  // (lex + memo + parse) took in user-perceived terms.
  const renderStart = STREAM_DIAG_ON ? performance.now() : 0;
  resetCacheStats();
  if (STREAM_DIAG_ON) renderCountRef.current += 1;

  let stableText = stablePrefixRef.current;

  // If the incoming text is shorter than our cached prefix (e.g. session
  // restart, edit, retry), drop the cache and re-derive from scratch.
  if (!text.startsWith(stableText)) {
    stablePrefixRef.current = "";
    stableText = "";
  }

  // Lex only the unstable region — cheap, since stable blocks already settled.
  const unstableForLex = text.slice(stableText.length);
  const lexStart = STREAM_DIAG_ON ? performance.now() : 0;
  let advance = 0;
  let tokenCount = 0;
  try {
    const tokens = markedLexer(unstableForLex);
    tokenCount = tokens.length;
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === "space") {
      lastContentIdx--;
    }
    // All tokens *before* the last content token are complete → promote them.
    for (let i = 0; i < lastContentIdx; i++) {
      advance += tokens[i]!.raw.length;
    }
  } catch {
    // Lexer failure (malformed input mid-stream) — leave stable boundary alone
    // and render everything as unstable for this tick. It'll settle next delta.
  }
  const lexMs = STREAM_DIAG_ON ? performance.now() - lexStart : 0;

  const prevStableLen = stableText.length;
  if (advance > 0) {
    stablePrefixRef.current = stableText + unstableForLex.slice(0, advance);
    stableText = stablePrefixRef.current;
  }
  const unstableText = text.slice(stableText.length);

  // Cheap render for the trailing in-progress block. We avoid the
  // hybrid/table extraction here because tables can't matter mid-block,
  // and we want the render to be fast.
  const unstableRendered = useMemo<ReactNode>(() => {
    if (!unstableText) return null;
    if (!hasMarkdownSyntax(unstableText)) {
      return <Ansi>{unstableText}</Ansi>;
    }
    return <Ansi>{cachedRender(unstableText, markdownWidth, renderMarkdown)}</Ansi>;
  }, [unstableText, markdownWidth]);

  if (STREAM_DIAG_ON) {
    const now = performance.now();
    const sinceLast = lastRenderAtRef.current === 0 ? 0 : now - lastRenderAtRef.current;
    lastRenderAtRef.current = now;
    const totalMs = now - renderStart;
    const advanced = stableText.length - prevStableLen;
    // Only log when something interesting is happening — total > 5ms OR
    // boundary advanced OR cache missed. Steady-state ticks that are pure
    // memo hits are filtered to keep the log readable.
    if (totalMs > 5 || advanced > 0 || cacheStats.misses > 0) {
      streamLog.info("debug.md.render", {
        n: renderCountRef.current,
        totalMs: Math.round(totalMs * 10) / 10,
        lexMs: Math.round(lexMs * 10) / 10,
        tokens: tokenCount,
        textLen: text.length,
        stableLen: stableText.length,
        advanced,
        unstableLen: unstableText.length,
        cacheHits: cacheStats.hits,
        cacheMiss: cacheStats.misses,
        cacheMissMs: Math.round(cacheStats.missMs * 10) / 10,
        sinceLastMs: Math.round(sinceLast),
      });
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={nested ? 0 : 1}>
      {stableText && <StableBlockRenderer text={stableText} markdownWidth={markdownWidth} />}
      {unstableRendered ? <Box flexDirection="column">{unstableRendered}</Box> : null}
      <Text dim>{"▌"}</Text>
    </Box>
  );
}

// ─── Main Components ────────────────────────────────────────────

interface MessageContentProps {
  text: string;
  streaming?: boolean;
  /** When rendered inside an agent block, suppress the leading message gap. */
  nested?: boolean;
}

export function MessageContent({ text, streaming, nested }: MessageContentProps) {
  if (!text) return null;

  if (streaming) {
    return <StreamingMarkdown text={text} nested={nested} />;
  }

  return <FinalMarkdown text={text} nested={nested} />;
}

function FinalMarkdown({ text, nested }: { text: string; nested?: boolean }) {
  const { stdout } = useStdout();
  const markdownWidth = normalizeMarkdownWidth(stdout.columns);
  const rendered = useMemo(() => renderHybrid(text, markdownWidth), [text, markdownWidth]);
  return (
    <Box flexDirection="column" marginLeft={1} marginTop={nested ? 0 : 1}>
      {rendered}
    </Box>
  );
}

// ─── User / Error Messages ──────────────────────────────────────

interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text bold>{"❯ "}</Text>
      <Text bold>{text}</Text>
    </Box>
  );
}

interface ErrorMessageProps {
  error: string;
  nested?: boolean;
}

export function ErrorMessage({ error, nested }: ErrorMessageProps) {
  return (
    <Box marginLeft={1} marginTop={nested ? 0 : 1}>
      <Text color="ansi:red" bold>
        {"✗ "}
      </Text>
      <Text color="ansi:red">{error}</Text>
    </Box>
  );
}

// ─── Specialized Messages ───────────────────────────────────────

export function RateLimitMessage({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Box>
        <Text color="ansi:yellow" bold>
          {"⚠ "}
        </Text>
        <Text color="ansi:yellow">Rate limit reached</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dim>{text}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dim>Use </Text>
        <Text bold>/compact</Text>
        <Text dim> to reduce context or wait a moment.</Text>
      </Box>
    </Box>
  );
}

export function ContextLimitMessage() {
  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Box>
        <Text color="ansi:yellow" bold>
          {"⚠ "}
        </Text>
        <Text color="ansi:yellow">Context limit reached</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dim>Use </Text>
        <Text bold>/compact</Text>
        <Text dim> to summarize or </Text>
        <Text bold>/clear</Text>
        <Text dim> to start fresh.</Text>
      </Box>
    </Box>
  );
}

export function ThinkingMessage({
  content,
  collapsed,
  nested,
}: {
  content?: string;
  collapsed?: boolean;
  nested?: boolean;
}) {
  const mt = nested ? 0 : 1;
  if (collapsed || !content) {
    return (
      <Box marginLeft={1} marginTop={mt}>
        <Text dim italic>
          {"∴ Thinking"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={mt}>
      <Text dim italic>
        {"∴ Thinking…"}
      </Text>
      <Box marginLeft={2}>
        <Text dim>{content}</Text>
      </Box>
    </Box>
  );
}
