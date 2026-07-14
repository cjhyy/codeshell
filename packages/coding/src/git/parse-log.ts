/** One coding-repository git log entry. */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Parse `git log --format=%H|%s|%an|%ci` output into entries. Tolerates
 * malformed/short lines (missing `|` separators) by defaulting absent fields
 * to "" rather than destructuring `undefined` and crashing on `.slice`
 * (review-2026-05-30). Blank lines are skipped.
 */
export function parseGitLog(raw: string): GitLogEntry[] {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parts = line.split("|");
      const hash = parts[0] ?? "";
      return {
        hash: hash.slice(0, 8),
        message: parts[1] ?? "",
        author: parts[2] ?? "",
        date: parts[3] ?? "",
      };
    });
}
