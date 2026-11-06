import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  clearSessionPathApprovalsUnderRoot,
  enforcePathPolicyWithApproval,
  _resetSessionPathGrants,
} from "./path-policy.js";
import type { ToolContext } from "./context.js";
import { UserDecisionError } from "../exceptions.js";

// TODO §5.1 — path-approval fixes:
//  (1) approval match must be EXACT, not startsWith (a future "允许本会话"
//      option would otherwise be misread as a one-time allow).
//  (2) the prompt title must reflect the ACTUAL reason — a sensitive file can
//      live INSIDE the workspace, so it shouldn't always say "工作区外".

const dirs: string[] = [];
function tmpWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-pathpol-"));
  dirs.push(d);
  return d;
}
function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A ctx whose askUser records the prompt/header and returns a fixed answer. */
function ctxAnswering(
  cwd: string,
  answer: string,
  capture?: {
    question?: string;
    header?: string;
    options?: { label: string; description: string; tone?: string }[];
  },
): ToolContext {
  return {
    cwd,
    askUser: async (
      question: string,
      opts?: { header?: string; options?: { label: string; description: string; tone?: string }[] },
    ) => {
      if (capture) {
        capture.question = question;
        capture.header = opts?.header;
        capture.options = opts?.options;
      }
      return answer;
    },
  } as unknown as ToolContext;
}

