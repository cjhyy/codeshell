import { describe, expect, test } from "bun:test";
import { messages } from "./dict";

type Dict = Record<string, unknown>;

/** Flatten a nested message tree into dotted leaf paths. */
function flatten(tree: Dict, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...flatten(v as Dict, path));
    else out.push(path);
  }
  return out;
}

describe("dict coverage", () => {
  test("en provides every key zh has (no untranslated chrome)", () => {
    const zhKeys = flatten(messages.zh).sort();
    const enKeys = flatten(messages.en).sort();
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    expect(missingInEn).toEqual([]);
  });

  test("en has no extra keys absent from zh (zh is source of truth)", () => {
    const zhKeys = flatten(messages.zh);
    const enKeys = flatten(messages.en);
    const extraInEn = enKeys.filter((k) => !zhKeys.includes(k));
    expect(extraInEn).toEqual([]);
  });

  test("the high-visibility chrome namespaces exist", () => {
    const zhKeys = flatten(messages.zh);
    const required = [
      "topbar.expandSidebar",
      "topbar.collapseSidebar",
      "topbar.openPanel",
      "topbar.closePanel",
      "sidebar.pinProject",
      "sidebar.revealInFinder",
      "sidebar.renameProject",
      "sidebar.archiveConversations",
      "sidebar.removeProject",
      "settings.general.languageTitle",
    ];
    for (const k of required) expect(zhKeys).toContain(k);
  });
});
