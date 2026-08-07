import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Panel App install review dialog layout", () => {
  test("keeps long Agent capability lists inside a scroll row above the footer", () => {
    const dialog = readFileSync(join(import.meta.dir, "PanelAppInstallReviewDialog.tsx"), "utf-8");

    expect(dialog).toContain("h-[calc(100vh-2rem)] max-h-[760px]");
    expect(dialog).toContain("w-[calc(100vw-2rem)] max-w-xl");
    expect(dialog).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");
    expect(dialog).toContain("gap-0 overflow-hidden p-0");
    expect(dialog).toContain(
      'className="min-h-0 space-y-3 overflow-y-scroll overscroll-contain px-5 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin]"',
    );
    expect(dialog).toContain(
      '<DialogFooter className="shrink-0 border-t bg-background px-5 py-4">',
    );
    expect(dialog.indexOf("<DialogHeader")).toBeLessThan(dialog.indexOf("overflow-y-scroll"));
    expect(dialog.indexOf("overflow-y-scroll")).toBeLessThan(dialog.indexOf("<DialogFooter"));
  });
});
