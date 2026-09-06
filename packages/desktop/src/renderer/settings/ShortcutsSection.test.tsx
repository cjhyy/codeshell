import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutsSection } from "./ShortcutsSection";
import { ShortcutsSection as CompatibilityExport } from "./AdvancedSections";

let storageBefore: PropertyDescriptor | undefined;
beforeEach(() => {
  storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
});
afterEach(() => {
  if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("platform-aware keyboard shortcut reference", () => {
  test.each([
    { lang: "zh", isMac: true },
    { lang: "zh", isMac: false },
    { lang: "en", isMac: true },
    { lang: "en", isMac: false },
  ])("renders accurate $lang shortcuts when isMac=$isMac", ({ lang, isMac }) => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => lang },
    });
    const html = renderToStaticMarkup(<ShortcutsSection isMac={isMac} />);
    const keys = Array.from(html.matchAll(/<kbd\b[^>]*>(.*?)<\/kbd>/g), (match) => match[1]);
    const mod = isMac ? "⌘" : "Ctrl";
    expect(keys).toEqual([
      mod,
      "K",
      mod,
      "P",
      mod,
      "B",
      mod,
      "1–9",
      ...(isMac ? [mod, "Shift", "N"] : []),
      mod,
      "F",
      "Enter",
      "Shift",
      "Enter",
      "↑",
      "↓",
    ]);
    expect(html).toContain(`aria-label="${lang === "zh" ? "键盘快捷键" : "Keyboard shortcuts"}"`);
    expect(html).toContain(lang === "zh" ? "应用导航" : "App navigation");
    expect(html).toContain(lang === "zh" ? "对话与输入" : "Conversation and input");
    expect(html).toContain(lang === "zh" ? "输入区为空时开始回看历史" : "when the input is empty");
    expect(html).toContain(lang === "zh" ? "较新的输入或原草稿" : "return to your draft");
    expect(html).toContain(`${mod} + F`);
    expect(html).toContain(lang === "zh" ? "搜索设置" : "searches settings");
    expect((html.match(/<dt\b/g) ?? []).length).toBe(isMac ? 10 : 9);
    expect(html.includes(lang === "zh" ? "新窗口" : "New window")).toBe(isMac);
    // The removed inspector action and macOS-only native Add Project command
    // are not presented as cross-platform shortcuts.
    expect(keys).not.toContain("I");
    expect(keys).not.toContain("O");
    expect(html).toContain(`aria-label="${lang === "zh" ? "向上方向键" : "Up arrow"}"`);
  });

  test("preserves the AdvancedSections export for existing callers", () => {
    expect(CompatibilityExport).toBe(ShortcutsSection);
  });
});
