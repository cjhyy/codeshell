import { describe, it, expect, test } from "bun:test";
import { ApprovalBridge, type ApprovalDecision } from "./approval-bridge.js";

describe("ApprovalBridge", () => {
  it("resolves with the decision when respond is called", async () => {
    let pushed: any = null;
    const b = new ApprovalBridge({
      timeoutMs: 10_000,
      onPush: (_r, req) => {
        pushed = req;
      },
    });
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

  test("duplicate IDs deny both callers and withdraw the original approval prompt", async () => {
    const prompts: unknown[] = [];
    const resolutions: ApprovalDecision[] = [];
    const bridge = new ApprovalBridge({
      onPush: (_room, request) => prompts.push(request),
      onResolve: (_room, _id, decision) => resolutions.push(decision),
    });
    const original = bridge.request("room", "request", { toolName: "Read", input: { path: "/a" } });
    const duplicate = bridge.request("room", "request", {
      toolName: "Write",
      input: { path: "/b" },
    });
    await expect(duplicate).resolves.toEqual({
      behavior: "deny",
      message: "duplicate approval request",
    });
    expect(prompts).toHaveLength(1);
    expect(bridge.respond("room", "request", { behavior: "allow" })).toBe(false);
    await expect(original).resolves.toEqual({
      behavior: "deny",
      message: "duplicate approval request",
    });
    expect(resolutions).toEqual([{ behavior: "deny", message: "duplicate approval request" }]);
  });

  test("a duplicate clears the original timeout instead of publishing another resolution", async () => {
    const resolved: string[] = [];
    const bridge = new ApprovalBridge({
      timeoutMs: 5,
      onPush: () => {},
      onResolve: (_room, id) => resolved.push(id),
    });
    const original = bridge.request("room", "request", { toolName: "Read", input: {} });
    const duplicate = bridge.request("room", "request", { toolName: "Read", input: {} });
    await expect(duplicate).resolves.toMatchObject({ behavior: "deny" });
    await expect(original).resolves.toEqual({
      behavior: "deny",
      message: "duplicate approval request",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual(["request"]);
  });

  test("further deliveries of a conflicted ID stay denied until the room closes", async () => {
    const prompts: string[] = [];
    const bridge = new ApprovalBridge({
      onPush: (_room, request) => prompts.push(request.requestId),
    });
    const original = bridge.request("room", "request", { toolName: "Read", input: {} });
    const duplicate = bridge.request("room", "request", { toolName: "Write", input: {} });
    const third = bridge.request("room", "request", { toolName: "Bash", input: {} });
    for (const result of await Promise.all([original, duplicate, third])) {
      expect(result).toEqual({ behavior: "deny", message: "duplicate approval request" });
    }
    expect(prompts).toEqual(["request"]);
    expect(bridge.cancelRoom("room")).toBe(0);
    const reopened = bridge.request("room", "request", { toolName: "Read", input: {} });
    expect(prompts).toEqual(["request", "request"]);
    expect(bridge.respond("room", "request", { behavior: "allow" })).toBe(true);
    await expect(reopened).resolves.toEqual({ behavior: "allow" });
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
    expect(resolved).toEqual([
      { roomId: "room1", requestId: "req1", decision: { behavior: "allow" } },
    ]);
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
      {
        roomId: "room2",
        requestId: "req2",
        decision: { behavior: "deny", message: "approval timed out" },
      },
    ]);
  });

  test("respond() on unknown request does NOT fire onResolve", () => {
    const resolved: unknown[] = [];
    const bridge = new ApprovalBridge({ onPush: () => {}, onResolve: () => resolved.push(1) });
    expect(bridge.respond("nope", "nope", { behavior: "allow" })).toBe(false);
    expect(resolved).toHaveLength(0);
  });

  test("resolution callback failures cannot strand the approval", async () => {
    const bridge = new ApprovalBridge({
      onPush: () => {},
      onResolve: () => {
        throw new Error("renderer gone");
      },
    });
    const pending = bridge.request("room", "req", { toolName: "Bash", input: {} });
    expect(bridge.respond("room", "req", { behavior: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: "allow" });
  });

  test("cancelRoom denies all of that room's requests and leaves other rooms live", async () => {
    const bridge = new ApprovalBridge({ onPush: () => {} });
    const first = bridge.request("room-a", "req-1", { toolName: "Bash", input: {} });
    const second = bridge.request("room-a", "req-2", { toolName: "Write", input: {} });
    const other = bridge.request("room-b", "req-3", { toolName: "Read", input: {} });

    expect(bridge.cancelRoom("room-a")).toBe(2);
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    expect(bridge.respond("room-b", "req-3", { behavior: "allow" })).toBe(true);
    await expect(other).resolves.toEqual({ behavior: "allow" });
  });

  test("a failed prompt delivery denies immediately and clears the request", async () => {
    const bridge = new ApprovalBridge({
      onPush: () => {
        throw new Error("no transport");
      },
    });
    await expect(bridge.request("room", "req", { toolName: "Edit", input: {} })).resolves.toEqual({
      behavior: "deny",
      message: "approval prompt could not be delivered",
    });
    expect(bridge.respond("room", "req", { behavior: "allow" })).toBe(false);
  });
});
