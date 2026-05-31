import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesOverviewSection } from "./CapabilitiesOverviewSection";

// useEffect (the data fetch) does not run under renderToStaticMarkup, so the
// static render is the loading shell. The grouping/collapse/toggle logic is
// covered by capabilitiesOverview.test.ts; here we only assert the section
// frame renders without needing window.codeshell at module load.
describe("CapabilitiesOverviewSection", () => {
  test("renders the section header and help", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection scope="user" activeRepoPath={null} />,
    );
    expect(html).toContain("能力总览");
    expect(html).toContain("统一开关");
    // Initial render before the effect fires shows the loading line.
    expect(html).toContain("加载中");
  });
});
