import { describe, it, expect } from "bun:test";
import { buildMigrationSummary } from "./migration-summary.js";

describe("buildMigrationSummary", () => {
  it("joins journal entries oldest-first with title + summary", () => {
    const text = buildMigrationSummary([
      { title: "配环境", summary: "装好了 Bun 和依赖。" },
      { title: "改样式", summary: "把工作台改成了只读预览。" },
    ]);
    expect(text).toContain("【配环境】装好了 Bun 和依赖。");
    expect(text).toContain("【改样式】把工作台改成了只读预览。");
    expect(text.indexOf("配环境")).toBeLessThan(text.indexOf("改样式"));
  });

  it("returns empty string for no entries", () => {
    expect(buildMigrationSummary([])).toBe("");
  });
});
