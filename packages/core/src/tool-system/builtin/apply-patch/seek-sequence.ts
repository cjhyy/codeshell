// Adapted from openai/codex codex-rs/apply-patch/src/seek_sequence.rs (Apache-2.0).

/**
 * Locate `pattern` within `lines` starting at or after `start`.
 *
 * Tries four passes with decreasing strictness:
 *   1. exact equality
 *   2. trailing whitespace ignored
 *   3. leading + trailing whitespace ignored
 *   4. Unicode punctuation normalized to ASCII (smart quotes, em-dashes, NBSP, …)
 *
 * When `eof` is true, search begins at the position that would let `pattern`
 * end exactly at the end of `lines` — useful for chunks marked
 * `*** End of File`. Falls back to `start` if that position is out of range.
 *
 * Defensive cases:
 *   - Empty pattern returns `start` (no-op match).
 *   - Pattern longer than input returns `null`.
 */
export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart =
    eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const lastStart = lines.length - pattern.length;

  // Pass 1: exact equality.
  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (lines[i + p] !== pattern[p]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  // Pass 2: trim trailing whitespace.
  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (rtrim(lines[i + p]) !== rtrim(pattern[p])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  // Pass 3: trim both sides.
  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (lines[i + p].trim() !== pattern[p].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  // Pass 4: Unicode normalize (smart quotes / dashes / NBSP → ASCII).
  for (let i = searchStart; i <= lastStart; i++) {
    let ok = true;
    for (let p = 0; p < pattern.length; p++) {
      if (normalize(lines[i + p]) !== normalize(pattern[p])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return null;
}

function rtrim(s: string): string {
  return s.replace(/[\s\uFEFF\xA0]+$/u, "");
}

function normalize(s: string): string {
  let out = "";
  for (const ch of s.trim()) {
    const code = ch.codePointAt(0)!;
    // Various dash / hyphen code-points → ASCII '-'
    if (
      code === 0x2010 ||
      code === 0x2011 ||
      code === 0x2012 ||
      code === 0x2013 ||
      code === 0x2014 ||
      code === 0x2015 ||
      code === 0x2212
    ) {
      out += "-";
    } else if (
      // Fancy single quotes → '
      code === 0x2018 ||
      code === 0x2019 ||
      code === 0x201a ||
      code === 0x201b
    ) {
      out += "'";
    } else if (
      // Fancy double quotes → "
      code === 0x201c ||
      code === 0x201d ||
      code === 0x201e ||
      code === 0x201f
    ) {
      out += '"';
    } else if (
      // Non-breaking and exotic spaces → regular space
      code === 0x00a0 ||
      (code >= 0x2002 && code <= 0x200a) ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000
    ) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}
