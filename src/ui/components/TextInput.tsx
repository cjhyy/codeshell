/**
 * TextInput — enhanced text input with multiline, word navigation, and paste support.
 *
 * Features beyond basic input:
 * - Multiline editing (newlines via paste or Shift+Enter proxy)
 * - Word-level navigation: Ctrl+W (delete word back), Alt+B/F (word jump)
 * - Emacs bindings: Ctrl+A/E (home/end), Ctrl+K (kill to end), Ctrl+U (kill to start)
 * - ANSI inverse-video cursor
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../ink/index.js";
import { Ansi } from "../../ink/Ansi.js";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

const INV_ON = "\x1b[7m";
const INV_OFF = "\x1b[27m";
const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

// Word boundary: jump over non-word chars, then word chars (emacs-style)
function wordBoundaryLeft(text: string, pos: number): number {
  let i = pos;
  // Skip non-word chars
  while (i > 0 && !/\w/.test(text[i - 1]!)) i--;
  // Skip word chars
  while (i > 0 && /\w/.test(text[i - 1]!)) i--;
  return i;
}

function wordBoundaryRight(text: string, pos: number): number {
  let i = pos;
  // Skip word chars
  while (i < text.length && /\w/.test(text[i]!)) i++;
  // Skip non-word chars
  while (i < text.length && !/\w/.test(text[i]!)) i++;
  return i;
}

export default function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
}: TextInputProps) {
  // Cursor is owned by this component. We previously had a `useEffect` that
  // snapped cursorOffset back to `value.length` whenever `value` changed —
  // it broke mid-string typing (cursor jumped to end after each char) and
  // post-paste display (cursor "disappeared" because the effect raced the
  // keypress handler and clamped past the just-inserted text). All cursor
  // movement now flows through the keyboard branches below; if it drifts
  // out of bounds we clamp at render time.
  const [rawCursor, setCursorOffset] = useState(value.length);
  const cursorOffset = Math.min(Math.max(0, rawCursor), value.length);

  const isMultiline = value.includes("\n");
  const lineCount = isMultiline ? value.split("\n").length : 0;

  useInput((input, key) => {
    if (!focus) return;

    if (key.return) {
      onSubmit?.(value);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const before = value.slice(0, cursorOffset - 1);
        const after = value.slice(cursorOffset);
        onChange(before + after);
        setCursorOffset(cursorOffset - 1);
      }
      return;
    }

    if (key.leftArrow) {
      if (key.meta || key.ctrl) {
        // Alt+Left / Ctrl+Left: word jump
        setCursorOffset(wordBoundaryLeft(value, cursorOffset));
      } else {
        setCursorOffset(Math.max(0, cursorOffset - 1));
      }
      return;
    }

    if (key.rightArrow) {
      if (key.meta || key.ctrl) {
        // Alt+Right / Ctrl+Right: word jump
        setCursorOffset(wordBoundaryRight(value, cursorOffset));
      } else {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
      }
      return;
    }

    // Emacs: Ctrl+A — beginning of line
    if (key.ctrl && input === "a") {
      setCursorOffset(0);
      return;
    }

    // Emacs: Ctrl+E — end of line
    if (key.ctrl && input === "e") {
      setCursorOffset(value.length);
      return;
    }

    // Emacs: Ctrl+K — kill to end of line
    if (key.ctrl && input === "k") {
      onChange(value.slice(0, cursorOffset));
      return;
    }

    // Emacs: Ctrl+U — kill to start of line
    if (key.ctrl && input === "u") {
      onChange(value.slice(cursorOffset));
      setCursorOffset(0);
      return;
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && input === "w") {
      const newPos = wordBoundaryLeft(value, cursorOffset);
      const before = value.slice(0, newPos);
      const after = value.slice(cursorOffset);
      onChange(before + after);
      setCursorOffset(newPos);
      return;
    }

    // Alt+B — word backward
    if (key.meta && input === "b") {
      setCursorOffset(wordBoundaryLeft(value, cursorOffset));
      return;
    }

    // Alt+F — word forward
    if (key.meta && input === "f") {
      setCursorOffset(wordBoundaryRight(value, cursorOffset));
      return;
    }

    // Alt+D — delete word forward
    if (key.meta && input === "d") {
      const newPos = wordBoundaryRight(value, cursorOffset);
      const before = value.slice(0, cursorOffset);
      const after = value.slice(newPos);
      onChange(before + after);
      return;
    }

    // Regular character input (including pasted multi-char strings with newlines).
    // Strip control bytes that aren't `\n` or `\t` so a pasted terminal diff
    // (which carries raw `\x1b[…m` color codes) can't break the inverse-video
    // cursor renderer below — without this, the cursor visually disappears
    // after a paste because the embedded ESC closes our INV_ON sequence.
    if (input && !key.ctrl && !key.meta) {
      // eslint-disable-next-line no-control-regex
      const cleaned = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (!cleaned) return;
      const before = value.slice(0, cursorOffset);
      const after = value.slice(cursorOffset);
      onChange(before + cleaned + after);
      setCursorOffset(cursorOffset + cleaned.length);
    }
  });

  // ─── Render ────────────────────────────────────────────────────

  if (!value && placeholder) {
    if (focus) {
      return <Ansi>{INV_ON + " " + INV_OFF + DIM_ON + " " + placeholder + DIM_OFF}</Ansi>;
    }
    return <Ansi>{DIM_ON + placeholder + DIM_OFF}</Ansi>;
  }

  // Multiline rendering — show each line with cursor
  if (isMultiline) {
    const lines = value.split("\n");
    let charsSoFar = 0;

    return (
      <Box flexDirection="column">
        {lines.map((line, lineIdx) => {
          const lineStart = charsSoFar;
          const lineEnd = lineStart + line.length;
          charsSoFar = lineEnd + 1; // +1 for the \n

          const cursorInLine = cursorOffset >= lineStart && cursorOffset <= lineEnd;
          const localCursor = cursorOffset - lineStart;
          const prefix = lineIdx === 0 ? "" : "  ";

          if (focus && cursorInLine) {
            const before = line.slice(0, localCursor);
            const cursorChar = line[localCursor] ?? " ";
            const after = line.slice(localCursor + 1);
            return (
              <Box key={lineIdx}>
                <Text dim>{prefix}</Text>
                <Ansi>{before + INV_ON + cursorChar + INV_OFF + after}</Ansi>
              </Box>
            );
          }

          return (
            <Box key={lineIdx}>
              <Text dim>{prefix}</Text>
              <Ansi>{line}</Ansi>
            </Box>
          );
        })}
        <Text dim>  ({lineCount} lines)</Text>
      </Box>
    );
  }

  // Single-line rendering
  const before = value.slice(0, cursorOffset);
  const cursorChar = value[cursorOffset] ?? " ";
  const after = value.slice(cursorOffset + 1);

  if (focus) {
    return <Ansi>{before + INV_ON + cursorChar + INV_OFF + after}</Ansi>;
  }
  return <Ansi>{value}</Ansi>;
}
