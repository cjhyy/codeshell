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
    const html = renderToStaticMarkup(<CapabilitiesOverviewSection projects={[]} />);
    expect(html).toContain("能力总览");
    expect(html).toContain("项目设置独立覆盖");
    // Left tree always shows the user node.
    expect(html).toContain("用户(全局)");
    expect(html).toContain("项目配置");
    // Initial render before the effect fires shows the loading line.
    expect(html).toContain("加载中");
  });

  test("renders a tree node per project", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection
        projects={[
          { id: "1", name: "alpha", path: "/a", addedAt: 0 },
          { id: "2", name: "beta", path: "/b", addedAt: 0, displayName: "Beta!" },
        ]}
      />,
    );
    expect(html).toContain("alpha");
    expect(html).toContain("Beta!");
  });

  test("can start on the current project instead of the global scope", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection
        projects={[{ id: "1", name: "alpha", path: "/a", addedAt: 0 }]}
        initialProjectPath="/a"
      />,
    );
    expect(html).toContain("为这个项目单独覆盖 MCP、技能和插件");
    expect(html).not.toContain("设置所有项目继承的默认能力");
  });
});