describe("enforcePathPolicyWithApproval", () => {
  test("exact 允许本次 → allowed (returns null)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    const res = await enforcePathPolicyWithApproval(outside, "write", ctxAnswering(ws, "允许本次"));
    expect(res).toBeNull();
    cleanup();
  });

  test("a prefix-but-not-exact answer is NOT treated as allow (the startsWith bug)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    // Simulate a future scope option whose label starts with "允许本次".
    const res = await enforcePathPolicyWithApproval(
      outside,
      "write",
      ctxAnswering(ws, "允许本次会话"),
    );
    expect(res).not.toBeNull();
    expect(res).toContain("approval denied");
    cleanup();
  });

  test("拒绝 → denied", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    const res = await enforcePathPolicyWithApproval(outside, "write", ctxAnswering(ws, "拒绝"));
    expect(res).toContain("approval denied");
    cleanup();
  });

  test("options carry semantic tone: allow → ok, 拒绝 → danger (UI colors deny red not green)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "tone-check.txt");
    const cap: {
      options?: { label: string; description: string; tone?: string }[];
    } = {};
    await enforcePathPolicyWithApproval(outside, "write", ctxAnswering(ws, "拒绝", cap));
    const opts = cap.options ?? [];
    const deny = opts.find((o) => o.label === "拒绝");
    expect(deny?.tone).toBe("danger");
    // every non-deny option is an allow variant → ok
    for (const o of opts.filter((o) => o.label !== "拒绝")) {
      expect(o.tone).toBe("ok");
    }
    cleanup();
  });

  test("outside-workspace ask is titled 工作区外, not 敏感文件", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "outside-x.txt");
    const cap: { question?: string; header?: string } = {};
    await enforcePathPolicyWithApproval(outside, "write", ctxAnswering(ws, "拒绝", cap));
    expect(cap.question).toContain("工作区外");
    expect(cap.header).toBe("路径权限");
    cleanup();
  });

  test("a protected path (e.g. .git/hooks) is titled 受保护路径, not 工作区外", async () => {
    const ws = tmpWorkspace();
    const cap: { question?: string; header?: string } = {};
    const res = await enforcePathPolicyWithApproval(
      join(ws, ".git", "hooks", "pre-commit"),
      "write",
      ctxAnswering(ws, "拒绝", cap),
    );
    expect(res).toContain("approval denied");
    expect(cap.question).toContain("受保护路径");
    expect(cap.header).toBe("受保护路径");
    cleanup();
  });

  test("bypassPermissions skips the path prompt entirely (never calls askUser)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "bypass-outside.txt");
    let asked = false;
    const ctx = {
      cwd: ws,
      permissionMode: "bypassPermissions",
      askUser: async () => {
        asked = true;
        return "拒绝";
      },
    } as unknown as ToolContext;
    const res = await enforcePathPolicyWithApproval(outside, "read", ctx);
    expect(res).toBeNull();
    expect(asked).toBe(false);
    cleanup();
  });

  test("本目录本会话允许 → same dir not re-prompted within the session", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "cs-grantdir-"));
    dirs.push(dir);
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");

    // First file in the dir: user grants for the session.
    let calls = 0;
    const ctxGrant = {
      cwd: ws,
      sessionId: "sess-1",
      askUser: async () => {
        calls += 1;
        return "本目录本会话允许";
      },
    } as unknown as ToolContext;
    expect(await enforcePathPolicyWithApproval(fileA, "write", ctxGrant)).toBeNull();
    // Second file in the SAME dir: no prompt (calls stays 1).
    expect(await enforcePathPolicyWithApproval(fileB, "write", ctxGrant)).toBeNull();
    expect(calls).toBe(1);

    // A different session does NOT inherit the grant.
    let asked2 = false;
    const ctxOther = {
      cwd: ws,
      sessionId: "sess-2",
      askUser: async () => {
        asked2 = true;
        return "拒绝";
      },
    } as unknown as ToolContext;
    expect(await enforcePathPolicyWithApproval(fileA, "write", ctxOther)).toContain("denied");
    expect(asked2).toBe(true);
    cleanup();
  });

  test("removing a workspace root revokes session grants under that root", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const formerRoot = mkdtempSync(join(tmpdir(), "cs-removed-root-"));
    dirs.push(formerRoot);
    const fileA = join(formerRoot, "a.txt");
    const fileB = join(formerRoot, "b.txt");
    let calls = 0;
    const ctx = {
      cwd: ws,
      sessionId: "sess-root-removal",
      askUser: async () => {
        calls += 1;
        return "本目录本会话允许";
      },
    } as unknown as ToolContext;

    expect(await enforcePathPolicyWithApproval(fileA, "write", ctx)).toBeNull();
    expect(await enforcePathPolicyWithApproval(fileB, "write", ctx)).toBeNull();
    expect(calls).toBe(1);

    clearSessionPathApprovalsUnderRoot("sess-root-removal", formerRoot);
    expect(await enforcePathPolicyWithApproval(fileB, "write", ctx)).toBeNull();
    expect(calls).toBe(2);
    cleanup();
  });

  test("本目录本项目允许 → persists to settings.local.json and survives a new session", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "cs-projgrant-"));
    dirs.push(dir);
    const file = join(dir, "report.md");

    let calls = 0;
    const ctxGrant = {
      cwd: ws,
      sessionId: "sess-A",
      askUser: async () => {
        calls += 1;
        return "本目录本项目允许";
      },
    } as unknown as ToolContext;
    expect(await enforcePathPolicyWithApproval(file, "write", ctxGrant)).toBeNull();

    // Wipe session memory → simulate a fresh session. Project grant persists.
    _resetSessionPathGrants();
    let asked = false;
    const ctxFresh = {
      cwd: ws,
      sessionId: "sess-B",
      askUser: async () => {
        asked = true;
        return "拒绝";
      },
    } as unknown as ToolContext;
    expect(await enforcePathPolicyWithApproval(file, "write", ctxFresh)).toBeNull();
    expect(asked).toBe(false); // covered by persisted project grant
    expect(calls).toBe(1);
    cleanup();
  });
});

describe("旧式只读授权不覆盖写入", () => {
  test("旧式裸字符串 pathApprovals 条目保守解释为只读", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "cs-rw-legacy-"));
    dirs.push(dir);
    const file = join(dir, "report.md");

    // Seed a legacy bare-string project grant for the dir (trailing sep prefix,
    // the format recordPathApproval used before this fix). realpath the dir so
    // the prefix matches the resolved path coveredBy compares against (macOS
    // /var → /private/var).
    const realDir = realpathSync(dir);
    const prefix = realDir.endsWith("/") ? realDir : realDir + "/";
    const cfgDir = join(ws, ".code-shell");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "settings.local.json"),
      JSON.stringify({ pathApprovals: [prefix] }, null, 2) + "\n",
      "utf-8",
    );

    let asked = false;
    const ctx = {
      cwd: ws,
      sessionId: "s-rw-legacy",
      askUser: async () => {
        asked = true;
        return "拒绝";
      },
    } as unknown as ToolContext;

    // Legacy bare entries do NOT cover writes — the conservative interpretation.
    expect(await enforcePathPolicyWithApproval(file, "write", ctx)).toContain("denied");
    expect(asked).toBe(true);
    cleanup();
  });
});

