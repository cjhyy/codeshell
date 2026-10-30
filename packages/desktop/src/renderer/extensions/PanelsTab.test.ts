import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastProvider } from "../ui/ToastProvider";
import { nextPanelAppBindings, PanelsTab, readProjectBindings } from "./PanelsTab";
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

describe("project binding reads", () => {
  const state = (path: string) => [
    {
      appId: path,
      revision: "r",
      bound: true,
      globalDisabled: false,
      version: "1.0.0",
    },
  ];
  const withBridge = async (bridge: Record<string, unknown>, run: () => Promise<void>) => {
    const target = globalThis as { window?: { codeshell?: unknown } };
    const previous = target.window;
    target.window = { codeshell: bridge };
    try {
      await run();
    } finally {
      target.window = previous;
    }
  };

  test("reads all projects in one host batch per 64 paths, in order", async () => {
    const paths = Array.from({ length: 65 }, (_, index) => `/p${index}`);
    const batches: string[][] = [];
    const single: string[] = [];
    await withBridge(
      {
        getPanelAppBindingsForProjects: async (chunk: string[]) => {
          batches.push(chunk);
          return chunk.map((path) => (path === "/p1" ? null : state(path)));
        },
        getPanelAppBindings: async (path: string) => {
          single.push(path);
          return state(path);
        },
      },
      async () => {
        const result = await readProjectBindings(paths);
        expect(result).toHaveLength(65);
        expect(result[0]).toEqual(state("/p0"));
        expect(result[1]).toBeNull();
        expect(result[64]).toEqual(state("/p64"));
      },
    );
    expect(batches.map((chunk) => chunk.length)).toEqual([64, 1]);
    expect(single).toEqual([]);
  });

  test("falls back to per-project reads on an older or failing host", async () => {
    const single: string[] = [];
    const getPanelAppBindings = async (path: string) => {
      single.push(path);
      if (path === "/bad") throw new Error("not registered");
      return state(path);
    };
    await withBridge({ getPanelAppBindings }, async () => {
      expect(await readProjectBindings(["/a", "/bad"])).toEqual([state("/a"), null]);
    });
    await withBridge(
      {
        getPanelAppBindingsForProjects: async () => {
          throw new Error("No handler registered");
        },
        getPanelAppBindings,
      },
      async () => {
        expect(await readProjectBindings(["/b"])).toEqual([state("/b")]);
      },
    );
    expect(single).toEqual(["/a", "/bad", "/b"]);
  });
});
