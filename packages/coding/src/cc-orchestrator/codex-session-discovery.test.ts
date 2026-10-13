import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexSessions, listCodexSessionsForCwds } from "./codex-session-discovery.js";

/** Build one codex rollout JSONL file under <home>/sessions/YYYY/MM/DD/. */
function writeRollout(
  codexHome: string,
  datePath: string,
  fileName: string,
  lines: unknown[],
): void {
  const dir = join(codexHome, "sessions", datePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function metaLine(id: string, cwd: string, timestamp: string) {
  return { timestamp, type: "session_meta", payload: { id, cwd, timestamp } };
}
function userItem(text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
function assistantItem(text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

describe("discoverCodexSessions", () => {
  it("lists codex sessions for a cwd, reading id/firstMessage from rollout files", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/myproj";
    const id = "019e8971-b4ce-7582-9d44-bb3a9253c331";
    writeRollout(home, "2026/06/24", `rollout-2026-06-24T11-31-03-${id}.jsonl`, [
      metaLine(id, cwd, "2026-06-24T03:31:03.000Z"),
      // First user message is environment_context noise — must be skipped.
      userItem("<environment_context>\n  <cwd>/tmp/myproj</cwd>\n</environment_context>"),
      userItem("看看样式 还有没有遗漏的地方"),
      assistantItem("ok"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe(id);
    expect(got[0].firstMessage).toBe("看看样式 还有没有遗漏的地方");
  });

  it("uses the real input part as the title instead of injected host context", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/myproj";
    writeRollout(home, "2026/06/24", "rollout-context-title.jsonl", [
      metaLine("id-context-title", cwd, "2026-06-24T03:31:03.000Z"),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>hidden</environment_context>" },
            { type: "input_text", text: "修复房间输入显示" },
          ],
        },
      },
    ]);

    expect(discoverCodexSessions(cwd, home)[0]?.firstMessage).toBe("修复房间输入显示");
  });

  it("filters out sessions whose session_meta.cwd differs", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/06/24", "rollout-a.jsonl", [
      metaLine("id-a", "/tmp/wanted", "2026-06-24T01:00:00.000Z"),
      userItem("real a"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-b.jsonl", [
      metaLine("id-b", "/tmp/other", "2026-06-24T02:00:00.000Z"),
      userItem("real b"),
    ]);
    const got = discoverCodexSessions("/tmp/wanted", home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-a");
  });

  it("sorts by lastModified descending (newest first)", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    // Two files in different date dirs; mtime ordering is what matters.
    writeRollout(home, "2026/06/20", "rollout-old.jsonl", [
      metaLine("id-old", cwd, "2026-06-20T00:00:00.000Z"),
      userItem("old"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-new.jsonl", [
      metaLine("id-new", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("new"),
    ]);
    const oldFile = join(home, "sessions", "2026", "06", "20", "rollout-old.jsonl");
    const newFile = join(home, "sessions", "2026", "06", "24", "rollout-new.jsonl");
    utimesSync(oldFile, new Date(1_000), new Date(1_000));
    utimesSync(newFile, new Date(2_000), new Date(2_000));
    const got = discoverCodexSessions(cwd, home);
    expect(got.map((s) => s.sessionId)).toEqual(["id-new", "id-old"]);
  });

  it("skips files with a broken/absent session_meta first line", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    writeRollout(home, "2026/06/24", "rollout-bad.jsonl", [
      { type: "event_msg", payload: { type: "task_started" } }, // no session_meta first
      userItem("orphan"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-good.jsonl", [
      metaLine("id-good", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("good"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-good");
  });

  it("returns [] when the sessions dir is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(discoverCodexSessions("/tmp/nope", home)).toEqual([]);
  });

  it("tolerates a session with no real user message (firstMessage empty)", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    writeRollout(home, "2026/06/24", "rollout-meta-only.jsonl", [
      metaLine("id-only", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("<environment_context>only noise</environment_context>"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-only");
    expect(got[0].firstMessage).toBe("");
  });
});

import { discoverRecentCodexSessions } from "./codex-session-discovery.js";

describe("listCodexSessionsForCwds", () => {
  it("returns a bounded recent list and counts unique matching threads across all dates", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-list-"));
    const cwd = "/tmp/project";
    const now = Date.now();
    for (const [file, id, modified] of [
      ["old", "thread-old", now - 10_000],
      ["new", "thread-new", now - 100],
      ["resume", "thread-new", now],
      ["middle", "thread-middle", now - 200],
    ] as const) {
      writeRollout(home, "2026/06/24", `rollout-${file}.jsonl`, [
        metaLine(id, cwd, "2026-06-24T00:00:00Z"),
        userItem(file),
      ]);
      const path = join(home, "sessions/2026/06/24", `rollout-${file}.jsonl`);
      utimesSync(path, new Date(modified), new Date(modified));
    }
    writeRollout(home, "2026/06/24", "rollout-other.jsonl", [
      metaLine("other", "/tmp/other", "2026-06-24T00:00:00Z"),
    ]);
    const limited = await listCodexSessionsForCwds([cwd], home, { limit: 1, sinceMs: 1_000, now });
    expect(limited.total).toBe(3);
    expect(limited.sessions.map((s) => [s.sessionId, s.firstMessage])).toEqual([
      ["thread-new", "resume"],
    ]);
    const all = await listCodexSessionsForCwds([cwd], home);
    expect(all.total).toBe(3);
    expect(all.sessions.map((s) => s.sessionId)).toEqual([
      "thread-new",
      "thread-middle",
      "thread-old",
    ]);
  });

  it("yields to host events while reading identities, and tolerates broken files and directory cycles", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-list-"));
    const cwd = "/tmp/project";
    writeRollout(home, "2026/06/24", "rollout-valid.jsonl", [
      // Exercise the incremental metadata reader beyond its first 4 KiB chunk.
      { ...metaLine("valid", cwd, "2026-06-24T00:00:00Z"), padding: "字".repeat(5_000) },
      userItem("<environment_context>hidden</environment_context>"),
      userItem("real title"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-broken.jsonl", ["broken"]);
    const root = join(home, "sessions");
    symlinkSync(root, join(root, "cycle"), process.platform === "win32" ? "junction" : "dir");
    let hostEventRan = false;
    const hostEvent = new Promise<void>((resolve) => {
      setImmediate(() => {
        hostEventRan = true;
        resolve();
      });
    });
    const listing = listCodexSessionsForCwds([cwd], home);
    const result = await listing;
    expect(hostEventRan).toBe(true);
    await hostEvent;
    expect(result.total).toBe(1);
    expect(result.sessions[0]?.firstMessage).toBe("real title");
  });

  it("handles absent history and an empty project scope", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-list-"));
    expect(await listCodexSessionsForCwds(["/missing"], home)).toEqual({ sessions: [], total: 0 });
    expect(await listCodexSessionsForCwds([], home)).toEqual({ sessions: [], total: 0 });
  });
});

describe("discoverRecentCodexSessions", () => {
  it("returns recent sessions across all cwds with file path, newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/07/19", "rollout-a.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-19T10:00:00Z"),
      userItem("fix the login bug"),
    ]);
    writeRollout(home, "2026/07/20", "rollout-b.jsonl", [
      metaLine("thread-b", "/tmp/proj-b", "2026-07-20T10:00:00Z"),
      userItem("write release notes"),
    ]);
    const first = join(home, "sessions", "2026", "07", "19", "rollout-a.jsonl");
    const second = join(home, "sessions", "2026", "07", "20", "rollout-b.jsonl");
    utimesSync(first, new Date(1_000), new Date(1_000));
    utimesSync(second, new Date(2_000), new Date(2_000));

    const sessions = discoverRecentCodexSessions({}, home);
    expect(sessions.map((s) => s.sessionId)).toEqual(["thread-b", "thread-a"]);
    expect(sessions[0]!.cwd).toBe("/tmp/proj-b");
    expect(sessions[0]!.file.endsWith("rollout-b.jsonl")).toBe(true);
    expect(sessions[0]!.firstMessage).toBe("write release notes");
    expect(sessions[0]!.lastModified).toBeGreaterThan(0);
  });

  it("dedupes by sessionId keeping the newest rollout, honors sinceMs, skips broken files", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/07/18", "rollout-old.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-18T10:00:00Z"),
      userItem("first attempt"),
    ]);
    writeRollout(home, "2026/07/20", "rollout-new.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-20T10:00:00Z"),
      userItem("resumed"),
    ]);
    const brokenDir = join(home, "sessions", "2026", "07", "20");
    writeFileSync(join(brokenDir, "rollout-broken.jsonl"), "not-json\n");
    const oldFile = join(home, "sessions", "2026", "07", "18", "rollout-old.jsonl");
    const past = Date.now() - 48 * 60 * 60_000;
    utimesSync(oldFile, new Date(past), new Date(past));

    const sessions = discoverRecentCodexSessions({ sinceMs: 24 * 60 * 60_000 }, home);
    expect(sessions.map((s) => s.sessionId)).toEqual(["thread-a"]);
    expect(sessions[0]!.file.endsWith("rollout-new.jsonl")).toBe(true);
  });

  it("applies project scope before the result limit and maps nested cwd to its root", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/07/19", "rollout-enabled.jsonl", [
      metaLine("thread-enabled", "/tmp/proj-a/packages/app", "2026-07-19T10:00:00Z"),
      userItem("keep"),
    ]);
    const disabledFile = join(home, "sessions", "2026", "07", "20", "rollout-disabled.jsonl");
    writeRollout(home, "2026/07/20", "rollout-disabled.jsonl", [
      metaLine("thread-disabled", "/tmp/proj-b", "2026-07-20T10:00:00Z"),
      userItem("drop"),
    ]);
    const now = Date.now();
    utimesSync(disabledFile, new Date(now + 1_000), new Date(now + 1_000));

    const sessions = discoverRecentCodexSessions({ limit: 1 }, home, {
      includeUnregistered: false,
      projectRoots: [
        { cwd: "/tmp/proj-a/", enabled: true },
        { cwd: "/tmp/proj-b/", enabled: false },
      ],
    });
    expect(sessions.map((session) => session.sessionId)).toEqual(["thread-enabled"]);
  });
});
