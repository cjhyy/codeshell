/**
 * Parse the built-in Glob tool's result text (core tool-system/builtin/glob.ts):
 * a fixed no-match sentence; up to 200 rows under an "N files matched:" header;
 * or 200 rows followed by a "... and K more files (T total)" trailer.
 * Only the rows are files; the header and trailer carry the real total.
 */
export interface GlobResult {
  /** Listed file rows (`path  (size)`), without status lines. */
  files: string[];
  /** Number of matching files, including any beyond the listed rows. */
  total: number;
}

const NO_MATCH = "No files matched the pattern.";
const HEADER = /^(\d+) files? matched:$/;
const TRAILER = /^\.\.\. and \d+ more files \((\d+) total\)$/;

export function parseGlobResult(content: string): GlobResult {
  const text = content.trim();
  if (text === NO_MATCH) return { files: [], total: 0 };
  const lines = text.split("\n");
  let total: number | undefined;
  const header = HEADER.exec(lines[0] ?? "");
  if (header) {
    total = Number(header[1]);
    lines.shift();
  }
  const trailer = TRAILER.exec(lines.at(-1) ?? "");
  if (trailer) {
    total = Number(trailer[1]);
    lines.pop();
  }
  const files = lines.filter((line) => line.trim());
  return { files, total: total ?? files.length };
}
