import { describe, expect, it } from "bun:test";

import {
  ToolRegistry,
  queryExtensionModules,
  registerExtensionModules,
} from "@cjhyy/code-shell-core";
import { createArenaCapability } from "./capability.js";

describe("Arena capability module", () => {
  it("registers Arena only when the host installs the capability", () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    expect(registry.hasTool("Arena")).toBe(false);

    registerExtensionModules(registry, [createArenaCapability()]);

    expect(registry.hasTool("Arena")).toBe(true);
    expect(registry.getTool("Arena")?.timeoutMs).toBe(1_800_000);
  });

  it("owns the arena_status query outside core protocol", async () => {
    const result = await queryExtensionModules([createArenaCapability()], "arena_status", {});

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.data).toHaveProperty("defaultParticipants");
  });
});
