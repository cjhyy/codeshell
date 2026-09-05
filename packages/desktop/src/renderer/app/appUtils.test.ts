import { describe, expect, test } from "bun:test";
import { browserPartitionForBucket, shouldShowPanelDockFallback } from "./appUtils";

describe("panel dock lazy fallback visibility", () => {
  test("does not flash a retained but closed panel during startup", () => {
    expect(shouldShowPanelDockFallback(false, true)).toBe(false);
  });

  test("shows loading only when the active chat dock is actually open", () => {
    expect(shouldShowPanelDockFallback(true, true)).toBe(true);
    expect(shouldShowPanelDockFallback(true, false)).toBe(false);
  });
});

describe("browser partition ownership", () => {
  test("keeps Quick Chat browser state process-local", () => {
    // Two Sessions in one project share a jar (Phase 1); Quick Chat never
    // persists. The exact strings are pinned in shared/browser-profile.test.ts.
    expect(browserPartitionForBucket("repo::session-a")).toBe(
      browserPartitionForBucket("repo::session-b"),
    );
    expect(browserPartitionForBucket("__quick_chat__::qchat-a").startsWith("persist:")).toBe(false);
  });
});
