import { describe, it, expect } from "bun:test";
import { ApprovalBridge } from "./approval-bridge.js";

describe("ApprovalBridge", () => {
  it("resolves with the decision when respond is called", async () => {
    let pushed: any = null;
    const b = new ApprovalBridge({ timeoutMs: 10_000, onPush: (_r, req) => { pushed = req; } });
    const p = b.request("room1", "req1", { toolName: "Write", input: { file_path: "/a" } });
    expect(pushed.toolName).toBe("Write");
    b.respond("room1", "req1", { behavior: "allow" });
    expect(await p).toEqual({ behavior: "allow" });
  });
  it("auto-denies on timeout", async () => {
    const b = new ApprovalBridge({ timeoutMs: 20, onPush: () => {} });
    const p = b.request("room1", "req2", { toolName: "Bash", input: {} });
    const d = await p;
    expect(d.behavior).toBe("deny");
  });
  it("respond for unknown id returns false", () => {
    const b = new ApprovalBridge({ timeoutMs: 1000, onPush: () => {} });
    expect(b.respond("r", "nope", { behavior: "allow" })).toBe(false);
  });
});
