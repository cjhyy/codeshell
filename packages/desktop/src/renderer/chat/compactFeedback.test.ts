import { describe, expect, test } from "bun:test";
import type { TFunction } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import {
  compactBoundaryDetail,
  compactOutcomeMessage,
  compactReductionPercent,
  compactStrategyLabel,
  compactWasNoop,
} from "./compactFeedback";

const t =
  (lang: "zh" | "en"): TFunction =>
  (key, params) =>
    translate(lang, key, params);

describe("compact feedback", () => {
  test("formats the no-op outcome as a clear localized notice", () => {
    const result = { before: 40_000, after: 40_000, strategy: "no compaction needed" };

    expect(compactWasNoop(result)).toBe(true);
    expect(compactOutcomeMessage(result, t("zh"), "en-US")).toBe(
      "上下文已是最简,无需压缩(当前约 40,000 tokens)。",
    );
    expect(compactOutcomeMessage(result, t("en"), "en-US")).toBe(
      "Context already minimal - nothing to compact (about 40,000 tokens).",
    );
  });

  test("formats success detail with before/after, saved percent, and strategy label", () => {
    const result = { before: 128_000, after: 46_000, strategy: "summary" };

    expect(compactWasNoop(result)).toBe(false);
    expect(compactReductionPercent(result.before, result.after)).toBe(64);
    expect(compactBoundaryDetail(result, t("zh"), "en-US")).toBe(
      "128,000 → 46,000 tokens(省 64%),策略:摘要",
    );
    expect(compactBoundaryDetail(result, t("en"), "en-US")).toBe(
      "128,000 → 46,000 tokens (saved 64%), strategy: summary",
    );
  });

  test("maps compact strategies to friendly labels", () => {
    expect(compactStrategyLabel("snip", t("zh"))).toBe("裁剪");
    expect(compactStrategyLabel("window", t("en"))).toBe("window");
    expect(compactStrategyLabel("compacted", t("en"))).toBe("general compaction");
    expect(compactStrategyLabel("custom-tier", t("en"))).toBe("custom-tier");
  });
});
