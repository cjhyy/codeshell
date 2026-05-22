/**
 * Shim for CC's utils/sliceAnsi — slices an ANSI-styled string by display
 * column position while preserving escape sequences.
 *
 * This is a lightweight implementation. For full fidelity with wide characters
 * and complex ANSI sequences, consider installing `slice-ansi`.
 */

import stripAnsi from 'strip-ansi';

// Matches a single ANSI escape sequence
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Slice a string that may contain ANSI escape codes by *visible* character
 * positions (start inclusive, end exclusive).
 */
export default function sliceAnsi(
  text: string,
  start: number,
  end?: number,
): string {
  // Fast path: no ANSI codes at all
  if (!text.includes('\x1b')) {
    return text.slice(start, end);
  }

  const chars: { ch: string; visible: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(text);
    if (m && m.index === i) {
      chars.push({ ch: m[0], visible: false });
      i += m[0].length;
    } else {
      chars.push({ ch: text[i]!, visible: true });
      i++;
    }
  }

  const finalEnd = end ?? stripAnsi(text).length;
  let visIdx = 0;
  let result = '';
  let activeStyles = '';

  for (const { ch, visible } of chars) {
    if (!visible) {
      // Always accumulate style sequences that precede visible chars in range
      if (visIdx >= start && visIdx < finalEnd) {
        result += ch;
      } else {
        activeStyles += ch;
      }
      continue;
    }

    if (visIdx >= start && visIdx < finalEnd) {
      // First visible char in range: prepend any accumulated styles
      if (activeStyles) {
        result += activeStyles;
        activeStyles = '';
      }
      result += ch;
    }
    visIdx++;
    if (visIdx >= finalEnd) break;
  }

  return result;
}
