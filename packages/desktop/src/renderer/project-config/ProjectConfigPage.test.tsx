import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectConfigPage } from "./ProjectConfigPage";

describe("ProjectConfigPage", () => {
  test("renders an overview with focused project configuration modules", () => {
    const html = renderToStaticMarkup(
      <ProjectConfigPage
        cwd="/repo"
        project={{ id: "repo", name: "repo", path: "/repo", addedAt: 0 }}
        onBack={() => undefined}
      />,
    );

    expect(html).toContain("数据源");
    expect(html).toContain("数字人");
    expect(html).toContain("项目指令");
    expect(html).toContain("能力");
    expect(html).toContain("配置这个项目");
    expect(html).toContain('aria-label="项目配置导航"');
    expect(html).toContain("/repo");
  });
});
