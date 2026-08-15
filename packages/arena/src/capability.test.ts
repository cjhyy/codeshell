import { describe, expect, it } from "bun:test";

import { compileComposition } from "@cjhyy/code-shell-core";
import { createArenaModule } from "./capability.js";

describe("Arena module", () => {
  it("contributes Arena as an always-visible tool only when the host installs the module", () => {
    const bare = compileComposition({});
    expect(bare.engine.tools.some((t) => t.tool.definition.name === "Arena")).toBe(false);

    const composition = compileComposition({ modules: [createArenaModule()] });
    const arena = composition.engine.tools.find((t) => t.tool.definition.name === "Arena");
    expect(arena?.kind).toBe("always");
    expect(arena?.moduleId).toBe("arena");
    expect(arena?.tool.definition.timeoutMs).toBe(1_800_000);
  });

  it("owns the arena_status query on the protocol surface", async () => {
    const composition = compileComposition({ modules: [createArenaModule()] });
    const handler = composition.protocol.queries.find((q) => q.key === "arena_status")?.value;

    expect(handler).toBeDefined();
    expect(await handler?.({})).toHaveProperty("defaultParticipants");
  });
});
