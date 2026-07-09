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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOSED_SESSION_TOMBSTONE_LIMIT,
  InteractiveApprovalBackend,
} from "./permission.js";
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
  const sameSessionId = "session-cache-same-session";

  test("session allow rules are isolated by ApprovalRequest.sessionId", async () => {
    const b = new InteractiveApprovalBackend();
    const seen: string[] = [];
    b.setPromptFn(async (req) => {
      seen.push(req.sessionId ?? "");
      if (req.sessionId === "sess-a") {
        return { approved: true, always: true, scope: "session" } as ApprovalResult;
      }
      return { approved: false } as ApprovalResult;
    });

    const a = await b.requestApproval({
      sessionId: "sess-a",
      toolName: "Bash",
      args: { command: "curl https://a.example" },
      description: "",
      riskLevel: "medium",
    });
    expect(a.approved).toBe(true);

    const bResult = await b.requestApproval({
      sessionId: "sess-b",
      toolName: "Bash",
      args: { command: "curl https://b.example" },
      description: "",
      riskLevel: "medium",
    });

    expect(seen).toEqual(["sess-a", "sess-b"]);
    expect(bResult.approved).toBe(false);
  });

  test("session deny rules are isolated by ApprovalRequest.sessionId", async () => {
    const b = new InteractiveApprovalBackend();
    const seen: string[] = [];
    b.setPromptFn(async (req) => {
      seen.push(req.sessionId ?? "");
      if (req.sessionId === "sess-a") {
        return { approved: false, always: true, scope: "session" } as ApprovalResult;
      }
      return { approved: true } as ApprovalResult;
    });

    const a = await b.requestApproval({
      sessionId: "sess-a",
      toolName: "Bash",
      args: { command: "curl https://a.example" },
      description: "",
      riskLevel: "medium",
    });
    expect(a.approved).toBe(false);

    const bResult = await b.requestApproval({
      sessionId: "sess-b",
      toolName: "Bash",
      args: { command: "curl https://b.example" },
      description: "",
      riskLevel: "medium",
    });

    expect(seen).toEqual(["sess-a", "sess-b"]);
    expect(bResult.approved).toBe(true);
  });

  test("session remember is ignored when ApprovalRequest.sessionId is absent", async () => {
    const b = new InteractiveApprovalBackend();
    let prompts = 0;
    b.setPromptFn(async () => {
      prompts += 1;
      return prompts === 1
        ? ({ approved: true, always: true, scope: "session" } as ApprovalResult)
        : ({ approved: false } as ApprovalResult);
    });

    const first = await b.requestApproval({
      toolName: "Bash",
      args: { command: "curl https://legacy.example" },
      description: "",
      riskLevel: "medium",
    });
    expect(first.approved).toBe(true);

    const second = await b.requestApproval({
      toolName: "Bash",
      args: { command: "curl https://legacy.example/again" },
      description: "",
      riskLevel: "medium",
    });
    expect(second.approved).toBe(false);
    expect(prompts).toBe(2);
  });

  test("session remember still applies within the same ApprovalRequest.sessionId", async () => {
    const b = new InteractiveApprovalBackend();
    let prompts = 0;
    b.setPromptFn(async () => {
      prompts += 1;
      return { approved: true, always: true, scope: "session" } as ApprovalResult;
    });

    const first = await b.requestApproval({
      sessionId: "sess-same",
      toolName: "Bash",
      args: { command: "curl https://same.example/a" },
      description: "",
      riskLevel: "medium",
    });
    expect(first.approved).toBe(true);

    const second = await b.requestApproval({
      sessionId: "sess-same",
      toolName: "Bash",
      args: { command: "curl https://same.example/b" },
      description: "",
      riskLevel: "medium",
    });
    expect(second.approved).toBe(true);
    expect(prompts).toBe(1);
  });

  test("project-scope session seed is isolated to the approving sessionId", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permission-project-seed-"));
    try {
      const b = new InteractiveApprovalBackend();
      b.setSessionContext("sess-a", { cwd, onProjectRules: () => {} });
      b.setSessionContext("sess-b", { cwd, onProjectRules: () => {} });
      const seen: string[] = [];
      b.setPromptFn(async (req) => {
        seen.push(req.sessionId ?? "");
        if (req.sessionId === "sess-a") {
          return { approved: true, scope: "project" } as ApprovalResult;
        }
        return { approved: false } as ApprovalResult;
      });

      const first = await b.requestApproval({
        sessionId: "sess-a",
        toolName: "Bash",
        args: { command: "curl https://project-seed.example/a" },
        description: "",
        riskLevel: "medium",
      });
      expect(first.approved).toBe(true);

      const sameSessionSeed = await b.requestApproval({
        sessionId: "sess-a",
        toolName: "Bash",
        args: { command: "curl https://project-seed.example/again" },
        description: "",
        riskLevel: "medium",
      });
      expect(sameSessionSeed.approved).toBe(true);
      expect(seen).toEqual(["sess-a"]);

      const otherSession = await b.requestApproval({
        sessionId: "sess-b",
        toolName: "Bash",
        args: { command: "curl https://project-seed.example/b" },
        description: "",
        riskLevel: "medium",
      });
      expect(otherSession.approved).toBe(false);
      expect(seen).toEqual(["sess-a", "sess-b"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("approving `git status` for the session does NOT auto-allow `rm -rf /`", async () => {
    const { b } = backendWithAnswer({
      approved: true,
      always: true,
      scope: "session",
    } as ApprovalResult);

    // First: approve `git status` for the session.
    const r1 = await b.requestApproval({
      sessionId: sameSessionId,
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
      sessionId: sameSessionId,
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
      sessionId: sameSessionId,
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
    const { b } = backendWithAnswer({
      approved: true,
      always: true,
      scope: "session",
    } as ApprovalResult);
    const r1 = await b.requestApproval({
      sessionId: sameSessionId,
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
      sessionId: sameSessionId,
      toolName: "Bash",
      args: { command: "git status && rm -rf /" },
      description: "",
      riskLevel: "high",
    });
    expect(prompted).toBe(true); // must re-prompt, not silently allow
    expect(r2.approved).toBe(false);
  });

  test("the chained-grant bypass is closed for every shell operator class", async () => {
    // Lock down the whole class so a future refactor of ruleMatches can't
    // silently reopen any single operator. Each smuggles a dangerous tail past
    // a `git`-headed grant; all must re-prompt rather than ride it.
    const smuggles = [
      "git status; rm -rf /", // sequencing
      "git status || rm -rf /", // or-chain
      "git log | sh", // pipe-to-shell
      "git log $(rm -rf /)", // command substitution
      "git log `rm -rf /`", // backtick substitution
      "git status > /etc/hosts", // redirect to a sensitive path
    ];
    for (const command of smuggles) {
      const { b } = backendWithAnswer({
        approved: true,
        always: true,
        scope: "session",
      } as ApprovalResult);
      await b.requestApproval({
        sessionId: sameSessionId,
        toolName: "Bash",
        args: { command: "git status" },
        description: "",
        riskLevel: "low",
      });
      let prompted = false;
      b.setPromptFn(async () => {
        prompted = true;
        return { approved: false } as ApprovalResult;
      });
      const r = await b.requestApproval({
        sessionId: sameSessionId,
        toolName: "Bash",
        args: { command },
        description: "",
        riskLevel: "high",
      });
      expect(prompted, `must re-prompt for: ${command}`).toBe(true);
      expect(r.approved, `must NOT auto-allow: ${command}`).toBe(false);
    }
  });

  test("a benign single command with the same head still rides the grant (no over-blocking)", async () => {
    // The fix must not break the legitimate session-cache win: another simple
    // `git ...` (flags only, no chaining) stays auto-allowed.
    const { b } = backendWithAnswer({
      approved: true,
      always: true,
      scope: "session",
    } as ApprovalResult);
    await b.requestApproval({
      sessionId: sameSessionId,
      toolName: "Bash",
      args: { command: "git status" },
      description: "",
      riskLevel: "low",
    });
    let prompted = false;
    b.setPromptFn(async () => {
      prompted = true;
      return { approved: false } as ApprovalResult;
    });
    const r = await b.requestApproval({
      sessionId: sameSessionId,
      toolName: "Bash",
      args: { command: "git diff --stat HEAD~1" },
      description: "",
      riskLevel: "low",
    });
    expect(prompted).toBe(false);
    expect(r.approved).toBe(true);
  });

  test("non-Bash tools still cache at tool granularity for the session", async () => {
    const { b } = backendWithAnswer({
      approved: true,
      always: true,
      scope: "session",
    } as ApprovalResult);
    const r1 = await b.requestApproval({
      sessionId: sameSessionId,
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
      sessionId: sameSessionId,
      toolName: "Write",
      args: { file_path: "/b.txt" },
      description: "",
      riskLevel: "medium",
    });
    expect(r2.approved).toBe(true);
    expect(prompted).toBe(false);
  });

  test("a session DENY for one command does not block a different command", async () => {
    const { b } = backendWithAnswer({
      approved: false,
      always: true,
      scope: "session",
    } as ApprovalResult);
    const r1 = await b.requestApproval({
      sessionId: sameSessionId,
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
      sessionId: sameSessionId,
      toolName: "Bash",
      args: { command: "git status" },
      description: "",
      riskLevel: "low",
    });
    expect(prompted).toBe(true);
    expect(r2.approved).toBe(true);
  });
});

describe("closed-session tombstones", () => {
  test("caps old tombstones while preserving late-approval protection for recent sessions", async () => {
    const b = new InteractiveApprovalBackend();
    const closedSessionIds = (b as any).closedSessionIds as Set<string>;
    for (let i = 0; i < CLOSED_SESSION_TOMBSTONE_LIMIT; i += 1) {
      b.clearSession(`closed-old-${i}`);
    }

    let resolvePrompt!: (r: ApprovalResult) => void;
    let prompts = 0;
    const promptStarted = new Promise<void>((resolve) => {
      b.setPromptFn(() => {
        prompts += 1;
        resolve();
        return new Promise<ApprovalResult>((r) => {
          resolvePrompt = r;
        });
      });
    });

    const sessionId = "closed-recent";
    const pending = b.requestApproval({
      sessionId,
      toolName: "Bash",
      args: { command: "curl https://late-recent.example/a" },
      description: "",
      riskLevel: "medium",
    });
    await promptStarted;
    b.clearSession(sessionId);

    expect(closedSessionIds.size).toBeLessThanOrEqual(CLOSED_SESSION_TOMBSTONE_LIMIT);
    expect(closedSessionIds.has("closed-old-0")).toBe(false);
    expect(closedSessionIds.has(sessionId)).toBe(true);

    resolvePrompt({ approved: true, always: true, scope: "session" } as ApprovalResult);
    expect((await pending).approved).toBe(true);

    b.setPromptFn(async () => {
      prompts += 1;
      return { approved: false } as ApprovalResult;
    });
    const afterClose = await b.requestApproval({
      sessionId,
      toolName: "Bash",
      args: { command: "curl https://late-recent.example/b" },
      description: "",
      riskLevel: "medium",
    });

    expect(afterClose.approved).toBe(false);
    expect(prompts).toBe(2);
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
      sessionId: "burst-same-session",
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
      sessionId: "burst-once-session",
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
