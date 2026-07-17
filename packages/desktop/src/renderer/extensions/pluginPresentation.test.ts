import { describe, expect, test } from "bun:test";
import {
  changePluginHookApproval,
  changePluginMcpApproval,
  pluginLegalLinks,
  pluginLogoSources,
  pluginScreenshotDataUrls,
  safePluginImageDataUrl,
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

  test("summarizes hook approval with fail-closed states taking precedence", () => {
    expect(summarizePluginHookApproval([])).toBeNull();
    expect(summarizePluginHookApproval([{ approval: "none" }])).toBeNull();
    expect(summarizePluginHookApproval([{ approval: "approved" }])).toBe("approved");
    expect(summarizePluginHookApproval([{ approval: "approved" }, { approval: "legacy" }])).toBe(
      "legacy",
    );
    expect(summarizePluginHookApproval([{ approval: "approved" }, { approval: "pending" }])).toBe(
      "pending",
    );
    expect(summarizePluginHookApproval([{ approval: "pending" }, { approval: "changed" }])).toBe(
      "changed",
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
