import { expect, mock, test } from "bun:test";
import { getGraphemeSegmenter } from "../../../packages/core/src/utils/intl.ts";
import { createTokenizer } from "../../../packages/tui/src/render/termio/tokenize.ts";
import getMaxWidth from "../../../packages/tui/src/render/get-max-width.ts";

// Route only the utility import to its real frozen source. The unrelated package barrel
// is not loaded. OSC's exec helper is a throwing boundary and is never called.
let nativeCalls = 0;
mock.module("@cjhyy/code-shell-core/internal", () => ({
  getGraphemeSegmenter,
  env: { terminal: "owned-pure-fixture" },
  execFileNoThrow: () => {
    nativeCalls++;
    throw new Error("Native operations are outside this audit fixture");
  },
}));
const { Parser } = await import("../../../packages/tui/src/render/termio/parser.ts");
const { stringWidth } = await import("../../../packages/tui/src/render/stringWidth.ts");
const { lineWidth } = await import("../../../packages/tui/src/render/line-width-cache.ts");

function textGraphemes(text: string) {
  return new Parser().feed(text).flatMap(action => action.type === "text" ? action.graphemes : []);
}

test("candidate: decomposed Latin grapheme metadata width differs from stringWidth", () => {
  const decomposed = "e\u0301";
  const graphemes = textGraphemes(decomposed);
  expect(graphemes).toEqual([{ value: decomposed, width: 2 }]);
  expect(stringWidth(decomposed)).toBe(1);
  expect(textGraphemes("é")).toEqual([{ value: "é", width: 1 }]);
  expect(decomposed.normalize("NFC")).toBe("é");
  expect(nativeCalls).toBe(0);
});
test("ASCII, CJK, and emoji width controls", () => {
  expect(textGraphemes("A中😀")).toEqual([{ value: "A", width: 1 }, { value: "中", width: 2 }, { value: "😀", width: 2 }]);
  expect(stringWidth("A中😀")).toBe(5);
  expect(nativeCalls).toBe(0);
});
test("ANSI style survives a streaming split and reset", () => {
  const parser = new Parser();
  expect(parser.feed("\x1b[3")).toEqual([]);
  const actions = parser.feed("1mred\x1b[0mplain");
  const texts = actions.filter(action => action.type === "text");
  expect(texts.length).toBe(2);
  expect(texts[0]!.style.fg).toEqual({ type: "named", name: "red" });
  expect(texts[1]!.style.fg).toEqual({ type: "default" });
  parser.reset();
  expect(parser.style.fg).toEqual({ type: "default" });
  expect(nativeCalls).toBe(0);
});
test("complete canonical sequences survive every two-chunk boundary", () => {
  const sequences = ["\x1b[31m", "\x1bOA", "\x1b(B", "\x1b]8;;https://example.invalid\x1b\\", "\x1bP>|owned-fixture\x1b\\", "\x1b[200~", "\x1b[201~"];
  for (const sequence of sequences) {
    for (let offset = 1; offset < sequence.length; offset++) {
      const tokenizer = createTokenizer();
      const tokens = [...tokenizer.feed(sequence.slice(0, offset)), ...tokenizer.feed(sequence.slice(offset))];
      expect(tokens).toEqual([{ type: "sequence", value: sequence }]);
      expect(tokenizer.buffer()).toBe("");
    }
  }
  expect(nativeCalls).toBe(0);
});
test("tokenizer output treats CSI M as output sequence and preserves following text", () => {
  const tokenizer = createTokenizer();
  expect(tokenizer.feed("\x1b[Mabc")).toEqual([{ type: "sequence", value: "\x1b[M" }, { type: "text", value: "abc" }]);
  expect(tokenizer.buffer()).toBe("");
  expect(nativeCalls).toBe(0);
});
test("line cache preserves measured widths across repeated calls and bounded eviction", () => {
  for (const text of ["", "ASCII", "中", "e\u0301", "😀", "\x1b[31mred\x1b[0m"]) {
    expect(lineWidth(text)).toBe(stringWidth(text));
    expect(lineWidth(text)).toBe(stringWidth(text));
  }
  for (let i = 0; i < 4100; i++) lineWidth(`owned-line-${i}`);
  expect(lineWidth("e\u0301")).toBe(1);
  expect(lineWidth("中")).toBe(2);
  expect(nativeCalls).toBe(0);
});
test("content-width arithmetic subtracts both border and padding edges", () => {
  const node = {
    getComputedWidth: () => 40,
    getComputedPadding: (edge: string) => edge === "left" ? 3 : 4,
    getComputedBorder: (edge: string) => edge === "left" ? 1 : 2,
  };
  expect(getMaxWidth(node as never)).toBe(30);
  expect(nativeCalls).toBe(0);
});
