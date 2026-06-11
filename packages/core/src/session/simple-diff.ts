/**
 * Minimal, dependency-free unified-diff for human-readable previews (e.g. the
 * /undo confirmation). NOT a patch generator — it's for showing a user "here's
 * what restoring will change" before they confirm. Uses a standard LCS so the
 * output reads like a normal diff (unchanged context, -removed, +added).
 *
 * `from` is the content currently on disk; `to` is the snapshot we'd restore.
 * So the preview answers "if I undo, these lines change."
 */

/** A single diff line with its marker. */
export interface DiffLine {
  marker: " " | "-" | "+";
  text: string;
}

/** Longest-common-subsequence table → minimal -/+ line diff (Myers-equivalent
 *  result via classic LCS; fine for preview-sized files). */
export function diffLines(from: string, to: string): DiffLine[] {
  // Normalize CRLF → LF before splitting so a Windows (CRLF) snapshot vs. an
  // LF edit doesn't render as every-line-changed in the /undo preview.
  const a = from.replace(/\r\n/g, "\n").split("\n");
  const b = to.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ marker: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ marker: "-", text: a[i]! });
      i++;
    } else {
      out.push({ marker: "+", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ marker: "-", text: a[i++]! });
  while (j < m) out.push({ marker: "+", text: b[j++]! });
  return out;
}

/**
 * Render a compact unified-diff string for a preview. Collapses long runs of
 * unchanged context to at most `context` lines around each change so a small
 * edit in a big file doesn't print the whole file. Returns "" when identical.
 */
export function renderDiffPreview(from: string, to: string, context = 3): string {
  const lines = diffLines(from, to);
  if (lines.every((l) => l.marker === " ")) return "";

  // Mark which lines are within `context` of a change; drop the rest, inserting
  // a "⋯" gap marker where we elide.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    if (lines[k]!.marker !== " ") {
      for (let d = -context; d <= context; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < lines.length) keep[idx] = true;
      }
    }
  }

  const rows: string[] = [];
  let elided = false;
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      rows.push(`${lines[k]!.marker}${lines[k]!.text}`);
      elided = false;
    } else if (!elided) {
      rows.push("⋯");
      elided = true;
    }
  }
  return rows.join("\n");
}
