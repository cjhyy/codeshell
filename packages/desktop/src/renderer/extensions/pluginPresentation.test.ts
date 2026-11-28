import { describe, expect, test } from "bun:test";
import type { NativePluginReview } from "../../preload/types";
import {
  changePluginApproval,
  changePluginHookApproval,
  changePluginMcpApproval,
  nativeRuntimeOf,
  nativeSurfaceRows,
  pluginLegalLinks,
  pluginLogoSources,
  pluginScreenshotDataUrls,
  safePluginImageDataUrl,
  safePluginComposerIconDataUrl,
  shouldLoadPluginListMedia,
  summarizePluginHookApproval,
} from "./pluginPresentation";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const WEBP = "data:image/webp;base64,UklGRg==";

describe("plugin presentation", () => {
  test("selects the logo, dark logo, and composer icon fallback from safe data URLs", () => {
    expect(
      pluginLogoSources({
        composerIconDataUrl: PNG,
        logoDataUrl: WEBP,
        logoDarkDataUrl: PNG,
        screenshotDataUrls: [],
      }),
    ).toEqual({ light: WEBP, dark: PNG });
    expect(
      pluginLogoSources({
        composerIconDataUrl: PNG,
        screenshotDataUrls: [],
      }),
    ).toEqual({ light: PNG, dark: PNG });
    expect(
      pluginLogoSources({
        logoDarkDataUrl: WEBP,
        screenshotDataUrls: [],
      }),
    ).toEqual({ light: WEBP, dark: WEBP });
  });

  test("rejects SVG/script data URLs and bounds screenshots to three", () => {
    expect(safePluginImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
    expect(
      pluginScreenshotDataUrls({
        screenshotDataUrls: [PNG, PNG, "javascript:alert(1)", PNG, PNG],
      }),
    ).toEqual([PNG, PNG, PNG]);
  });

  test("permits only a bounded composer SVG transport and keeps other slots raster-only", () => {
    const vector = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(safePluginComposerIconDataUrl(vector)).toBe(vector);
    expect(pluginLogoSources({ composerIconDataUrl: vector, screenshotDataUrls: [] })).toEqual({
      light: vector,
      dark: vector,
    });
    expect(
      pluginLogoSources({ composerIconDataUrl: vector, logoDataUrl: PNG, screenshotDataUrls: [] }),
    ).toEqual({ light: PNG, dark: PNG });
    expect(
      pluginLogoSources({ logoDataUrl: vector, logoDarkDataUrl: vector, screenshotDataUrls: [] }),
    ).toEqual({ light: undefined, dark: undefined });
    expect(pluginScreenshotDataUrls({ screenshotDataUrls: [vector, PNG] })).toEqual([PNG]);
    for (const unsafe of [
      "<svg/>",
      "https://example.com/icon.svg",
      "file:///icon.svg",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+",
      "data:image/svg+xml;base64,%50HN2Zy8+",
      "data:image/svg+xml;base64,",
      "data:image/svg+xml;base64,A===",
      "data:image/svg+xml;base64,AB==",
      "data:image/svg+xml;base64,AAA",
      "data:image/svg+xml;base64,PHN2Zy8+\n",
    ])
      expect(safePluginComposerIconDataUrl(unsafe)).toBeUndefined();
    const atLimit = Buffer.alloc(2 * 1024 * 1024).toString("base64");
    expect(safePluginComposerIconDataUrl(`data:image/svg+xml;base64,${atLimit}`)).toBeDefined();
    expect(
      safePluginComposerIconDataUrl(
        `data:image/svg+xml;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}`,
      ),
    ).toBeUndefined();
  });

  test("loads list media for a dark-only logo declaration", () => {
    expect(
      shouldLoadPluginListMedia({
        composerIcon: false,
        logo: false,
        logoDark: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadPluginListMedia({
        composerIcon: false,
        logo: false,
        logoDark: false,
      }),
    ).toBe(false);
  });

  test("summarizes hook approval with pending taking precedence", () => {
    expect(summarizePluginHookApproval([])).toBeNull();
    expect(summarizePluginHookApproval([{ approval: "none" }])).toBeNull();
    expect(summarizePluginHookApproval([{ approval: "approved" }])).toBe("approved");
    expect(summarizePluginHookApproval([{ approval: "approved" }, { approval: "none" }])).toBe(
      "approved",
    );
    expect(summarizePluginHookApproval([{ approval: "approved" }, { approval: "pending" }])).toBe(
      "pending",
    );
  });

  test("routes explicit hook approval actions through the preload contract", async () => {
    const calls: string[] = [];
    const api = {
      approvePluginHooks: async (installKey: string) => {
        calls.push(`approve:${installKey}`);
        return [];
      },
      revokePluginHooks: async (installKey: string) => {
        calls.push(`revoke:${installKey}`);
        return [];
      },
    };

    await changePluginHookApproval(api, "approve", "demo@local");
    await changePluginHookApproval(api, "revoke", "demo@local");
    expect(calls).toEqual(["approve:demo@local", "revoke:demo@local"]);
  });

  test("routes explicit MCP approval actions through the preload contract", async () => {
    const calls: string[] = [];
    const api = {
      approvePluginMcp: async (installKey: string) => {
        calls.push(`approve:${installKey}`);
        return [];
      },
      revokePluginMcp: async (installKey: string) => {
        calls.push(`revoke:${installKey}`);
        return [];
      },
    };

    await changePluginMcpApproval(api, "approve", "demo@local");
    await changePluginMcpApproval(api, "revoke", "demo@local");
    expect(calls).toEqual(["approve:demo@local", "revoke:demo@local"]);
  });

  test("exposes only absolute HTTPS legal links", () => {
    expect(
      pluginLegalLinks({
        websiteURL: "https://example.com/plugin",
        privacyPolicyURL: "file:///tmp/privacy.html",
        termsOfServiceURL: "https://user:password@example.com/terms",
      }),
    ).toEqual([{ kind: "website", url: "https://example.com/plugin" }]);
  });
});

describe("native plugin presentation", () => {
  const surface = {
    apiVersion: 1,
    hooks: ["pre_tool_use"],
    tools: ["lookup", "search"],
    presets: [],
    promptSections: [],
    context: ["status"],
    background: false,
    coreCapabilities: [],
    hostCapabilities: [],
  };

  test("lists what a plugin declares and marks only real changes since the last approval", () => {
    const first: NativePluginReview = {
      installKey: "demo@local",
      plugin: "demo",
      state: "pending",
      surface,
      baselineAvailable: false,
      diff: { added: { tools: ["lookup", "search"] }, removed: {} },
    };
    // A first approval has nothing to compare with: nothing is marked.
    expect(nativeSurfaceRows(first)).toEqual([
      { list: "hooks", items: [{ name: "pre_tool_use" }] },
      { list: "tools", items: [{ name: "lookup" }, { name: "search" }] },
      { list: "context", items: [{ name: "status" }] },
    ]);

    const update: NativePluginReview = {
      ...first,
      baselineAvailable: true,
      diff: { added: { tools: ["search"] }, removed: { tools: ["old"], hooks: ["on_stop"] } },
    };
    expect(nativeSurfaceRows(update)).toEqual([
      {
        list: "hooks",
        items: [{ name: "pre_tool_use" }, { name: "on_stop", change: "removed" }],
      },
      {
        list: "tools",
        items: [
          { name: "lookup" },
          { name: "search", change: "added" },
          { name: "old", change: "removed" },
        ],
      },
      { list: "context", items: [{ name: "status" }] },
    ]);
    expect(nativeSurfaceRows({ ...first, state: "invalid", surface: undefined })).toEqual([]);
  });

  test("finds one plugin in the runtime view, or says why it is not there", () => {
    const status = {
      installKey: "demo@local",
      plugin: "demo",
      moduleId: "plugin-demo-0123abcd",
      state: "running" as const,
      restarts: 0,
      calls: 2,
      failures: 0,
      timeouts: 0,
      logFile: "/logs/plugin-demo-0123abcd.log",
    };
    expect(nativeRuntimeOf(null, "demo@local")).toEqual({ kind: "unknown" });
    expect(nativeRuntimeOf({ kind: "off" }, "demo@local")).toEqual({ kind: "off" });
    expect(nativeRuntimeOf({ kind: "no-worker" }, "demo@local")).toEqual({ kind: "no-worker" });
    expect(nativeRuntimeOf({ kind: "loaded", plugins: [status] }, "demo@local")).toEqual({
      kind: "status",
      status,
    });
    expect(nativeRuntimeOf({ kind: "loaded", plugins: [status] }, "other@local")).toEqual({
      kind: "not-in-worker",
    });
  });

  test("approves and revokes the whole plugin through one call each", async () => {
    const calls: string[] = [];
    const api = {
      approvePlugin: async (key: string) => {
        calls.push(`approve:${key}`);
        return [];
      },
      revokePlugin: async (key: string) => {
        calls.push(`revoke:${key}`);
        return [];
      },
    };
    await changePluginApproval(api, "approve", "demo@local");
    await changePluginApproval(api, "revoke", "demo@local");
    expect(calls).toEqual(["approve:demo@local", "revoke:demo@local"]);
  });
});