describe("并发路径审批串行化(burst dedupe)", () => {
  test("并行同目录请求只弹一次 — 第一次「本目录本会话允许」吸收排队的其余", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const outsideA = join(tmpdir(), "burst-dedupe-a.txt");
    const outsideB = join(tmpdir(), "burst-dedupe-b.txt");
    let asks = 0;
    let resolveAsk!: (answer: string) => void;
    const ctx = {
      cwd: ws,
      sessionId: "s-burst-dedupe",
      askUser: () => {
        asks += 1;
        return new Promise<string>((r) => (resolveAsk = r));
      },
    } as unknown as ToolContext;

    // Two parallel tools hit the same (not yet approved) directory.
    const p1 = enforcePathPolicyWithApproval(outsideA, "write", ctx);
    const p2 = enforcePathPolicyWithApproval(outsideB, "write", ctx);
    await new Promise((r) => setTimeout(r, 10));
    // Only ONE card so far — the second waits its turn in the chain.
    expect(asks).toBe(1);

    resolveAsk("本目录本会话允许");
    expect(await p1).toBeNull();
    // The queued request re-checks grants on its turn and never prompts.
    expect(await p2).toBeNull();
    expect(asks).toBe(1);
    cleanup();
  });

  test("「允许本次」不留记忆 — 排队的下一条仍然要问", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const outsideA = join(tmpdir(), "burst-once-a.txt");
    const outsideB = join(tmpdir(), "burst-once-b.txt");
    const answers: Array<(a: string) => void> = [];
    let asks = 0;
    const ctx = {
      cwd: ws,
      sessionId: "s-burst-once",
      askUser: () => {
        asks += 1;
        return new Promise<string>((r) => answers.push(r));
      },
    } as unknown as ToolContext;

    const p1 = enforcePathPolicyWithApproval(outsideA, "write", ctx);
    const p2 = enforcePathPolicyWithApproval(outsideB, "write", ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(asks).toBe(1);
    answers[0]!("允许本次"); // no memory recorded
    expect(await p1).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(asks).toBe(2); // second still has to ask
    answers[1]!("拒绝");
    expect(await p2).toContain("denied");
    cleanup();
  });
});

