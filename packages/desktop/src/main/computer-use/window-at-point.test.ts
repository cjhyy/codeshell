import { describe, expect, test } from "bun:test";
import { hitTestWindows, parseScreenWindows } from "./window-at-point";

const rows = [
  [500, "cua-driver", 0, 0, 1512, 982],
  [7, "Electron", 100, 100, 400, 300],
  [42, "Slack", 80, 80, 900, 700],
  [43, "Google Chrome", 0, 0, 1512, 982],
];

describe("window at point", () => {
  test("keeps well-formed rows, bounded, in front-to-back order", () => {
    const windows = parseScreenWindows(
      JSON.stringify([
        ...rows,
        [0, "Zero pid", 0, 0, 100, 100],
        [9, "", 0, 0, 100, 100],
        [9, "Tiny", 0, 0, 10, 10],
        [9, "Bad", "x", 0, 100, 100],
        [9, "A".repeat(200), 0, 0, 100, 100],
        "nonsense",
      ]),
    );
    expect(windows.map((window) => window.app.slice(0, 13))).toEqual([
      "cua-driver",
      "Electron",
      "Slack",
      "Google Chrome",
      "AAAAAAAAAAAAA",
    ]);
    expect(windows.at(-1)!.app).toHaveLength(80);
    expect(parseScreenWindows("not json")).toEqual([]);
    expect(parseScreenWindows("{}")).toEqual([]);
  });

  test("the frontmost real window under the point, skipping our own and overlays", () => {
    const windows = parseScreenWindows(JSON.stringify(rows));
    expect(hitTestWindows(windows, { x: 200, y: 200 }, new Set([7]))?.app).toBe("Slack");
    expect(hitTestWindows(windows, { x: 1200, y: 900 }, new Set([7]))?.app).toBe("Google Chrome");
    expect(hitTestWindows(windows, { x: 200, y: 200 }, new Set())?.app).toBe("Electron");
    expect(hitTestWindows(windows, { x: 5_000, y: 5_000 }, new Set([7]))).toBeUndefined();
  });
});
