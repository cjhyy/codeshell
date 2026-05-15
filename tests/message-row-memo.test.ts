import { describe, expect, test } from "bun:test";
import { areMessageRowPropsEqual, type MessageRowProps } from "../src/ui/components/MessageRow.js";
import type { ChatEntry } from "../src/ui/store.js";

function entry(over: Partial<ChatEntry> = {}): ChatEntry {
  return { id: "e1", type: "user", text: "x", ...(over as object) } as ChatEntry;
}

const noopRender = () => null;

function props(over: Partial<MessageRowProps> = {}): MessageRowProps {
  return {
    entry: entry(),
    columns: 80,
    isStreaming: false,
    isSelected: false,
    expanded: false,
    render: noopRender,
    ...over,
  };
}

describe("areMessageRowPropsEqual", () => {
  test("same entry reference + same columns + not streaming + same selection → bail (true)", () => {
    const e = entry();
    expect(areMessageRowPropsEqual(props({ entry: e }), props({ entry: e }))).toBe(true);
  });

  test("different entry reference → re-render (false)", () => {
    expect(
      areMessageRowPropsEqual(
        props({ entry: entry({ id: "a" }) }),
        props({ entry: entry({ id: "a" }) }),
      ),
    ).toBe(false);
  });

  test("isStreaming=true on either side → re-render", () => {
    const e = entry();
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, isStreaming: true }),
        props({ entry: e, isStreaming: true }),
      ),
    ).toBe(false);
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, isStreaming: false }),
        props({ entry: e, isStreaming: true }),
      ),
    ).toBe(false);
  });

  test("columns changed → re-render (width affects wrap)", () => {
    const e = entry();
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, columns: 80 }),
        props({ entry: e, columns: 100 }),
      ),
    ).toBe(false);
  });

  test("isSelected changed → re-render (cursor outline must update)", () => {
    const e = entry();
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, isSelected: false }),
        props({ entry: e, isSelected: true }),
      ),
    ).toBe(false);
  });

  test("expanded changed → re-render (transcript-mode toggle)", () => {
    const e = entry();
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, expanded: false }),
        props({ entry: e, expanded: true }),
      ),
    ).toBe(false);
  });

  test("render fn identity is intentionally NOT in the comparator", () => {
    const e = entry();
    // Different render closures, otherwise identical props — should still bail.
    // (If entry changes later, the next render call will use the fresh closure;
    // see file header for why this is safe.)
    expect(
      areMessageRowPropsEqual(
        props({ entry: e, render: () => null }),
        props({ entry: e, render: () => null }),
      ),
    ).toBe(true);
  });
});
