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
    expect(browserPartitionForBucket("repo::session-a")).toBe("persist:browser:repo::session-a");
    expect(browserPartitionForBucket("__quick_chat__::qchat-a")).toBe(
      "browser:qchat:__quick_chat__::qchat-a",
    );
  });
});
