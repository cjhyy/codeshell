import { describe, it, expect } from "bun:test";
import { HookRegistry } from "./registry.js";

/**
 * B3: hook decision merge must take the STRICTEST decision across the chain,
 * not last-write-wins. The old code did `aggregated.decision = result.decision`
 * unconditionally, so a low-priority (later-running) handler could relax a
 * high-priority handler's `deny` to `allow`. Strictness order: deny > ask > allow.
 */
describe("HookRegistry decision merge", () => {
  it("a deny from any handler wins over an allow from another", async () => {
    const reg = new HookRegistry();
    // priority 100 runs first and says allow; priority 0 runs later and denies.
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 100, "first-allow");
    reg.register("pre_tool_use", () => ({ decision: "deny" }), 0, "later-deny");
    const result = await reg.emit("pre_tool_use", {});
    expect(result.decision).toBe("deny");
  });

  it("a later allow cannot relax an earlier deny", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "deny" }), 100, "first-deny");
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 0, "later-allow");
    const result = await reg.emit("pre_tool_use", {});
    expect(result.decision).toBe("deny");
  });

  it("ask beats allow but loses to deny", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 50);
    reg.register("pre_tool_use", () => ({ decision: "ask" }), 40);
    expect((await reg.emit("pre_tool_use", {})).decision).toBe("ask");

    const reg2 = new HookRegistry();
    reg2.register("pre_tool_use", () => ({ decision: "ask" }), 50);
    reg2.register("pre_tool_use", () => ({ decision: "deny" }), 40);
    expect((await reg2.emit("pre_tool_use", {})).decision).toBe("deny");
  });

  it("a single decision still passes through", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 0);
    expect((await reg.emit("pre_tool_use", {})).decision).toBe("allow");
  });
});
