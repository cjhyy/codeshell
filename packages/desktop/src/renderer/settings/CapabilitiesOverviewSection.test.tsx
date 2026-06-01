import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesOverviewSection } from "./CapabilitiesOverviewSection";

// useEffect (the data fetch) does not run under renderToStaticMarkup, so the
// static render is the loading shell. The grouping/collapse/toggle logic is
// covered by capabilitiesOverview.test.ts; here we only assert the section
// frame renders without needing window.codeshell at module load.
describe("CapabilitiesOverviewSection", () => {
  test("renders the section header, tree, and loading line", () => {
    const html = renderToStaticMarkup(<CapabilitiesOverviewSection repos={[]} />);
    expect(html).toContain("能力总览");
    expect(html).toContain("统一开关");
    // Left tree always shows the user node.
    expect(html).toContain("用户(全局)");
    // Initial render before the effect fires shows the loading line.
    expect(html).toContain("加载中");
  });

  test("renders a tree node per project", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection
        repos={[
          { id: "1", name: "alpha", path: "/a", addedAt: 0 },
          { id: "2", name: "beta", path: "/b", addedAt: 0, displayName: "Beta!" },
        ]}
      />,
    );
    expect(html).toContain("alpha");
    expect(html).toContain("Beta!");
  });
});
