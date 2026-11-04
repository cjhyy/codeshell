// End-to-end Host boundary for opening an external CLI session from a phone or
// Desktop: real project-path authorization (roots, subdirectories, linked
// worktrees, realpath) and the CLI's real on-disk session identity, in front of
// the Host mode authority and a real RoomManager.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "@cjhyy/code-shell-capability-coding/orchestration";
import { RoomManager, type RoomMeta } from "@cjhyy/code-shell-server/mobile-remote";
import { desktopRoomModeHostBoundary } from "./room-mode-host-boundary.js";
import {
  RoomModeAuthority,
  type RoomModeApproval,
  type RoomModeRequester,
} from "./room-mode-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeClaudeSession(claudeHome: string, cwd: string, sessionId: string): void {
  const dir = join(claudeHome, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", cwd, sessionId, message: { role: "user", content: "x" } })}\n`,
  );
}

/** A linked git worktree outside the repository, listed back by its admin dir. */
function linkWorktree(repository: string, worktree: string, name: string): void {
  const adminDir = join(repository, ".git", "worktrees", name);
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(adminDir, "commondir"), "../..\n");
  writeFileSync(join(adminDir, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(worktree, ".git"), `gitdir: ${adminDir}\n`);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-mode-boundary-")));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const subdir = join(project, "packages", "app");
  mkdirSync(subdir, { recursive: true });
  const worktree = join(root, "worktrees", "feature");
  linkWorktree(project, worktree, "feature");
  const outside = join(root, "outside");
  mkdirSync(outside);
  // A directory inside the project that really points outside it.
  const escape = join(project, "escape");
  symlinkSync(outside, escape, "dir");
  const claudeHome = join(root, "claude");
  for (const [cwd, id] of [
    [project, "s-root"],
    [subdir, "s-sub"],
    [worktree, "s-worktree"],
    [outside, "s-outside"],
    [escape, "s-escape"],
  ] as const)
    writeClaudeSession(claudeHome, cwd, id);

  const starts: Array<{ mode: string; cwd: string; session?: string }> = [];
  const approvals: RoomModeApproval[] = [];
  const manager: RoomManager = new RoomManager({
    rootDir: join(root, "rooms"),
    authorizeStart: (meta) => authority.authorizeStart(meta),
    createAgent: (meta: RoomMeta) => {
      let running = false;
      return {
        start: () => {
          running = true;
          starts.push({ mode: meta.permissionMode, cwd: meta.cwd, session: meta.claudeSessionId });
        },
        send: () => running,
        isRunning: () => running,
        stop: () => {
          running = false;
        },
      };
    },
    onMessage: () => undefined,
  });
  const authority: RoomModeAuthority = new RoomModeAuthority({
    roomManager: manager,
    ...desktopRoomModeHostBoundary({
      paths: { registeredPaths: [project], noRepoPath: join(root, "no-repo") },
      sessions: { claudeHome, codexHome: join(root, "codex") },
    }),
    trustedClaudeWorkspaces: async () => [],
    requestApproval: async (approval) => {
      approvals.push(approval);
      return { approved: true };
    },
  });
  const requester: RoomModeRequester = {
    key: "mobile:tab-1",
    channel: "mobile",
    assertCurrent: () => undefined,
  };
  const open = (
    sessionId: string,
    cwd: string,
    mode: "default" | "bypassPermissions" = "default",
  ) =>
    authority.openSession({ sessionId, cwd, kind: "claude-code", mode, requester });
  return { project, subdir, worktree, outside, escape, starts, approvals, manager, open };
}

describe("Desktop room-mode Host boundary", () => {
  test("sessions in a project subdirectory or a registered linked worktree still open from a phone", async () => {
    const f = fixture();
    await expect(f.open("s-root", f.project)).resolves.toMatchObject({ status: "running" });
    await expect(f.open("s-sub", f.subdir)).resolves.toMatchObject({ status: "running" });
    const worktree = await f.open("s-worktree", f.worktree, "bypassPermissions");
    expect(worktree).toMatchObject({ status: "running", mode: "bypassPermissions" });
    // The card and the process name the real worktree session.
    expect(f.approvals).toHaveLength(1);
    expect(f.approvals[0]).toMatchObject({ sessionId: "s-worktree", cwd: f.worktree });
    expect(f.starts).toEqual([
      { mode: "default", cwd: f.project, session: "s-root" },
      { mode: "default", cwd: f.subdir, session: "s-sub" },
      { mode: "bypassPermissions", cwd: f.worktree, session: "s-worktree" },
    ]);
  });

  test("an unregistered directory or a symlink escaping the project is refused before any card", async () => {
    const f = fixture();
    // Each has a genuine transcript; directory authorization still fails closed.
    for (const [id, cwd] of [
      ["s-outside", f.outside],
      ["s-escape", f.escape],
    ] as const) {
      await expect(f.open(id, cwd, "bypassPermissions")).rejects.toThrow(/not registered/);
    }
    expect(f.approvals).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.manager.listRooms()).toEqual([]);
  });

  test("a session id that the CLI did not record in that directory is refused before any card", async () => {
    const f = fixture();
    // s-sub exists, but in the subdirectory, not at the project root.
    await expect(f.open("s-sub", f.project, "bypassPermissions")).rejects.toThrow("CLI 会话记录");
    await expect(f.open("s-forged", f.project, "bypassPermissions")).rejects.toThrow(
      "CLI 会话记录",
    );
    expect(f.approvals).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.manager.listRooms()).toEqual([]);
  });
});
