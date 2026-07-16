import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage, matchesSettingsModule } from "./SettingsPage";

describe("SettingsPage", () => {
  test("matches modules by localized label or group title", () => {
    expect(matchesSettingsModule("MCP", "MCP 服务器", "扩展能力")).toBe(true);
    expect(matchesSettingsModule("扩展", "子代理", "扩展能力")).toBe(true);
    expect(matchesSettingsModule("主题", "外观", "")).toBe(false);
  });

  test("renders searchable desktop navigation and a compact mobile picker", () => {
    const html = renderToStaticMarkup(
      <SettingsPage
        activeProjectPath={null}
        projects={[]}
        sessionIndices={{}}
        onRestoreArchivedSession={() => undefined}
        onDeleteArchivedSession={() => undefined}
        isMac={false}
        isFullscreen={false}
        onBack={() => undefined}
      />,
    );

    expect(html).toContain("搜索设置");
    expect(html).toContain('aria-label="设置导航"');
    expect(html).toContain("这里的默认设置对所有项目生效");
  });
});
