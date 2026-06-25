import { describe, it, expect, test } from "bun:test";
import { ApprovalBridge, type ApprovalDecision } from "./approval-bridge.js";

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

describe("ApprovalBridge onResolve", () => {
  test("respond() fires onResolve with the decision", () => {
    const resolved: { roomId: string; requestId: string; decision: ApprovalDecision }[] = [];
    const bridge = new ApprovalBridge({
      onPush: () => {},
      onResolve: (roomId, requestId, decision) => resolved.push({ roomId, requestId, decision }),
    });
    const p = bridge.request("room1", "req1", { toolName: "Edit", input: {} });
    const ok = bridge.respond("room1", "req1", { behavior: "allow" });
    expect(ok).toBe(true);
    expect(resolved).toEqual([{ roomId: "room1", requestId: "req1", decision: { behavior: "allow" } }]);
    return p; // settle the parked promise
  });

  test("timeout fires onResolve with the auto-deny decision", async () => {
    const resolved: { roomId: string; requestId: string; decision: ApprovalDecision }[] = [];
    const bridge = new ApprovalBridge({
      timeoutMs: 5,
      onPush: () => {},
      onResolve: (roomId, requestId, decision) => resolved.push({ roomId, requestId, decision }),
    });
    const decision = await bridge.request("room2", "req2", { toolName: "Edit", input: {} });
    expect(decision).toEqual({ behavior: "deny", message: "approval timed out" });
    expect(resolved).toEqual([
      { roomId: "room2", requestId: "req2", decision: { behavior: "deny", message: "approval timed out" } },
    ]);
  });

  test("respond() on unknown request does NOT fire onResolve", () => {
    const resolved: unknown[] = [];
    const bridge = new ApprovalBridge({ onPush: () => {}, onResolve: () => resolved.push(1) });
    expect(bridge.respond("nope", "nope", { behavior: "allow" })).toBe(false);
    expect(resolved).toHaveLength(0);
  });
});
