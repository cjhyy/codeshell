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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  test("a fast approval resolver during onApprovalNeeded does not miss the pending slot", async () => {
    const backend = new RunApprovalBackend();
    backend.setTimeout(25);
    let resolvedDuringHook = false;
    const hooks: RunLifecycleHooks = {
      onApprovalNeeded: async () => {
        resolvedDuringHook = backend.resolveApproval({ approved: true });
        return { approvalId: "fast" };
      },
      onInputNeeded: async () => {},
    };
    backend.setHooks(hooks);

    const result = await backend.requestApproval(req);

    expect(resolvedDuringHook).toBe(true);
    expect(result.approved).toBe(true);
  });

  test("a second pending approval supersedes the first instead of orphaning it", async () => {
    const backend = new RunApprovalBackend();
    const hooks: RunLifecycleHooks = {
      onApprovalNeeded: async () => ({ approvalId: "a1" }),
      onInputNeeded: async () => {},
    };
    backend.setHooks(hooks);

    const first = backend.requestApproval(req);
    await new Promise((r) => setTimeout(r, 0));
    const second = backend.requestApproval({ ...req, description: "second" });
    await new Promise((r) => setTimeout(r, 0));

    expect((await first).approved).toBe(false);
    backend.resolveApproval({ approved: true });
    expect((await second).approved).toBe(true);
  });

  test("late completion from an older hook cannot supersede a newer pending approval", async () => {
    const backend = new RunApprovalBackend();
    const approvals = [deferred<{ approvalId: string }>(), deferred<{ approvalId: string }>()];
    let approvalCalls = 0;
    const hooks: RunLifecycleHooks = {
      onApprovalNeeded: async () => approvals[approvalCalls++]!.promise,
      onInputNeeded: async () => {},
    };
    backend.setHooks(hooks);

    const first = backend.requestApproval(req);
    const second = backend.requestApproval({ ...req, description: "newer" });

    approvals[1]!.resolve({ approvalId: "newer" });
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.hasPendingApproval()).toBe(true);

    approvals[0]!.resolve({ approvalId: "older" });
    expect((await first).approved).toBe(false);
    expect(backend.hasPendingApproval()).toBe(true);

    backend.resolveApproval({ approved: true });
    expect((await second).approved).toBe(true);
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
