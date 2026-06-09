import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { enforcePathPolicyWithApproval, _resetSessionPathGrants } from "./path-policy.js";
import type { ToolContext } from "./context.js";

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
  capture?: { question?: string; header?: string },
): ToolContext {
  return {
    cwd,
    askUser: async (question: string, opts?: { header?: string }) => {
      if (capture) {
        capture.question = question;
        capture.header = opts?.header;
      }
      return answer;
    },
  } as unknown as ToolContext;
}

describe("enforcePathPolicyWithApproval", () => {
  test("exact 允许本次 → allowed (returns null)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    const res = await enforcePathPolicyWithApproval(outside, "read", ctxAnswering(ws, "允许本次"));
    expect(res).toBeNull();
    cleanup();
  });

  test("a prefix-but-not-exact answer is NOT treated as allow (the startsWith bug)", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    // Simulate a future scope option whose label starts with "允许本次".
    const res = await enforcePathPolicyWithApproval(
      outside,
      "read",
      ctxAnswering(ws, "允许本次会话"),
    );
    expect(res).not.toBeNull();
    expect(res).toContain("approval denied");
    cleanup();
  });

  test("拒绝 → denied", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "definitely-outside-the-workspace.txt");
    const res = await enforcePathPolicyWithApproval(outside, "read", ctxAnswering(ws, "拒绝"));
    expect(res).toContain("approval denied");
    cleanup();
  });

  test("outside-workspace ask is titled 工作区外, not 敏感文件", async () => {
    const ws = tmpWorkspace();
    const outside = join(tmpdir(), "outside-x.txt");
    const cap: { question?: string; header?: string } = {};
    await enforcePathPolicyWithApproval(outside, "read", ctxAnswering(ws, "拒绝", cap));
    expect(cap.question).toContain("工作区外");
    expect(cap.header).toBe("路径权限");
    cleanup();
  });

  test("a sensitive file (e.g. ~/.ssh/config) is titled 敏感文件, not 工作区外", async () => {
    const ws = tmpWorkspace();
    const sensitive = join(homedir(), ".ssh", "config");
    const cap: { question?: string; header?: string } = {};
    const res = await enforcePathPolicyWithApproval(sensitive, "read", ctxAnswering(ws, "拒绝", cap));
    // ~/.ssh classifies as sensitive (ask on read) → titled accordingly.
    expect(res).toContain("approval denied");
    expect(cap.question).toContain("敏感文件");
    expect(cap.header).toBe("敏感文件权限");
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
    expect(await enforcePathPolicyWithApproval(fileA, "read", ctxGrant)).toBeNull();
    // Second file in the SAME dir: no prompt (calls stays 1).
    expect(await enforcePathPolicyWithApproval(fileB, "read", ctxGrant)).toBeNull();
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
    expect(await enforcePathPolicyWithApproval(fileA, "read", ctxOther)).toContain("denied");
    expect(asked2).toBe(true);
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
    expect(await enforcePathPolicyWithApproval(file, "read", ctxGrant)).toBeNull();

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
    expect(await enforcePathPolicyWithApproval(file, "read", ctxFresh)).toBeNull();
    expect(asked).toBe(false); // covered by persisted project grant
    expect(calls).toBe(1);
    cleanup();
  });
});
