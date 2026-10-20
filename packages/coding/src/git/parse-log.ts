/** One coding-repository git log entry. */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** ASCII unit separator: unlike `|`, it does not occur in real commit subjects or author names. */
export const GIT_LOG_FIELD_SEPARATOR = "\x1f";

/** `git log --format` producing the fields parsed by {@link parseGitLog}. */
export const GIT_LOG_FORMAT = "%H%x1f%s%x1f%an%x1f%ci";

/**
 * Parse `git log --format=GIT_LOG_FORMAT` output into entries. Tolerates
 * malformed/short lines (missing separators) by defaulting absent fields
 * to "" rather than destructuring `undefined` and crashing on `.slice`
 * (review-2026-05-30). Blank lines are skipped.
 */
export function parseGitLog(raw: string): GitLogEntry[] {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parts = line.split(GIT_LOG_FIELD_SEPARATOR);
      const hash = parts[0] ?? "";
      return {
        hash: hash.slice(0, 8),
        message: parts[1] ?? "",
        author: parts[2] ?? "",
        date: parts[3] ?? "",
      };
    });
}
