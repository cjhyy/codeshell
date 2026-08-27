import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesOverviewSection, capabilityCacheKey } from "./CapabilitiesOverviewSection";
import { saveProjects } from "../projects";

saveProjects([
  {
    id: "project-a",
    name: "Alpha",
    path: "/a",
    roots: [{ id: "root-a", path: "/a", name: "Alpha", addedAt: 1 }],
    primaryRootId: "root-a",
    addedAt: 1,
  },
]);

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

  // The group renders behind `!loading`, and useEffect does not run here, so
  // the loading shell must not leak it in either scope. The project-scope-only
  // rule itself is asserted in capabilitiesOverview.test.ts as a predicate.
  test("the loading shell shows no Panel Apps group in either scope", () => {
    for (const html of [
      renderToStaticMarkup(
        <CapabilitiesOverviewSection scope="project" projectPath="/a" projectLabel="Alpha" />,
      ),
      renderToStaticMarkup(<CapabilitiesOverviewSection scope="user" projectPath={null} />),
    ]) {
      expect(html).not.toContain("面板应用");
    }
  });
});