describe("path approval cancellation", () => {
  test("reports an unattended timeout to the model instead of claiming the user refused", async () => {
    const cwd = tmpWorkspace();
    try {
      const result = await enforcePathPolicyWithApproval(
        join(homedir(), ".claude", "settings.json"),
        "write",
        ctxAnswering(cwd, "Confirmation timed out; skip this operation"),
      );
      expect(result).toContain("timed out; skip this operation");
      expect(result).not.toContain("denied by user");
    } finally {
      cleanup();
    }
  });
  test("stopping parallel writes drains queued prompts and ignores late grants", async () => {
    const cwd = tmpWorkspace();
    const controller = new AbortController();
    let calls = 0;
    let answer!: (value: string) => void;
    const ctx = {
      cwd,
      sessionId: "cancel-parallel-paths",
      signal: controller.signal,
      askUser: async () => {
        calls++;
        return new Promise<string>((resolve) => {
          answer = resolve;
        });
      },
    } as unknown as ToolContext;
    try {
      const first = enforcePathPolicyWithApproval(
        join(homedir(), ".claude", "a.json"),
        "write",
        ctx,
      );
      const second = enforcePathPolicyWithApproval(join(homedir(), ".ssh", "config"), "write", ctx);
      await Promise.resolve();
      expect(calls).toBe(1);
      controller.abort();
      answer("本目录本会话允许");
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result?.includes("cancelled"))).toBe(true);
      expect(calls).toBe(1);
      // The late answer must not have persisted a grant for a subsequent run.
      const next = {
        ...ctx,
        signal: new AbortController().signal,
        askUser: async () => {
          calls++;
          return "拒绝";
        },
      };
      await enforcePathPolicyWithApproval(join(homedir(), ".claude", "a.json"), "write", next);
      expect(calls).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("受保护路径授权只覆盖该受保护项", () => {
  function counting(cwd: string, sessionId: string, answers: string[]) {
    const asked: string[] = [];
    const ctx = {
      cwd,
      sessionId,
      askUser: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? "拒绝";
      },
    } as unknown as ToolContext;
    return { ctx, asked };
  }

  test("本目录本项目允许 on .env grants only that file, never .git or other protected items", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const { ctx, asked } = counting(ws, "s-protected-env", ["本目录本项目允许"]);
    expect(await enforcePathPolicyWithApproval(join(ws, ".env"), "write", ctx)).toBeNull();
    expect(await enforcePathPolicyWithApproval(join(ws, ".env"), "write", ctx)).toBeNull();
    expect(asked).toHaveLength(1);
    // The grant must not widen to the root directory that holds .env.
    expect(await enforcePathPolicyWithApproval(join(ws, ".env.local"), "write", ctx)).toContain(
      "denied",
    );
    expect(
      await enforcePathPolicyWithApproval(join(ws, ".git", "hooks", "pre-commit"), "write", ctx),
    ).toContain("denied");
    expect(asked).toHaveLength(3);
    cleanup();
  });

  test("本目录本会话允许 on a .git hook covers the rest of .git only", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const { ctx, asked } = counting(ws, "s-protected-git", ["本目录本会话允许"]);
    expect(
      await enforcePathPolicyWithApproval(join(ws, ".git", "hooks", "pre-commit"), "write", ctx),
    ).toBeNull();
    expect(
      await enforcePathPolicyWithApproval(join(ws, ".git", "config"), "write", ctx),
    ).toBeNull();
    expect(asked).toHaveLength(1);
    expect(
      await enforcePathPolicyWithApproval(join(ws, ".vscode", "settings.json"), "write", ctx),
    ).toContain("denied");
    expect(asked).toHaveLength(2);
    cleanup();
  });

  test("the approval card names the protected item as the grant target", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const cap: { options?: { label: string; description: string }[] } = {};
    await enforcePathPolicyWithApproval(
      join(ws, ".git", "hooks", "pre-commit"),
      "write",
      ctxAnswering(ws, "拒绝", cap),
    );
    const session = cap.options?.find((o) => o.label === "本目录本会话允许");
    expect(session?.description).toContain(join(realpathSync(ws), ".git"));
    expect(session?.description).not.toContain("hooks");
    cleanup();
  });

  test("an ordinary outside-dir grant does not cover protected paths beneath it", async () => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "cs-protected-outside-"));
    dirs.push(dir);
    const { ctx, asked } = counting(ws, "s-protected-outside", ["本目录本会话允许"]);
    expect(await enforcePathPolicyWithApproval(join(dir, "a.txt"), "write", ctx)).toBeNull();
    expect(await enforcePathPolicyWithApproval(join(dir, "b.txt"), "write", ctx)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(
      await enforcePathPolicyWithApproval(join(dir, ".git", "config"), "write", ctx),
    ).toContain("denied");
    expect(asked).toHaveLength(2);
    cleanup();
  });
});

describe("超时/取消不能说成用户拒绝", () => {
  test.each([
    ["timed_out", "path approval timed out"],
    ["cancelled", "path approval cancelled"],
    ["session_closed", "path approval unavailable"],
  ] as const)("a %s question is reported as such, not as a denial", async (failure, wording) => {
    _resetSessionPathGrants();
    const ws = tmpWorkspace();
    let throwOnFailure: boolean | undefined;
    const ctx = {
      cwd: ws,
      sessionId: `s-${failure}`,
      askUser: async (_question: string, opts?: { throwOnFailure?: boolean }) => {
        throwOnFailure = opts?.throwOnFailure;
        throw new UserDecisionError(failure, "no answer");
      },
    } as unknown as ToolContext;
    const result = await enforcePathPolicyWithApproval(join(tmpdir(), "late.txt"), "write", ctx);
    expect(throwOnFailure).toBe(true);
    expect(result).toContain(wording);
    expect(result).toContain("No permission was granted");
    expect(result).not.toContain("denied");
    cleanup();
  });

  test("a non-decision error from the approval UI still propagates", async () => {
    const ws = tmpWorkspace();
    const ctx = {
      cwd: ws,
      askUser: async () => {
        throw new Error("transport exploded");
      },
    } as unknown as ToolContext;
    await expect(
      enforcePathPolicyWithApproval(join(tmpdir(), "late.txt"), "write", ctx),
    ).rejects.toThrow("transport exploded");
    cleanup();
  });
});
