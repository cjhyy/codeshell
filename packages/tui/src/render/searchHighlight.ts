import {
  cellAtIndex,
  type Screen,
  type StylePool,
  setCellStyleId,
} from './screen.js'
import { findRowSearchMatches } from './searchMatches.js'

/**
 * Highlight all visible occurrences of `query` in the screen buffer by
 * inverting cell styles (SGR 7). Post-render, same damage-tracking machinery
 * as applySelectionOverlay — the diff picks up highlighted cells as ordinary
 * changes, LogUpdate stays a pure diff engine.
 *
 * Case-insensitive. Handles wide characters (CJK, emoji) by building a
 * col-of-char map per row — the Nth character isn't at col N when wide chars
 * are present (each occupies 2 cells: head + SpacerTail).
 *
 * This ONLY inverts — there is no "current match" logic here. The yellow
 * current-match overlay is handled separately by applyPositionedHighlight
 * (render-to-screen.ts), which writes on top using positions scanned from
 * the target message's DOM subtree.
 *
 * Returns true if any match was highlighted (damage gate — caller forces
 * full-frame damage when true).
 */
export function applySearchHighlight(
  screen: Screen,
  query: string,
  stylePool: StylePool,
): boolean {
  if (!query) return false
  const lq = query.toLowerCase()
  const w = screen.width
  const height = screen.height

  let applied = false
  for (let row = 0; row < height; row++) {
    const rowOff = row * w
    const { columns, matches } = findRowSearchMatches(screen, row, lq)
    for (const { start, end } of matches) {
      applied = true
      for (let ci = start; ci <= end; ci++) {
        const col = columns[ci]!
        const cell = cellAtIndex(screen, rowOff + col)
        setCellStyleId(screen, col, row, stylePool.withInverse(cell.styleId))
      }
    }
  }

  return applied
}
