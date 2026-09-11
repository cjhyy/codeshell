import { CellWidth, cellAtIndex, type Screen } from "./screen.js";

type RowSearchMatches = {
  /** Screen column of each searchable cell, excluding spacers and gutters. */
  columns: number[];
  /** Inclusive indices in columns, in non-overlapping text-match order. */
  matches: { start: number; end: number }[];
};

/** Find matches in one rendered row without changing cells or styles.
 * Callers lowercase the query once before scanning all rows. Matches stay
 * row-local, including when the next row is a soft-wrap continuation. */
export function findRowSearchMatches(
  screen: Screen,
  row: number,
  lowercaseQuery: string,
): RowSearchMatches {
  const columns: number[] = [];
  const matches: RowSearchMatches["matches"] = [];
  if (!lowercaseQuery) return { columns, matches };

  const rowOff = row * screen.width;
  let text = "";
  const codeUnitToCell: number[] = [];
  for (let col = 0; col < screen.width; col++) {
    const idx = rowOff + col;
    const cell = cellAtIndex(screen, idx);
    if (
      cell.width === CellWidth.SpacerTail ||
      cell.width === CellWidth.SpacerHead ||
      screen.noSelect[idx] === 1
    ) {
      continue;
    }
    // Map UTF-16 offsets after lowercasing each grapheme. Emoji and İ → i +
    // U+0307 occupy more code units than cells; lowering the whole row after
    // building the map would shift all subsequent match positions.
    const lowercase = cell.char.toLowerCase();
    for (let i = 0; i < lowercase.length; i++) {
      codeUnitToCell.push(columns.length);
    }
    text += lowercase;
    columns.push(col);
  }

  const length = lowercaseQuery.length;
  let pos = text.indexOf(lowercaseQuery);
  while (pos >= 0) {
    matches.push({
      start: codeUnitToCell[pos]!,
      end: codeUnitToCell[pos + length - 1]!,
    });
    pos = text.indexOf(lowercaseQuery, pos + length);
  }
  return { columns, matches };
}
