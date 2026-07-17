import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesOverviewSection, capabilityCacheKey } from "./CapabilitiesOverviewSection";

// useEffect (the data fetch) does not run under renderToStaticMarkup, so the
// static render is the loading shell. The grouping/collapse/toggle logic is
// covered by capabilitiesOverview.test.ts; here we only assert the section
// frame renders without needing window.codeshell at module load.
describe("CapabilitiesOverviewSection", () => {
  test("renders the section header, tree, and loading line", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection scope="user" projectPath={null} />,
    );
    expect(html).toContain("能力总览");
    expect(html).toContain("项目设置独立覆盖");
    expect(html).toContain("用户(全局)");
    expect(html).toContain("加载中");
  });

  test("renders the selected project without a second scope picker", () => {
    const html = renderToStaticMarkup(
      <CapabilitiesOverviewSection scope="project" projectPath="/a" projectLabel="Alpha" />,
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("/a");
    expect(html).toContain("为这个项目单独覆盖 MCP、技能和插件");
    expect(html).not.toContain("设置所有项目继承的默认能力");
    expect(html).not.toContain('aria-label="能力配置范围"');
  });

  test("separates cached snapshots by scope", () => {
    expect(capabilityCacheKey("user", null)).toBe("caps:");
    expect(capabilityCacheKey("project", "/a")).toBe("caps:/a");
  });
});
