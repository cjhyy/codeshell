import { describe, expect, test } from "bun:test";
import { planKeySequence, keyInfo, normalizeKey } from "./keymap.js";

describe("keyInfo", () => {
  test("named keys", () => {
    expect(keyInfo("Enter")).toEqual({ code: "Enter", windowsVirtualKeyCode: 13 });
    expect(keyInfo("Tab")).toEqual({ code: "Tab", windowsVirtualKeyCode: 9 });
    expect(keyInfo("Escape")).toEqual({ code: "Escape", windowsVirtualKeyCode: 27 });
    expect(keyInfo("ArrowDown")).toEqual({ code: "ArrowDown", windowsVirtualKeyCode: 40 });
    expect(keyInfo("F5")).toEqual({ code: "F5", windowsVirtualKeyCode: 116 });
  });
  test("single chars derive Key*/Digit*", () => {
    expect(keyInfo("a")).toEqual({ code: "KeyA", windowsVirtualKeyCode: 65 });
    expect(keyInfo("Z")).toEqual({ code: "KeyZ", windowsVirtualKeyCode: 90 });
    expect(keyInfo("3")).toEqual({ code: "Digit3", windowsVirtualKeyCode: 51 });
  });
});

describe("normalizeKey", () => {
  test("aliases map to canonical", () => {
    expect(normalizeKey("ctrl")).toBe("Control");
    expect(normalizeKey("cmd")).toBe("Meta");
    expect(normalizeKey("esc")).toBe("Escape");
    expect(normalizeKey("Enter")).toBe("Enter");
  });
});

describe("planKeySequence", () => {
  test("ControlOrMeta follows the target platform and supports mac editing commands", () => {
    const mac = planKeySequence("ControlOrMeta+c", "mac");
    expect(mac[1]).toMatchObject({ key: "c", modifiers: 4, commands: ["copy"] });
    expect(mac[1]).not.toHaveProperty("text");
    expect(mac[2]).not.toHaveProperty("commands");
    const other = planKeySequence("ControlOrMeta+c", "other");
    expect(other[1]).toMatchObject({ key: "c", modifiers: 2 });
    expect(other[1]).not.toHaveProperty("commands");
  });

  test("literal Control keeps its semantics on macOS; Meta shortcuts edit normally", () => {
    expect(planKeySequence("Control+c", "mac")[1]).toMatchObject({ key: "c", modifiers: 2 });
    expect(planKeySequence("Control+c", "mac")[1]).not.toHaveProperty("commands");
    expect(planKeySequence("Meta+a", "mac")[1]?.commands).toEqual(["selectAll"]);
    expect(planKeySequence("ControlOrMeta+Shift+z", "mac")[2]?.commands).toEqual(["redo"]);
    expect(planKeySequence("ControlOrMeta+Alt+c", "mac")[2]).not.toHaveProperty("commands");
  });
  test("single key → keyDown + keyUp", () => {
    const seq = planKeySequence("Enter");
    expect(seq.map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    expect(seq[0]).toMatchObject({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    expect(seq[1]).not.toHaveProperty("text");
  });

  test("combination → modifier down, main down/up with bitmask, modifier up reversed", () => {
    const seq = planKeySequence("Control+a");
    expect(seq.map((e) => `${e.type}:${e.key}`)).toEqual([
      "keyDown:Control",
      "keyDown:a",
      "keyUp:a",
      "keyUp:Control",
    ]);
    // Control bit = 2, applied to main key events
    const mainDown = seq.find((e) => e.type === "keyDown" && e.key === "a");
    expect(mainDown?.modifiers).toBe(2);
  });

  test("multi-modifier bitmask OR (Meta+Shift+z)", () => {
    const seq = planKeySequence("Meta+Shift+z");
    const mainDown = seq.find((e) => e.key === "z" && e.type === "keyDown");
    expect(mainDown?.modifiers).toBe(4 | 8); // Meta=4, Shift=8
    expect(seq.map((e) => `${e.type}:${e.key}`)).toEqual([
      "keyDown:Meta",
      "keyDown:Shift",
      "keyDown:z",
      "keyUp:z",
      "keyUp:Shift",
      "keyUp:Meta",
    ]);
  });
});
