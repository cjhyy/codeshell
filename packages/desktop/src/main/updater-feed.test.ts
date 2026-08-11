import { describe, expect, test } from "bun:test";
import { updaterFeedDecision } from "./updater-feed";

describe("updaterFeedDecision", () => {
  test("keeps an explicit environment feed as the highest priority", () => {
    expect(updaterFeedDecision(" https://updates.example.com/stable ", false)).toEqual({
      source: "environment",
      config: { provider: "generic", url: "https://updates.example.com/stable" },
    });
  });

  test("uses electron-builder configuration when app-update.yml exists", () => {
    expect(updaterFeedDecision(undefined, true)).toEqual({
      source: "packaged",
      config: null,
    });
  });

  test("falls back to the public GitHub feed for directory-only packages", () => {
    expect(updaterFeedDecision(undefined, false)).toEqual({
      source: "builtin-github",
      config: { provider: "github", owner: "cjhyy", repo: "codeshell" },
    });
  });
});
