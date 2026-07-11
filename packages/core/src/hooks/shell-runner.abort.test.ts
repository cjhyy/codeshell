import { describe, expect, it } from "bun:test";
import { runShellHook } from "./shell-runner.js";

describe("runShellHook abort propagation", () => {
  it("settles immediately when an in-flight hook is aborted", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runShellHook(
      { event: "on_turn_start", command: "sleep 5", timeout_ms: 10_000 },
      { eventName: "on_turn_start", data: { signal: controller.signal } },
    );
    setTimeout(() => controller.abort(), 30);

    await expect(pending).resolves.toEqual({});
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
