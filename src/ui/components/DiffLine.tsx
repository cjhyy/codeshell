/**
 * DiffLine — single source of truth for diff line rendering.
 *
 * Used everywhere a `+`/`-` line is shown (PermissionPrompt previews,
 * ToolCallResult expansions, DiffView, StructuredDiff). Centralizing here
 * means a styling tweak hits every diff surface at once.
 *
 * Visual contract (matches Claude Code's transcript style):
 * - Add line: full-width band, dark-green bg (ansi256:22), bright-green fg.
 * - Remove line: full-width band, dark-red bg (ansi256:52), bright-red fg.
 * - Hunk header (`@@ … @@`): plain cyan fg, no band.
 * - The band is padded with spaces out to the terminal column so the color
 *   extends to the right edge — `<Text backgroundColor>` only tints the
 *   glyphs it owns, otherwise the line looks half-colored.
 */
import { Box, Text } from "../../render/index.js";

const ADD_BG = "ansi256(22)";
const REMOVE_BG = "ansi256(52)";
const ADD_FG = "ansi:greenBright";
const REMOVE_FG = "ansi:redBright";

export type DiffKind = "add" | "remove" | "hunk" | "context";

interface DiffLineProps {
  kind: DiffKind;
  /** Raw text WITHOUT the `+ ` / `- ` prefix — DiffLine renders the marker. */
  text: string;
  /**
   * Left indent applied before the marker (and before the gutter, if any).
   * Defaults to 0; ToolCallResult passes its own padding so diff blocks
   * line up under the `✓ ToolName` header.
   */
  indent?: number;
  /**
   * Optional dim leading glyph rendered before the colored band (e.g. the
   * `⎿ ` connector ToolCallResult uses to group output under its header).
   * Padding to terminal width accounts for the glyph so the band still
   * extends to the right edge.
   */
  gutter?: string;
}

/** Pad to terminal width so the colored band extends to the right edge. */
function padToWidth(s: string, reserve: number): string {
  const cols = Math.min(200, Math.max(40, process.stdout.columns ?? 80));
  const target = Math.max(0, cols - reserve);
  if (s.length >= target) return s;
  return s + " ".repeat(target - s.length);
}

export function DiffLine({ kind, text, indent = 0, gutter }: DiffLineProps) {
  const pad = " ".repeat(indent);
  const gutterReserve = gutter ? gutter.length : 0;
  if (kind === "add") {
    return (
      <Box>
        {gutter ? <Text dim>{gutter}</Text> : null}
        <Text backgroundColor={ADD_BG} color={ADD_FG}>
          {padToWidth(`${pad}+ ${text}`, gutterReserve)}
        </Text>
      </Box>
    );
  }
  if (kind === "remove") {
    return (
      <Box>
        {gutter ? <Text dim>{gutter}</Text> : null}
        <Text backgroundColor={REMOVE_BG} color={REMOVE_FG}>
          {padToWidth(`${pad}- ${text}`, gutterReserve)}
        </Text>
      </Box>
    );
  }
  if (kind === "hunk") {
    return (
      <Box>
        {gutter ? <Text dim>{gutter}</Text> : null}
        <Text color="ansi:cyan">{`${pad}${text}`}</Text>
      </Box>
    );
  }
  // context — dim, no band
  return (
    <Box>
      {gutter ? <Text dim>{gutter}</Text> : null}
      <Text dim>{`${pad}  ${text}`}</Text>
    </Box>
  );
}

/**
 * Classify a raw diff text line. Matches `+\s` / `-\s` (so `+x` identifiers
 * and `+++ / ---` file headers don't trip it), `@@` hunk markers, and falls
 * through to context.
 *
 * Returns the kind and the text with its marker stripped (since `<DiffLine>`
 * re-renders the marker itself).
 */
export function classifyDiffLine(raw: string): { kind: DiffKind; text: string } {
  const trimmed = raw.trimStart();
  if (/^\+\s/.test(trimmed)) {
    return { kind: "add", text: trimmed.replace(/^\+\s/, "") };
  }
  if (/^-\s/.test(trimmed)) {
    return { kind: "remove", text: trimmed.replace(/^-\s/, "") };
  }
  if (trimmed.startsWith("@@")) {
    return { kind: "hunk", text: trimmed };
  }
  return { kind: "context", text: raw };
}
