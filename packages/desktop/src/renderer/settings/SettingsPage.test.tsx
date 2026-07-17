import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SettingsPage,
  matchesSettingsModule,
  moduleUsesPageScope,
  preferredModuleForScope,
  type SettingsScope,
} from "./SettingsPage";

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
    expect(html).toContain("w-auto min-w-44 max-w-full");
    expect(html).toContain("这里的默认设置对所有项目生效");
  });

  test("keeps the current module when it supports the next scope", () => {
    const modules = [
      { id: "general", scopes: ["user", "project"] as const },
      { id: "project-overview", scopes: ["project"] as const },
    ];
    const scope: SettingsScope = { kind: "project", path: "/repo" };

    expect(preferredModuleForScope(modules, "general", scope)).toBe("general");
  });

  test("falls back to the remembered module for the next scope", () => {
    const modules = [
      { id: "appearance", scopes: ["user"] as const },
      { id: "project-overview", scopes: ["project"] as const },
      { id: "mcp", scopes: ["user", "project"] as const },
    ];
    const scope: SettingsScope = { kind: "project", path: "/repo" };

    expect(preferredModuleForScope(modules, "appearance", scope, "mcp")).toBe("mcp");
    expect(preferredModuleForScope(modules, "appearance", scope, "appearance")).toBe(
      "project-overview",
    );
  });

  test("distinguishes page-scoped modules from editors with their own safe scope picker", () => {
    expect(moduleUsesPageScope({})).toBe(true);
    expect(moduleUsesPageScope({ scopeControl: "internal" })).toBe(false);
  });

  test("keys section content by the concrete scope target to isolate local drafts", () => {
    const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("contentTargetKey");
    expect(source).toContain("key={contentTargetKey}");
  });
});
