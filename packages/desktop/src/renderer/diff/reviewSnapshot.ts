import { parseUnifiedDiff } from "./parseUnifiedDiff";

/** Keep original patch bytes/line numbers when reviewing one historical file. */
export function selectReviewSnapshot(diff: string, onlyPath: string | null): string {
  if (!onlyPath) return diff;
  return diff
    .split(/(?=^diff --git )/m)
    .filter((chunk) =>
      parseUnifiedDiff(chunk).some((file) => (file.newPath ?? file.oldPath) === onlyPath),
    )
    .join("");
}
