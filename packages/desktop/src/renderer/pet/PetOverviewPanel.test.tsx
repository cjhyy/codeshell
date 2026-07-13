import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clampPetOverviewWidth,
  PetOverviewPanel,
  PET_OVERVIEW_DEFAULT_WIDTH,
} from "./PetOverviewPanel";

describe("PetOverviewPanel", () => {
  test("is a resizable sidebar sidecar with an accessible close control", () => {
    const html = renderToStaticMarkup(
      <PetOverviewPanel width={PET_OVERVIEW_DEFAULT_WIDTH} onClose={() => undefined}>
        <div>world pane</div>
        <div>chat slot</div>
      </PetOverviewPanel>,
    );

    expect(html).toContain('data-pet-overview="sidecar"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('data-pet-overview-heading="focus-target"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-label="调整 Pet 概览宽度"');
    expect(html).toContain('aria-label="关闭 Pet 概览"');
    expect(html).toContain("world pane");
    expect(html).toContain("chat slot");
    expect(html).toContain("grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]");
  });

  test("clamps persisted width to the safe viewport range", () => {
    expect(clampPetOverviewWidth(100, 1_440)).toBe(520);
    expect(clampPetOverviewWidth(760, 1_440)).toBe(760);
    expect(clampPetOverviewWidth(2_000, 1_440)).toBe(1_037);
    expect(clampPetOverviewWidth(Number.NaN, 1_440)).toBe(PET_OVERVIEW_DEFAULT_WIDTH);
  });
});
