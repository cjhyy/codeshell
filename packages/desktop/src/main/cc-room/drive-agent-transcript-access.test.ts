import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexRecentHistory } from "@cjhyy/code-shell-capability-coding/orchestration";
import { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { TaskInboxBackgroundEntry } from "../task-inbox/task-inbox-sources.js";
import { requireRendererLinkedSessionPath } from "../renderer-project-path.js";
import { DriveAgentTranscriptAccess } from "./drive-agent-transcript-access.js";
import { resolveLinkedSessionFromDisk } from "./linked-session-resolver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "drive-transcript-")));
  roots.push(root);
  const cwd = join(root, "delegation-parent");
  const project = join(root, "project");
  await mkdir(cwd);
  await mkdir(project);
  const source = { jobId: "job-1", sourceSessionId: "parent-session" };
  const target = { externalSessionId: "thread-1", cwd, kind: "codex" as const };
  const job: TaskInboxBackgroundEntry = {
    kind: "job",
    jobKind: "drive-agent",
    jobId: source.jobId,
    description: "Run delegated work",
    status: "running",
    startedAt: 1,
    sourceSession: { sessionId: source.sourceSessionId, shortId: "parent", current: true },
    cwd,
    cli: "codex",
    externalSessionId: target.externalSessionId,
  };
  const access = new DriveAgentTranscriptAccess(async () => [job]);
  const open = () => ({ roomId: "room-1", cwd });
  return { root, cwd, project, source, target, job, access, open };
}

describe("DriveAgent transcript observation authority", () => {
  test("reads a delegated Codex transcript outside project roots without spawning or granting takeover", async () => {
    const f = await fixture();
    const codexHome = join(f.root, "codex");
    const sessions = join(codexHome, "sessions", "2026", "10", "29");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-thread-1.jsonl"),
      [
        { type: "session_meta", payload: { id: "thread-1", cwd: f.cwd } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Fixing the Linux CI failure" }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const pathOptions = { registeredPaths: [f.project], noRepoPath: join(f.root, "no-repo") };
    await expect(requireRendererLinkedSessionPath(f.cwd, pathOptions)).rejects.toThrow(
      "not registered",
    );
    let starts = 0;
    const manager = new RoomManager({
      rootDir: join(f.root, "rooms"),
      resolveLinkedSession: (target) => resolveLinkedSessionFromDisk(target, { codexHome }),
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
    const linked = await f.access.open(10, f.source, f.target, (target) =>
      manager.openLinkedSession(target.externalSessionId, target.cwd, target.kind),
    );
    expect(linked.status).toBe("observing");
    expect(starts).toBe(0);
    expect(manager.open(linked.roomId)).toEqual({ status: "observing" });
    const cwd = await f.access.requireSubscription(10, linked.roomId, f.target);
    expect(readCodexRecentHistory(cwd, "thread-1", 20, codexHome).messages).toEqual([
      { role: "assistant", text: "Fixing the Linux CI failure" },
    ]);
    // The writable takeover IPC retains this gate, with no observation fallback.
    await expect(requireRendererLinkedSessionPath(f.cwd, pathOptions)).rejects.toThrow(
      "not registered",
    );
    expect(starts).toBe(0);
  });

  test("requires the exact job, parent, CLI, external session and launch directory", async () => {
    const f = await fixture();
    for (const source of [
      undefined,
      {},
      { ...f.source, jobId: "other" },
      { ...f.source, sourceSessionId: "other" },
    ]) {
      await expect(f.access.open(10, source, f.target, f.open)).rejects.toThrow();
    }
    for (const target of [
      { ...f.target, externalSessionId: "other" },
      { ...f.target, kind: "claude-code" },
      { ...f.target, cwd: f.project },
      { ...f.target, cwd: "relative" },
    ]) {
      await expect(f.access.open(10, f.source, target, f.open)).rejects.toThrow();
    }
    const unrelatedJob = new DriveAgentTranscriptAccess(async () => [
      { ...f.job, jobKind: "video" },
    ]);
    await expect(unrelatedJob.open(10, f.source, f.target, f.open)).rejects.toThrow();
    await expect(f.access.requireSubscription(10, "room-1", f.target)).rejects.toThrow();
  });

  test("grants only after disk identity validation succeeds, and scopes subscriptions to a window and room", async () => {
    const f = await fixture();
    await expect(
      f.access.open(10, f.source, f.target, () => {
        throw new Error("transcript identity mismatch");
      }),
    ).rejects.toThrow("identity mismatch");
    await expect(f.access.requireSubscription(10, "room-1", f.target)).rejects.toThrow();
    await f.access.open(10, f.source, f.target, f.open);
    await expect(f.access.requireSubscription(11, "room-1", f.target)).rejects.toThrow();
    await expect(f.access.requireSubscription(10, "room-2", f.target)).rejects.toThrow();
    for (const target of [
      { ...f.target, cwd: f.project },
      { ...f.target, externalSessionId: "other" },
      { ...f.target, kind: "claude-code" },
    ]) {
      await expect(f.access.requireSubscription(10, "room-1", target)).rejects.toThrow();
    }
    f.access.forgetRoom(10, "room-1");
    await expect(f.access.requireSubscription(10, "room-1", f.target)).rejects.toThrow();
    await f.access.open(10, f.source, f.target, f.open);
    f.access.forgetSender(10);
    await expect(f.access.requireSubscription(10, "room-1", f.target)).rejects.toThrow();
  });

  test("canonicalizes the job directory and rejects a retargeted symlink", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias");
    await symlink(f.cwd, alias, "dir");
    const target = { ...f.target, cwd: alias };
    await f.access.open(10, f.source, target, f.open);
    await expect(f.access.requireSubscription(10, "room-1", target)).resolves.toBe(f.cwd);
    await rm(alias);
    await symlink(f.project, alias, "dir");
    await expect(f.access.requireSubscription(10, "room-1", target)).rejects.toThrow();
  });
});
