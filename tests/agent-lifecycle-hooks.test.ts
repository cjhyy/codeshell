import { describe, it, expect, mock } from "bun:test";
import { emitSubAgentHook } from "../packages/core/src/tool-system/builtin/agent.ts";
import type { HookRegistry } from "../packages/core/src/hooks/registry.ts";

describe("emitSubAgentHook", () => {
  it("emits a notification event with a subagent_ kind + payload", () => {
    const emit = mock(() => Promise.resolve({}));
    emitSubAgentHook({ emit } as unknown as HookRegistry, "subagent_start", { agentId: "x", description: "d" });
    expect(emit).toHaveBeenCalledWith("notification", { kind: "subagent_start", agentId: "x", description: "d" });
  });

  it("is a no-op when hooks are undefined", () => {
    expect(() => emitSubAgentHook(undefined, "subagent_start", { agentId: "x", description: "d" })).not.toThrow();
  });
});
