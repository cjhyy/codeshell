import { describe, expect, test } from "bun:test";
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedKey } from "../parse-keypress.js";
import { InputEvent } from "./input-event.js";
import { KeyboardEvent } from "./keyboard-event.js";

function parseOne(sequence: string): ParsedKey {
  const [items] = parseMultipleKeypresses({ ...INITIAL_STATE }, sequence);
  expect(items).toHaveLength(1);
  return items[0] as ParsedKey;
}

describe("modifyOtherKeys printable input", () => {
  test("Shift+A keeps the transmitted uppercase character", () => {
    const event = new InputEvent(parseOne("\x1b[27;2;65~"));
    expect(event.input).toBe("A");
    expect(event.key.shift).toBe(true);
    expect(event.key.ctrl).toBe(false);
  });

  test("Alt+Shift+Q keeps the uppercase character with independent modifiers", () => {
    const event = new InputEvent(parseOne("\x1b[27;4;81~"));
    expect(event.input).toBe("Q");
    expect(event.key.shift).toBe(true);
    expect(event.key.meta).toBe(true);
  });

  test("Ctrl shortcuts keep the normalized lowercase name", () => {
    const event = new InputEvent(parseOne("\x1b[27;6;65~"));
    expect(event.input).toBe("a");
    expect(event.key.ctrl).toBe(true);
    expect(new InputEvent(parseOne("\x1b[27;3;97~")).input).toBe("a");
    expect(new InputEvent(parseOne("\x1b[27;3;47~")).input).toBe("/");
    expect(new InputEvent(parseOne("\x1b[27;3;32~")).input).toBe(" ");
  });
});

describe("KeyboardEvent.key for printable keys", () => {
  test("modified space is the literal space character", () => {
    for (const sequence of ["\x1b[27;3;32~", "\x1b[32;3u"]) {
      const keyboard = new KeyboardEvent(parseOne(sequence));
      expect(keyboard.key).toBe(" ");
      expect(keyboard.meta).toBe(true);
    }
  });

  test("ESC-prefixed Alt+letter reports the letter with meta", () => {
    const keyboard = new KeyboardEvent(parseOne("\x1bz"));
    expect(keyboard.key).toBe("z");
    expect(keyboard.meta).toBe(true);
    expect(new KeyboardEvent(parseOne("\x1bQ")).key).toBe("Q");
  });

  test("plain printable, special and Ctrl keys are unchanged", () => {
    expect(new KeyboardEvent(parseOne("z")).key).toBe("z");
    expect(new KeyboardEvent(parseOne(" ")).key).toBe(" ");
    expect(new KeyboardEvent(parseOne("\x1b[A")).key).toBe("up");
    expect(new KeyboardEvent(parseOne("\x1b[1;3A")).key).toBe("up");
    expect(new KeyboardEvent(parseOne("\r")).key).toBe("return");
    expect(new KeyboardEvent(parseOne("\x03")).key).toBe("c");
  });
});
