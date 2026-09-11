import { expect, test } from "bun:test";
import { scanPositions } from "../packages/tui/src/render/render-to-screen.js";
import { applySearchHighlight } from "../packages/tui/src/render/searchHighlight.js";
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAtIndex,
  createScreen,
  setCellAt,
} from "../packages/tui/src/render/screen.js";

type InputCell = string | { char: string; width?: CellWidth; noSelect?: boolean };

function fixture(rows: InputCell[][]) {
  const styles = new StylePool();
  const screen = createScreen(
    Math.max(...rows.map((row) => row.length)),
    rows.length,
    styles,
    new CharPool(),
    new HyperlinkPool(),
  );
  rows.forEach((cells, row) => {
    cells.forEach((input, col) => {
      const cell = typeof input === "string" ? { char: input } : input;
      setCellAt(screen, col, row, {
        char: cell.char,
        width: cell.width ?? CellWidth.Narrow,
        styleId: styles.none,
        hyperlink: undefined,
      });
      if (cell.noSelect) screen.noSelect[row * screen.width + col] = 1;
    });
  });
  return { screen, styles };
}

const tail = { char: "", width: CellWidth.SpacerTail };
const head = { char: "", width: CellWidth.SpacerHead };

const cases = [
  {
    name: "case-insensitive non-overlapping ASCII matches",
    rows: [["A", "a", "a", "A", "a"]],
    query: "aA",
    positions: [
      { row: 0, col: 0, len: 2 },
      { row: 0, col: 2, len: 2 },
    ],
    highlighted: [0, 1, 2, 3],
  },
  {
    name: "CJK wide-cell heads and their following text",
    rows: [["A", { char: "中", width: CellWidth.Wide }, tail, "B"]],
    query: "中b",
    positions: [{ row: 0, col: 1, len: 3 }],
    highlighted: [1, 3],
  },
  {
    name: "emoji surrogate pairs without shifting following columns",
    rows: [["A", { char: "🙂", width: CellWidth.Wide }, tail, "B"]],
    query: "🙂b",
    positions: [{ row: 0, col: 1, len: 3 }],
    highlighted: [1, 3],
  },
  {
    name: "combining characters stored in one grapheme cell",
    rows: [["A", "e\u0301", "B"]],
    query: "\u0301b",
    positions: [{ row: 0, col: 1, len: 2 }],
    highlighted: [1, 2],
  },
  {
    name: "lowercase expansion of Turkish capital dotted I",
    rows: [["İ", "X", "i", "\u0307", "x"]],
    query: "İx",
    positions: [
      { row: 0, col: 0, len: 2 },
      { row: 0, col: 2, len: 3 },
    ],
    highlighted: [0, 1, 2, 3, 4],
  },
  {
    name: "excluded gutters inside a match remain unhighlighted",
    rows: [["a", { char: "#", noSelect: true }, "b"]],
    query: "ab",
    positions: [{ row: 0, col: 0, len: 3 }],
    highlighted: [0, 2],
  },
  {
    name: "excluded text cannot itself match",
    rows: [["a", { char: "#", noSelect: true }, "b"]],
    query: "#",
    positions: [],
    highlighted: [],
  },
  {
    name: "spacer padding is excluded and matches remain row-local",
    rows: [
      ["a", head],
      ["b", "a"],
    ],
    query: "ab",
    positions: [],
    highlighted: [],
  },
  {
    name: "empty query is a no-op",
    rows: [["a", "b"]],
    query: "",
    positions: [],
    highlighted: [],
  },
] satisfies Array<{
  name: string;
  rows: InputCell[][];
  query: string;
  positions: Array<{ row: number; col: number; len: number }>;
  highlighted: number[];
}>;

for (const entry of cases) {
  test(`search scan and overlay preserve ${entry.name}`, () => {
    const { screen, styles } = fixture(entry.rows);
    const beforeCells = screen.cells.slice();
    const beforeDamage = screen.damage;
    expect(scanPositions(screen, entry.query)).toEqual(entry.positions);
    expect(screen.cells).toEqual(beforeCells);
    expect(screen.damage).toBe(beforeDamage);

    expect(applySearchHighlight(screen, entry.query, styles)).toBe(entry.positions.length > 0);
    const highlighted = Array.from(
      { length: screen.width * screen.height },
      (_, index) => index,
    ).filter((index) => cellAtIndex(screen, index).styleId !== styles.none);
    expect(highlighted).toEqual(entry.highlighted);
    const once = screen.cells.slice();
    applySearchHighlight(screen, entry.query, styles);
    expect(screen.cells).toEqual(once);
  });
}
