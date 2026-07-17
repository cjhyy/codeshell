import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HooksSection, hookDraftKey } from "./AdvancedSections";

describe("HooksSection", () => {
  test("renders the user-level editor without a second scope picker", () => {
    const html = renderToStaticMarkup(<HooksSection scope="user" projectPath={null} />);

    expect(html).toContain("全局钩子");
    expect(html).not.toContain("返回列表");
    expect(html).not.toContain("还没有添加任何项目");
  });

  test("renders the selected project's hook editor", () => {
    const html = renderToStaticMarkup(
      <HooksSection scope="project" projectPath="/workspace/alpha" />,
    );

    expect(html).toContain("项目钩子");
    expect(html).not.toContain("返回列表");
  });

  test("keeps add-hook drafts isolated by settings scope", () => {
    expect(hookDraftKey("user", null)).toBe("__user__");
    expect(hookDraftKey("project", "/workspace/alpha")).toBe("/workspace/alpha");
  });
});
