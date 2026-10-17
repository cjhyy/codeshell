import { describe, expect, test } from "bun:test";
import { parseMultipleKeypresses, INITIAL_STATE, type ParsedKey } from "../../../packages/tui/src/render/parse-keypress.ts";
import { InputEvent } from "../../../packages/tui/src/render/events/input-event.ts";
import { KeyboardEvent } from "../../../packages/tui/src/render/events/keyboard-event.ts";

function parseOne(sequence: string): ParsedKey {
  const [items, state] = parseMultipleKeypresses({ ...INITIAL_STATE }, sequence);
  expect(items.length).toBe(1);
  expect(state.mode).toBe("NORMAL");
  expect(state.incomplete).toBe("");
  expect(items[0]!.kind).toBe("key");
  return items[0] as ParsedKey;
}

describe("owned pure input-event characterization: no TTY, Ink, dispatcher, or app", () => {
  test("modifyOtherKeys Shift+A loses the transmitted uppercase codepoint", () => {
    const parsed = parseOne("\x1b[27;2;65~");
    const event = new InputEvent(parsed);
    expect(parsed.name).toBe("a");
    expect(event.key.shift).toBe(true);
    expect(event.key.ctrl).toBe(false);
    expect(event.input).toBe("a"); // observed defect; protocol character code is 65 = A
    expect(event.input).not.toBe(String.fromCodePoint(65));
    expect(new InputEvent(parseOne("A")).input).toBe("A");
  });
  test("modifyOtherKeys Alt+Shift+Q has the same loss with independent modifiers", () => {
    const event = new InputEvent(parseOne("\x1b[27;4;81~"));
    expect(event.input).toBe("q");
    expect(event.key.shift).toBe(true);
    expect(event.key.meta).toBe(true);
    expect(event.key.ctrl).toBe(false);
    expect(new InputEvent(parseOne("\x1b[27;3;113~")).input).toBe("q");
  });
  test("raw lowercase/uppercase, encoded lowercase, and punctuation remain literal", () => {
    for (const [sequence, wanted] of [["a", "a"], ["A", "A"], ["\x1b[27;3;97~", "a"], ["\x1b[27;3;47~", "/"], ["\x1b[27;3;32~", " "]]) {
      expect(new InputEvent(parseOne(sequence!)).input).toBe(wanted!);
    }
  });
  test("KeyboardEvent encodes modified space as the word space instead of literal space", () => {
    for (const sequence of ["\x1b[27;3;32~", "\x1b[32;3u"]) {
      const parsed = parseOne(sequence);
      const keyboard = new KeyboardEvent(parsed);
      expect(keyboard.key).toBe("space");
      expect(keyboard.key).not.toBe(" ");
      expect(keyboard.key.length).toBeGreaterThan(1);
      expect(keyboard.meta).toBe(true);
      expect(new InputEvent(parsed).input).toBe(" ");
    }
    expect(new KeyboardEvent(parseOne(" ")).key).toBe(" ");
  });
  test("KeyboardEvent leaks the legacy Alt printable sequence as its key", () => {
    const keyboard = new KeyboardEvent(parseOne("\x1bz"));
    expect(keyboard.key).toBe("\x1bz");
    expect(keyboard.key).not.toBe("z");
    expect(keyboard.meta).toBe(true);
    expect(new InputEvent(parseOne("\x1bz")).input).toBe("z");
  });
  test("raw printable, arrow, return, and Ctrl shortcut KeyboardEvent controls", () => {
    expect(new KeyboardEvent(parseOne("z")).key).toBe("z");
    expect(new KeyboardEvent(parseOne("3")).key).toBe("3");
    expect(new KeyboardEvent(parseOne("/")).key).toBe("/");
    expect(new KeyboardEvent(parseOne("\x1b[A")).key).toBe("up");
    expect(new KeyboardEvent(parseOne("\r")).key).toBe("return");
    const ctrl = new KeyboardEvent(parseOne("\x03"));
    expect(ctrl.key).toBe("c");
    expect(ctrl.ctrl).toBe(true);
  });
  test("special-event flags and normal paste text remain available", () => {
    const [items] = parseMultipleKeypresses({ ...INITIAL_STATE }, "\x1b[200~Aé中\x1b[201~");
    expect(items.length).toBe(1);
    const paste = items[0] as ParsedKey;
    expect(paste.isPasted).toBe(true);
    expect(new InputEvent(paste).input).toBe("Aé中");
  });
});
