import { describe, expect, test } from "bun:test";
import { normalizePluginDisplayMetadata } from "./plugin-display-metadata.js";

describe("normalizePluginDisplayMetadata", () => {
  test("projects normalized Codex interface metadata", () => {
    expect(
      normalizePluginDisplayMetadata("video-editor", {
        description: "Fallback description",
        interface: {
          displayName: "Video Editor",
          shortDescription: "Trim and reframe local video",
          longDescription: "Build a reviewed plan and render it with FFmpeg.",
          developerName: "CodeShell",
          category: "Creative",
          capabilities: ["Read", "Write"],
          websiteURL: "https://example.com/video-editor",
          privacyPolicyURL: "https://example.com/privacy",
          termsOfServiceURL: "https://example.com/terms",
          defaultPrompt: ["Trim this video into a short clip."],
          brandColor: "#10A37F",
        },
      }),
    ).toEqual({
      displayName: "Video Editor",
      description: "Trim and reframe local video",
      longDescription: "Build a reviewed plan and render it with FFmpeg.",
      developerName: "CodeShell",
      category: "Creative",
      capabilities: ["Read", "Write"],
      websiteURL: "https://example.com/video-editor",
      privacyPolicyURL: "https://example.com/privacy",
      termsOfServiceURL: "https://example.com/terms",
      defaultPrompt: ["Trim this video into a short clip."],
      brandColor: "#10A37F",
    });
  });

  test("sanitizes malformed legacy metadata", () => {
    expect(
      normalizePluginDisplayMetadata("legacy", {
        description: "Fallback",
        interface: {
          displayName: 42,
          capabilities: "Write",
          defaultPrompt: [null, "Valid"],
          brandColor: "url(javascript:bad)",
          websiteURL: "javascript:alert(1)",
          privacyPolicyURL: "file:///tmp/privacy.html",
          termsOfServiceURL: "https://user:password@example.com/terms",
        },
      }),
    ).toEqual({
      displayName: "legacy",
      description: "Fallback",
      longDescription: undefined,
      developerName: undefined,
      category: undefined,
      capabilities: undefined,
      websiteURL: undefined,
      privacyPolicyURL: undefined,
      termsOfServiceURL: undefined,
      defaultPrompt: ["Valid"],
      brandColor: undefined,
    });
  });
});
