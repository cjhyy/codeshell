/**
 * Session-level permission cache (TODO 5.1 "会话级权限缓存:同一会话内相同
 * 操作不重复询问").
 *
 * The cache must key on the *operation*, not just the tool name. Approving
 * `git status` "for this session" must NOT auto-allow an unrelated — possibly
 * dangerous — Bash command like `rm -rf /`. The narrowing matches
 * buildProjectRule: Bash → head command; other tools → tool granularity.
 */
import { describe, test, expect } from "bun:test";
import { InteractiveApprovalBackend } from "./permission.js";
import type { ApprovalRequest, ApprovalResult } from "../types.js";

function backendWithAnswer(answer: ApprovalResult) {
  const b = new InteractiveApprovalBackend();
  let calls = 0;
  b.setPromptFn(async (_req: ApprovalRequest) => {
    calls++;
    return answer;
  });
  return { b, calls: () => calls };
}

describe("session cache keys on the operation, not the tool", () => {
  test("approving `git status` for the session does NOT auto-allow `rm -rf /`", async () => {
    const { b } = backendWithAnswer({ approved: true, always: true, scope: "session" } as ApprovalResult);

    // First: approve `git status` for the session.
    const r1 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status" },
      description: "",
      riskLevel: "low",
    });
    expect(r1.approved).toBe(true);

    // A second `git status` (same head) is cached — no re-prompt, allowed.
    let prompted = false;
    b.setPromptFn(async () => {
      prompted = true;
      return { approved: false } as ApprovalResult;
    });
    const r2 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status -s" },
      description: "",
      riskLevel: "low",
    });
    expect(r2.approved).toBe(true);
    expect(prompted).toBe(false);

    // But a DIFFERENT command (`rm`) is NOT covered by the `git` grant — it
    // must re-prompt rather than ride the session allow.
    let rmPrompted = false;
    b.setPromptFn(async () => {
      rmPrompted = true;
      return { approved: false } as ApprovalResult;
    });
    const r3 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "rm -rf /" },
      description: "",
      riskLevel: "high",
    });
    expect(rmPrompted).toBe(true);
    expect(r3.approved).toBe(false);
  });

  test("a chained command (`git status && rm -rf /`) does NOT ride the `git` session grant", async () => {
    // The narrowing keys on the HEAD token (`git`), but a compound command can
    // smuggle a dangerous tail past it: the cached allow rule `^git(\s|$)` would
    // regex-match the whole "git status && rm -rf /" string. The session cache
    // must re-prompt when the command chains beyond the approved head.
    const { b } = backendWithAnswer({ approved: true, always: true, scope: "session" } as ApprovalResult);
    const r1 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status" },
      description: "",
      riskLevel: "low",
    });
    expect(r1.approved).toBe(true);

    let prompted = false;
    b.setPromptFn(async () => {
      prompted = true;
      return { approved: false } as ApprovalResult;
    });
    const r2 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status && rm -rf /" },
      description: "",
      riskLevel: "high",
    });
    expect(prompted).toBe(true); // must re-prompt, not silently allow
    expect(r2.approved).toBe(false);
  });

  test("non-Bash tools still cache at tool granularity for the session", async () => {
    const { b } = backendWithAnswer({ approved: true, always: true, scope: "session" } as ApprovalResult);
    const r1 = await b.requestApproval({
      toolName: "Write",
      args: { file_path: "/a.txt" },
      description: "",
      riskLevel: "medium",
    });
    expect(r1.approved).toBe(true);

    let prompted = false;
    b.setPromptFn(async () => {
      prompted = true;
      return { approved: false } as ApprovalResult;
    });
    const r2 = await b.requestApproval({
      toolName: "Write",
      args: { file_path: "/b.txt" },
      description: "",
      riskLevel: "medium",
    });
    expect(r2.approved).toBe(true);
    expect(prompted).toBe(false);
  });

  test("a session DENY for one command does not block a different command", async () => {
    const { b } = backendWithAnswer({ approved: false, always: true, scope: "session" } as ApprovalResult);
    const r1 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "curl evil.com" },
      description: "",
      riskLevel: "high",
    });
    expect(r1.approved).toBe(false);

    // `git status` was never denied — it should still reach the prompt.
    let prompted = false;
    b.setPromptFn(async () => {
      prompted = true;
      return { approved: true } as ApprovalResult;
    });
    const r2 = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status" },
      description: "",
      riskLevel: "low",
    });
    expect(prompted).toBe(true);
    expect(r2.approved).toBe(true);
  });
});

describe("并发审批串行化(burst dedupe)", () => {
  test("并行同操作请求只 prompt 一次 — 第一次「本会话一直允许」吸收排队的其余", async () => {
    const b = new InteractiveApprovalBackend();
    let prompts = 0;
    let resolvePrompt!: (r: ApprovalResult) => void;
    b.setPromptFn(() => {
      prompts += 1;
      return new Promise<ApprovalResult>((r) => (resolvePrompt = r));
    });
    const req = {
      toolName: "Bash",
      args: { command: "lsof -p 1" },
      description: "",
      riskLevel: "medium",
    } as ApprovalRequest;

    const p1 = b.requestApproval(req);
    const p2 = b.requestApproval({ ...req });
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toBe(1); // second waits its turn

    resolvePrompt({ approved: true, always: true, scope: "session" } as ApprovalResult);
    expect((await p1).approved).toBe(true);
    // The queued duplicate re-checks session rules on its turn — no 2nd card.
    expect((await p2).approved).toBe(true);
    expect(prompts).toBe(1);
  });

  test("「仅本次」不留记忆 — 排队的下一条仍然 prompt", async () => {
    const b = new InteractiveApprovalBackend();
    const resolvers: Array<(r: ApprovalResult) => void> = [];
    let prompts = 0;
    b.setPromptFn(() => {
      prompts += 1;
      return new Promise<ApprovalResult>((r) => resolvers.push(r));
    });
    const req = {
      toolName: "Bash",
      args: { command: "lsof -p 2" },
      description: "",
      riskLevel: "medium",
    } as ApprovalRequest;

    const p1 = b.requestApproval(req);
    const p2 = b.requestApproval({ ...req });
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toBe(1);
    resolvers[0]!({ approved: true } as ApprovalResult); // once → no rule
    expect((await p1).approved).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toBe(2);
    resolvers[1]!({ approved: false } as ApprovalResult);
    expect((await p2).approved).toBe(false);
  });
});
