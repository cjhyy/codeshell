import { expect, test } from "bun:test";
import { messages } from "../../../packages/desktop/src/renderer/i18n/dict";
import { translate } from "../../../packages/desktop/src/renderer/i18n/translate";
import { mobile } from "../../../packages/web/src/i18n/mobile";
import { translate as webTranslate } from "../../../packages/web/src/i18n/translate";

function leaves(value: unknown, prefix = "", result = new Map<string, string>()) {
  if (typeof value === "string") result.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      leaves(entry, prefix ? `${prefix}.${key}` : key, result);
    }
  }
  return result;
}

function placeholders(value: string) {
  return [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
}

test("current assembled dictionary and direct mobile source expose placeholder contracts", () => {
  const zh = leaves(messages.zh);
  const en = leaves(messages.en);
  const differences = [...zh].flatMap(([key, value]) => {
    const english = en.get(key);
    const expected = placeholders(value);
    const actual = placeholders(english ?? "");
    const params = Object.fromEntries(expected.map((name) => [name, `VALUE_${name}`]));
    return english !== undefined && JSON.stringify(expected) !== JSON.stringify(actual)
      ? [{ key, zh: value, en: english, expected, actual,
          translatedZh: translate("zh", key, params), translatedEn: translate("en", key, params) }]
      : [];
  });
  console.log("I18N_PLACEHOLDER_DIFFERENCES", JSON.stringify(differences));
  console.log("I18N_LEAF_COUNTS", JSON.stringify({ zh: zh.size, en: en.size }));
  expect(zh.size).toBeGreaterThan(1000);
  expect([...zh.keys()].filter((key) => !en.has(key))).toEqual([]);
  const mobileZh = leaves(mobile.zh);
  const mobileEn = leaves(mobile.en);
  const mobileDifferences = [...mobileZh].filter(([key, value]) =>
    JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(mobileEn.get(key) ?? "")),
  );
  console.log("DIRECT_MOBILE_PLACEHOLDER_DIFFERENCES", JSON.stringify(mobileDifferences));
  expect(mobileZh.size).toBeGreaterThan(100);
});

test("ordinary interpolation controls preserve literal replacement tokens and unknown fields", () => {
  const dict = { zh: { fixture: "{name} / {count} / {missing}" }, en: { fixture: "{count}: {name} / {missing}" } } as unknown as typeof messages;
  expect(translate("zh", "fixture", { name: "$& $1 $$", count: 0 }, dict))
    .toBe("$& $1 $$ / 0 / {missing}");
  expect(translate("en", "fixture", { name: "汉字", count: 2 }, dict))
    .toBe("2: 汉字 / {missing}");
  expect(translate("en", "not.present", {}, dict)).toBe("not.present");
  expect(webTranslate("en", "mobile.cc.messageCount", { count: 3 })).toBe("3 messages");
});
