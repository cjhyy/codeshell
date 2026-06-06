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
