import { parseUnifiedDiff, type DiffFile } from "./parseUnifiedDiff";

/** One `diff --git` section and the file our parser reads from it. */
export interface DiffSection {
  text: string;
  file: DiffFile;
}

/**
 * Split a Git patch into per-file sections. Our parser owns file identity
 * (quoted paths, binaries, mode-only and empty files); parsing each section
 * on its own keeps every rendered body aligned with exactly one header.
 */
export function splitDiffSections(raw: string): DiffSection[] {
  return raw
    .split(/(?=^diff --git )/m)
    .filter((text) => text.startsWith("diff --git "))
    .flatMap((text) => {
      const file = parseUnifiedDiff(text)[0];
      return file ? [{ text, file }] : [];
    });
}

/** Source text of a diff line, for the comment anchor's code excerpt. */
export function diffLineText(
  file: DiffFile,
  side: "additions" | "deletions",
  lineNumber: number,
): string {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const number = side === "additions" ? line.newLine : line.oldLine;
      if (number === lineNumber && line.kind !== "meta") return line.text;
    }
  }
  return "";
}

/** Added/removed line counts for one file. */
export function diffFileStats(file: DiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
  }
  return { added, removed };
}
