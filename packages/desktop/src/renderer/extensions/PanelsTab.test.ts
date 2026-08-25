import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastProvider } from "../ui/ToastProvider";
import { nextPanelAppBindings, PanelsTab } from "./PanelsTab";
import {
  OFFICIAL_PANEL_APP_REPOSITORY,
  recommendedPanelApps,
  recommendedPanelSource,
} from "./panelAppRecommendations";

describe("Panel App controls", () => {
  const appId = "design-studio";

  test("project binding adds and removes only the selected app", () => {
    expect(nextPanelAppBindings(["quant-lab"], appId, true)).toEqual([appId, "quant-lab"]);
    expect(nextPanelAppBindings(["quant-lab", appId], appId, false)).toEqual(["quant-lab"]);
    expect(nextPanelAppBindings([42, appId, null], appId, false)).toEqual([]);
  });

  test("ships distinct official recommendations that point to exact apps", () => {
    expect(recommendedPanelApps.map((app) => app.id)).toEqual([
      "video-download",
      "design-studio",
      "job-hunt-hq",
      "quant-lab",
    ]);
    expect(new Set(recommendedPanelApps.map((app) => app.subdir)).size).toBe(
      recommendedPanelApps.length,
    );
    expect(recommendedPanelSource(recommendedPanelApps[0])).toEqual({
      kind: "git",
      url: OFFICIAL_PANEL_APP_REPOSITORY,
      ref: "main",
      subdir: "apps/video-download",
    });
  });

  test("renders the official recommendations before any remote request", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          DialogProvider,
          null,
          React.createElement(PanelsTab, {
            cwd: "/tmp/project",
            activeProjectPath: "/tmp/project",
            query: "",
          }),
        ),
      ),
    );
    expect(html).toContain("推荐面板");
    expect(html).toContain("Mimi Download");
    expect(html).toContain("设计工作台");
    expect(html).toContain("求职作战室");
    expect(html).toContain("量化实验室");
    expect(html).toContain("查看仓库全部面板");
  });
});
