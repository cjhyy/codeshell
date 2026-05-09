/**
 * MessageContent — renders assistant text with markdown, tables, and syntax highlighting.
 *
 * Features (aligned with Claude Code):
 * - LRU token cache (500 entries) for repeated renders
 * - Fast-path: skips markdown parsing for plain text
 * - Table rendering as React flexbox components
 * - Streaming text shown as plain text with cursor
 */
import { useMemo, useRef, type ReactNode } from "react";
import { Box, Text } from "../../render/index.js";
import { Ansi } from "../../render/Ansi.js";
import chalk from "chalk";
import { Marked, lexer as markedLexer } from "marked";
import { markedTerminal } from "marked-terminal";

// ─── LRU Token Cache ────────────────────────────────────────────

const TOKEN_CACHE_MAX = 500;
const renderCache = new Map<string, string>();

function cachedRender(text: string, renderFn: (t: string) => string): string {
  const cached = renderCache.get(text);
  if (cached !== undefined) {
    // MRU promotion: delete + re-insert moves to end
    renderCache.delete(text);
    renderCache.set(text, cached);
    return cached;
  }
  const result = renderFn(text);
  if (renderCache.size >= TOKEN_CACHE_MAX) {
    // Evict oldest (first) entry
    const first = renderCache.keys().next().value;
    if (first !== undefined) renderCache.delete(first);
  }
  renderCache.set(text, result);
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

let markedInstance: Marked | null = null;
let markedInitFailed = false;

function getMarkedInstance(): Marked | null {
  if (markedInstance) return markedInstance;
  if (markedInitFailed) return null;
  try {
    const cols = process.stdout.columns || 80;
    markedInstance = new Marked(
      markedTerminal({
        showSectionPrefix: false,
        width: Math.min(cols, 100),
        reflowText: true,
        tab: 2,
        emoji: false,
      }) as any,
    );
    return markedInstance;
  } catch {
    markedInitFailed = true;
    return null;
  }
}

function renderMarkdown(text: string): string {
  const instance = getMarkedInstance();
  if (!instance) return text;
  try {
    const result = instance.parse(text, { async: false }) as string;
    return result.replace(/\n+$/, "");
  } catch {
    return text;
  }
}

// ─── Table extraction & rendering ───────────────────────────────

const TABLE_RE = /^\|.+\|$/gm;
const TABLE_SEP_RE = /^\|\s*[-:]+[-|\s:]*\|$/m;

interface TableData {
  headers: string[];
  rows: string[][];
}

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

function MarkdownTable({ data }: { data: TableData }) {
  const colWidths = data.headers.map((h, i) => {
    let max = h.length;
    for (const row of data.rows) {
      if (row[i] && row[i].length > max) max = row[i].length;
    }
    return Math.min(max + 2, 40);
  });

  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      {/* Header */}
      <Box>
        {data.headers.map((h, i) => (
          <Box key={i} width={colWidths[i]}>
            <Text bold>{h}</Text>
          </Box>
        ))}
      </Box>
      {/* Separator */}
      <Box>
        {colWidths.map((w, i) => (
          <Box key={i} width={w}>
            <Text dim>{"─".repeat(Math.max(w - 1, 1))}</Text>
          </Box>
        ))}
      </Box>
      {/* Rows */}
      {data.rows.map((row, ri) => (
        <Box key={ri}>
          {data.headers.map((_, ci) => (
            <Box key={ci} width={colWidths[ci]}>
              <Text>{row[ci] ?? ""}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ─── Hybrid render: tables as React, rest as ANSI ───────────────

function renderHybrid(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let partIdx = 0;

  while (remaining) {
    const tableResult = extractTable(remaining);
    if (!tableResult) {
      // No more tables — render rest as ANSI markdown
      const rendered = hasMarkdownSyntax(remaining)
        ? cachedRender(remaining, renderMarkdown)
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
        ? cachedRender(tableResult.before, renderMarkdown)
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

interface StableBlock {
  /** Concatenated raw text of all completed blocks. Acts as the cache key. */
  text: string;
  /** Pre-rendered ANSI / React for the stable region. */
  rendered: ReactNode;
}

function StreamingMarkdown({ text, nested }: { text: string; nested?: boolean }) {
  // Mutable ref persists across renders so we don't re-parse blocks that
  // already settled. Resets implicitly when the component unmounts (i.e.
  // when this assistant_text entry is removed from the chat list).
  const stableRef = useRef<StableBlock>({ text: "", rendered: null });

  let stableText = stableRef.current.text;
  let unstableText = text.slice(stableText.length);

  // If the incoming text is shorter than our cached prefix (e.g. session
  // restart, edit, retry), drop the cache and re-derive from scratch.
  if (!text.startsWith(stableText)) {
    stableRef.current = { text: "", rendered: null };
    stableText = "";
    unstableText = text;
  }

  // Lex only the unstable region — cheap, since stable blocks already settled.
  let advance = 0;
  try {
    const tokens = markedLexer(unstableText);
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

  if (advance > 0) {
    const newStableText = stableText + unstableText.slice(0, advance);
    // Re-render the stable region with full markdown (tables + ANSI hybrid).
    // Only happens when the boundary advances, so total parses across a turn
    // ≈ number of blocks, not number of chunks.
    stableRef.current = {
      text: newStableText,
      rendered: renderHybrid(newStableText),
    };
    stableText = newStableText;
    unstableText = text.slice(stableText.length);
  }

  // Cheap render for the trailing in-progress block. We avoid the
  // hybrid/table extraction here because tables can't matter mid-block,
  // and we want the render to be fast.
  const unstableRendered = useMemo<ReactNode>(() => {
    if (!unstableText) return null;
    if (!hasMarkdownSyntax(unstableText)) {
      return <Ansi>{unstableText}</Ansi>;
    }
    return <Ansi>{cachedRender(unstableText, renderMarkdown)}</Ansi>;
  }, [unstableText]);

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={nested ? 0 : 1}>
      {stableRef.current.rendered}
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
  const rendered = useMemo(() => renderHybrid(text), [text]);
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
