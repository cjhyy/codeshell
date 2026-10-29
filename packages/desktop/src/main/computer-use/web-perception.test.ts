import { describe, expect, test } from "bun:test";
import { sparseWebArea, WINDOW_STATE_TIMEOUT_MS, withReadBudget } from "./web-perception";

const state = (args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "get_window_state", arguments: { pid: 1, window_id: 2, ...args } },
});
const result = (elements: unknown[], isError = false) => ({
  isError,
  structuredContent: { elements },
});
const web = (children: number) => [
  { element_index: 0, role: "AXWindow" },
  { element_index: 1, parent_index: 0, role: "AXWebArea" },
  ...Array.from({ length: children }, (_, i) => ({
    element_index: 2 + i,
    parent_index: i === 0 ? 1 : 2,
    role: "AXButton",
  })),
];

describe("web perception", () => {
  test("a window-state read without a budget gets the default one", () => {
    expect((withReadBudget(state()) as any).params.arguments).toEqual({
      pid: 1,
      window_id: 2,
      timeout_ms: WINDOW_STATE_TIMEOUT_MS,
    });
    expect(withReadBudget(state({ timeout_ms: 500 }))).toBeUndefined();
    expect(withReadBudget(state({ include_accessibility_tree: false }))).toBeUndefined();
    expect(
      withReadBudget({ ...state(), params: { name: "click", arguments: {} } }),
    ).toBeUndefined();
    expect(withReadBudget({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeUndefined();
  });

  test("only an empty web area is sparse", () => {
    expect(sparseWebArea(result(web(0)))).toBe(true);
    expect(sparseWebArea(result(web(2)))).toBe(true);
    // Grandchildren count: one direct child holding the rest of the page.
    expect(sparseWebArea(result(web(5)))).toBe(false);
    expect(sparseWebArea(result([{ element_index: 0, role: "AXWindow" }]))).toBe(false);
    expect(sparseWebArea(result(web(0), true))).toBe(false);
    expect(sparseWebArea({ content: [] })).toBe(false);
    expect(sparseWebArea(undefined)).toBe(false);
  });
});
