import { describe, expect, it } from "bun:test";
import { PermissionController } from "./permission-controller.js";
import type { EngineConfig } from "./types.js";

describe("PermissionController", () => {
  it("stages busy mode changes and applies the latest snapshot at the run boundary", () => {
    let busy = true;
    let config = { llm: { model: "test", apiKey: "test" }, permissionMode: "acceptEdits" } as EngineConfig;
    const controller = new PermissionController({
      config: () => config,
      updateConfig: (next) => {
        config = next;
      },
      presetRules: () => [],
      runInProgress: () => busy,
    });

    controller.setPermissionMode("plan");
    controller.setPermissionMode("dontAsk");
    expect(controller.permissionMode).toBe("acceptEdits");
    expect(controller.planMode).toBe(false);

    busy = false;
    controller.applyPending();
    expect(controller.permissionMode).toBe("dontAsk");
    expect(controller.planMode).toBe(false);
    expect(config.permissionMode).toBe("dontAsk");
  });

  it("leaves plan mode through the default accept-edits mode", () => {
    let config = { llm: { model: "test", apiKey: "test" }, permissionMode: "plan" } as EngineConfig;
    const controller = new PermissionController({
      config: () => config,
      updateConfig: (next) => {
        config = next;
      },
      presetRules: () => [],
      runInProgress: () => false,
    });

    controller.setPlanMode(false);
    expect(controller.permissionMode).toBe("acceptEdits");
    expect(controller.planMode).toBe(false);
  });
});
