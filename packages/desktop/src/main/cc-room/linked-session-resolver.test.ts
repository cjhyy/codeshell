import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeCwd } from "@cjhyy/code-shell-capability-coding/orchestration";
import { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { resolveLinkedSessionFromDisk } from "./linked-session-resolver.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "linked-session-resolver-"));
  roots.push(root);
  return root;
}

function writeClaudeSession(
  claudeHome: string,
  cwd: string,
  fileSessionId: string,
  identitySessionId = fileSessionId,
): void {
  const dir = join(claudeHome, "projects", encodeCwd(resolve(cwd)));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${fileSessionId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      cwd,
      sessionId: identitySessionId,
      message: { role: "user", content: "private transcript content" },
    })}\n`,
  );
}

function writeCodexSession(codexHome: string, cwd: string, sessionId: string): void {
  const dir = join(codexHome, "sessions", "2026", "07", "22");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-07-22T00-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`,
  );
}

describe("resolveLinkedSessionFromDisk", () => {
  test("maps claude-code to Claude storage and returns a canonical exact tuple", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    const codexHome = join(root, "codex");
    writeClaudeSession(claudeHome, "/tmp/project", "claude-1");

    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-1", cwd: "/tmp/project/", kind: "claude-code" },
        { claudeHome, codexHome },
      ),
    ).toEqual({
      externalSessionId: "claude-1",
      cwd: "/tmp/project",
      kind: "claude-code",
    });
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-1", cwd: "/tmp/project", kind: "codex" },
        { claudeHome, codexHome },
      ),
    ).toBeNull();
  });

  test("rejects missing and mismatched Claude identities, including encodeCwd collisions", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    writeClaudeSession(claudeHome, "/foo-bar", "claude-collision");
    writeClaudeSession(claudeHome, "/tmp/project", "claude-file", "claude-other");

    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-collision", cwd: "/foo/bar", kind: "claude-code" },
        { claudeHome },
      ),
    ).toBeNull();
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-file", cwd: "/tmp/project", kind: "claude-code" },
        { claudeHome },
      ),
    ).toBeNull();
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "missing", cwd: "/tmp/project", kind: "claude-code" },
        { claudeHome },
      ),
    ).toBeNull();
  });

  test("finds the Claude identity after cwd-less metadata and large hook records", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    const cwd = "/tmp/项目/codeshell";
    const dir = join(claudeHome, "projects", encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    const lines = (sessionId: string, identitySessionId: string, hookBytes: number) =>
      [
        { type: "last-prompt", leafUuid: "leaf", sessionId },
        { type: "mode", mode: "normal", sessionId },
        { type: "permission-mode", permissionMode: "default", sessionId },
        { type: "file-history-snapshot", messageId: "m1", snapshot: { messageId: "m1" } },
        {
          attachment: { type: "hook_success", hookName: "SessionStart:startup" },
          content: "x".repeat(hookBytes),
          sessionId,
        },
        {
          type: "user",
          cwd,
          sessionId: identitySessionId,
          message: { role: "user", content: "hi" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n");
    writeFileSync(
      join(dir, "claude-hooked.jsonl"),
      `${lines("claude-hooked", "claude-hooked", 8 * 1024)}\n`,
    );
    writeFileSync(
      join(dir, "claude-forked.jsonl"),
      `${lines("claude-forked", "claude-other", 16)}\n`,
    );
    writeFileSync(
      join(dir, "claude-huge.jsonl"),
      `${lines("claude-huge", "claude-huge", 300 * 1024)}\n`,
    );

    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-hooked", cwd, kind: "claude-code" },
        { claudeHome },
      ),
    ).toEqual({ externalSessionId: "claude-hooked", cwd, kind: "claude-code" });
    // The first cwd-bearing record is authoritative; later records cannot rescue it.
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-forked", cwd, kind: "claude-code" },
        { claudeHome },
      ),
    ).toBeNull();
    // An identity beyond the read bound fails closed.
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "claude-huge", cwd, kind: "claude-code" },
        { claudeHome },
      ),
    ).toBeNull();
  });

  test("maps codex to rollout metadata and rejects cwd or kind mismatches", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    const codexHome = join(root, "codex");
    writeCodexSession(codexHome, "/tmp/codex-project/", "thread-1");

    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "thread-1", cwd: "/tmp/codex-project", kind: "codex" },
        { claudeHome, codexHome },
      ),
    ).toEqual({ externalSessionId: "thread-1", cwd: "/tmp/codex-project", kind: "codex" });
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "thread-1", cwd: "/tmp/other", kind: "codex" },
        { codexHome },
      ),
    ).toBeNull();
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "thread-1", cwd: "/tmp/codex-project", kind: "claude-code" },
        { claudeHome, codexHome },
      ),
    ).toBeNull();
  });

  test("rejects unsafe ids and non-absolute cwd before probing storage", () => {
    const root = fixtureRoot();
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "../escape", cwd: "/tmp/project", kind: "claude-code" },
        { claudeHome: root },
      ),
    ).toBeNull();
    expect(
      resolveLinkedSessionFromDisk(
        { externalSessionId: "safe", cwd: "relative/project", kind: "codex" },
        { codexHome: root },
      ),
    ).toBeNull();
  });

  test("production resolver binds observe-only and only explicit takeover spawns", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    const roomsRoot = join(root, "rooms");
    writeClaudeSession(claudeHome, "/tmp/project", "claude-live");
    let starts = 0;
    const manager = new RoomManager({
      rootDir: roomsRoot,
      resolveLinkedSession: (target) =>
        resolveLinkedSessionFromDisk(target, { claudeHome, codexHome: join(root, "codex") }),
      createAgent: () => ({
        start: () => {
          starts += 1;
        },
        send: () => true,
        isRunning: () => starts > 0,
        stop: () => {},
      }),
      onMessage: () => {},
    });

    const linked = manager.openLinkedSession("claude-live", "/tmp/project/", "claude-code");
    expect(linked).toMatchObject({ status: "observing", cwd: "/tmp/project" });
    expect(starts).toBe(0);
    expect(manager.open(linked.roomId)).toEqual({ status: "observing" });
    expect(starts).toBe(0);

    expect(
      manager.takeOverLinkedSession(linked.roomId, "claude-live", "/tmp/project", "claude-code"),
    ).toMatchObject({ status: "running", cwd: "/tmp/project", mode: "default" });
    expect(starts).toBe(1);

    manager.close(linked.roomId);
    const observedAgain = manager.openLinkedSession("claude-live", "/tmp/project", "claude-code");
    expect(observedAgain.status).toBe("observing");
    expect(manager.getRoom(linked.roomId)?.linkedSessionMode).toBeUndefined();
    expect(manager.open(linked.roomId)).toEqual({ status: "running" });
    expect(starts).toBe(2);
  });

  test("takeover drops an inherited bypass mode to the safe default", () => {
    const root = fixtureRoot();
    const claudeHome = join(root, "claude");
    writeClaudeSession(claudeHome, "/tmp/risky-project", "claude-risky");
    let starts = 0;
    const manager = new RoomManager({
      rootDir: join(root, "rooms"),
      resolveLinkedSession: (target) =>
        resolveLinkedSessionFromDisk(target, { claudeHome, codexHome: join(root, "codex") }),
      createAgent: () => ({
        start: () => {
          starts += 1;
        },
        send: () => true,
        isRunning: () => starts > 0,
        stop: () => {},
      }),
      onMessage: () => {},
    });
    const room = manager.createRoom({
      cwd: "/tmp/risky-project",
      kind: "claude-code",
      permissionMode: "bypassPermissions",
      claudeSessionId: "claude-risky",
    });

    expect(
      manager.openLinkedSession("claude-risky", "/tmp/risky-project", "claude-code"),
    ).toMatchObject({ status: "observing", mode: "bypassPermissions" });
    expect(manager.getRoom(room.id)?.linkedSessionMode).toBeUndefined();
    expect(
      manager.takeOverLinkedSession(room.id, "claude-risky", "/tmp/risky-project", "claude-code"),
    ).toMatchObject({ status: "running", mode: "default" });
    expect(manager.getRoom(room.id)?.permissionMode).toBe("default");
    expect(starts).toBe(1);
  });
});
