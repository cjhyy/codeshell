import { describe, test, expect } from "bun:test";
import { RunApprovalBackend, createRunAskUserFn } from "./RunApprovalBackend.js";
import type { RunLifecycleHooks } from "./RunApprovalBackend.js";
import type { ApprovalRequest } from "../types.js";

const req: ApprovalRequest = {
  toolName: "Bash",
  args: { command: "rm -rf /" },
  description: "danger",
  riskLevel: "high",
};

describe("RunApprovalBackend — fail-closed when hooks are missing (§5.6 #15)", () => {
  test("requestApproval DENIES when no lifecycle hooks were wired", async () => {
    const backend = new RunApprovalBackend();
    // No setHooks() — a misconfigured RunManager. Must NOT auto-approve a
    // dangerous tool: fail-closed, not fail-open.
    const result = await backend.requestApproval(req);
    expect(result.approved).toBe(false);
  });

  test("requestApproval suspends + resolves when hooks ARE wired", async () => {
    const backend = new RunApprovalBackend();
    const hooks: RunLifecycleHooks = {
      onApprovalNeeded: async () => ({ approvalId: "a1" }),
      onInputNeeded: async () => {},
    };
    backend.setHooks(hooks);
    const p = backend.requestApproval(req);
    // requestApproval awaits onApprovalNeeded before registering the pending
    // slot — let that microtask settle before asserting it suspended.
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.hasPendingApproval()).toBe(true);
    backend.resolveApproval({ approved: true });
    expect((await p).approved).toBe(true);
  });
});

describe("createRunAskUserFn — second ask does not orphan the first (§5.6 #15)", () => {
  test("a second askUser before the first resolves rejects rather than leaking", async () => {
    const hooks: RunLifecycleHooks = {
      onApprovalNeeded: async () => ({ approvalId: "x" }),
      onInputNeeded: async () => {},
    };
    const { askUserFn, resolveInput } = createRunAskUserFn(hooks);

    const first = askUserFn("Q1");
    // Second ask while the first is still pending. Previously this overwrote
    // the single `pending` slot, so resolving once only answered the second
    // and the first promise hung forever.
    const second = askUserFn("Q2");

    // The first must settle (rejected) instead of hanging forever.
    await expect(first).rejects.toThrow();

    // The surviving (second) ask resolves normally.
    resolveInput("answer-2");
    expect(await second).toBe("answer-2");
  });
});
