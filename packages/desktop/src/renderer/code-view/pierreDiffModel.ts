import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { DiffSection } from "../diff/diffSections";

/* Imported only by ./pierreViews (lazy) and tests, never by startup code. */

/**
 * Pierre's patch model for one section, or null when it cannot represent it.
 * Pierre normalises some names (it trims spaces and splits quoted paths with
 * spaces), so display names always come from our parser.
 */
export function toPierreFileDiff(section: DiffSection, cacheKey: string): FileDiffMetadata | null {
  if (section.file.hunks.length === 0) return null;
  try {
    const files = parsePatchFiles(section.text).flatMap((patch) => patch.files);
    if (files.length !== 1) return null;
    const parsed = files[0]!;
    const name = section.file.newPath ?? section.file.oldPath ?? parsed.name;
    const previous = section.file.oldPath;
    return {
      ...parsed,
      name,
      prevName: previous && previous !== name ? previous : undefined,
      cacheKey,
    };
  } catch {
    return null;
  }
}
