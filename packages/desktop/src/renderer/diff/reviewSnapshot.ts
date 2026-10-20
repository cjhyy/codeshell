import { parseUnifiedDiff } from "./parseUnifiedDiff";

/**
 * Legacy turn snapshots contain one file section per tool call. Keep every
 * recorded hunk under one file header, without guessing a net change from
 * partial snippets. Live Git queries keep their repository-scoped identities.
 */
export function groupReviewSnapshot(diff: string): string {
  const grouped = new Map<string, string>();
  let duplicate = false;
  const chunks = diff.split(/(?=^diff --git )/m);
  chunks.forEach((chunk, index) => {
    const file = parseUnifiedDiff(chunk)[0];
    const path = file?.newPath ?? file?.oldPath;
    // Renames carry two identities; keep those transitions separate rather
    // than merging unrelated files that happen to share a destination name.
    const key =
      path && !(file.oldPath && file.newPath && file.oldPath !== file.newPath)
        ? `file:${path}`
        : `section:${index}`;
    const previous = grouped.get(key);
    if (previous === undefined) {
      grouped.set(key, chunk);
      return;
    }
    duplicate = true;
    const payloadStart = chunk.search(/^@@ |^Binary files |^GIT binary patch/m);
    const payload =
      payloadStart >= 0 ? chunk.slice(payloadStart) : chunk.slice(chunk.indexOf("\n") + 1);
    grouped.set(key, `${previous}${previous.endsWith("\n") ? "" : "\n"}${payload}`);
  });
  return duplicate
    ? [...grouped.values()].map((chunk) => (chunk.endsWith("\n") ? chunk : `${chunk}\n`)).join("")
    : diff;
}

/** Keep original patch bytes/line numbers when reviewing one historical file. */
export function selectReviewSnapshot(diff: string, onlyPath: string | null): string {
  const grouped = groupReviewSnapshot(diff);
  if (!onlyPath) return grouped;
  return grouped
    .split(/(?=^diff --git )/m)
    .filter((chunk) =>
      parseUnifiedDiff(chunk).some((file) => (file.newPath ?? file.oldPath) === onlyPath),
    )
    .join("");
}
