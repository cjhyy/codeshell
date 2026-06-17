import { describe, expect, test } from "bun:test";
import { translate } from "./translate";
import { messages } from "./dict";

describe("translate", () => {
  test("hits the requested language", () => {
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("zh", "common.cancel")).toBe("取消");
  });

  test("falls back to zh when the en entry is missing", () => {
    // Craft a dict where en lacks a key that zh has.
    const partial = {
      zh: { only: { zh: "仅中文" } },
      en: {},
    } as unknown as typeof messages;
    expect(translate("en", "only.zh", undefined, partial)).toBe("仅中文");
  });

  test("falls back to the raw key when neither language has it", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
    expect(translate("zh", "totally.unknown.key")).toBe("totally.unknown.key");
  });

  test("interpolates {name} placeholders", () => {
    expect(translate("en", "greeting.hello", { name: "Ada" })).toBe("Hello, Ada");
    expect(translate("zh", "greeting.hello", { name: "小红" })).toBe("你好,小红");
  });

  test("interpolates numeric params and stringifies them", () => {
    const dict = {
      zh: { count: { n: "共 {n} 项" } },
      en: { count: { n: "{n} items" } },
    } as unknown as typeof messages;
    expect(translate("en", "count.n", { n: 3 }, dict)).toBe("3 items");
  });

  test("leaves unknown placeholders intact", () => {
    const dict = {
      zh: { x: { y: "{a} 和 {b}" } },
      en: {},
    } as unknown as typeof messages;
    expect(translate("zh", "x.y", { a: "甲" }, dict)).toBe("甲 和 {b}");
  });

  test("does not interpolate when no params are given", () => {
    expect(translate("en", "greeting.hello")).toBe("Hello, {name}");
  });

  test("a non-leaf (intermediate) key falls through to the raw key", () => {
    // "common" is an object, not a string leaf.
    expect(translate("en", "common")).toBe("common");
  });
});
