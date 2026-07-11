import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupStaleQuickChatSessions, deleteSessionDir, listSessions } from "./sessions-service";

describe("deleteSessionDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ss-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a session directory", async () => {
    const sdir = path.join(dir, "sess-1");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), "x");
    await deleteSessionDir("sess-1", dir);
    expect(fs.existsSync(sdir)).toBe(false);
  });

  it("removes a legacy flat file", async () => {
    fs.writeFileSync(path.join(dir, "sess-2.jsonl"), "x");
    await deleteSessionDir("sess-2", dir);
    expect(fs.existsSync(path.join(dir, "sess-2.jsonl"))).toBe(false);
  });

  it("is a no-op (no throw) when nothing exists", async () => {
    await deleteSessionDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("refuses to delete for an unsafe id (path traversal)", async () => {
    // Create a sibling dir one level above baseDir's child to prove no escape.
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    await deleteSessionDir("..", dir); // bare ".." must be rejected
    await deleteSessionDir("../victim", dir); // slashes + .. rejected
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("removes only stale quick-chat disk records before a new desktop lifecycle", async () => {
    const quickDir = path.join(dir, "qchat-crash-leftover");
    const normalDir = path.join(dir, "normal-session");
    fs.mkdirSync(quickDir);
    fs.mkdirSync(normalDir);
    fs.writeFileSync(path.join(quickDir, "transcript.jsonl"), "quick transcript");
    fs.writeFileSync(path.join(normalDir, "transcript.jsonl"), "normal transcript");
    fs.writeFileSync(path.join(dir, "qchat-legacy.jsonl"), "legacy quick transcript");
    fs.writeFileSync(path.join(dir, "normal-legacy.jsonl"), "legacy normal transcript");

    expect((await cleanupStaleQuickChatSessions(dir)).sort()).toEqual([
      "qchat-crash-leftover",
      "qchat-legacy",
    ]);
    expect(fs.existsSync(quickDir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "qchat-legacy.jsonl"))).toBe(false);
    expect(fs.existsSync(normalDir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "normal-legacy.jsonl"))).toBe(true);
  });

  it("removes only proven ephemeral qchat fork staging directories", async () => {
    const ephemeralStage = path.join(dir, ".pending-fork-qchat-ephemeral-12345678");
    const persistentStage = path.join(dir, ".pending-fork-qchat-persistent-12345678");
    const nonQuickStage = path.join(dir, ".pending-fork-normal-ephemeral-12345678");
    for (const stage of [ephemeralStage, persistentStage, nonQuickStage]) {
      fs.mkdirSync(stage);
      fs.writeFileSync(path.join(stage, "transcript.jsonl"), "copied parent transcript");
    }
    fs.writeFileSync(
      path.join(ephemeralStage, "state.json"),
      JSON.stringify({ sessionId: "qchat-ephemeral", ephemeral: true }),
    );
    fs.writeFileSync(
      path.join(persistentStage, "state.json"),
      JSON.stringify({ sessionId: "qchat-persistent", ephemeral: false }),
    );
    fs.writeFileSync(
      path.join(nonQuickStage, "state.json"),
      JSON.stringify({ sessionId: "normal-ephemeral", ephemeral: true }),
    );

    expect(await cleanupStaleQuickChatSessions(dir)).toEqual([
      ".pending-fork-qchat-ephemeral-12345678",
    ]);
    expect(fs.existsSync(ephemeralStage)).toBe(false);
    expect(fs.existsSync(persistentStage)).toBe(true);
    expect(fs.existsSync(nonQuickStage)).toBe(true);
  });

  it("does not expose legacy flat qchat records in the sessions view", async () => {
    fs.writeFileSync(path.join(dir, "qchat-hidden.jsonl"), "quick transcript");
    fs.writeFileSync(path.join(dir, "normal-visible.jsonl"), "normal transcript");

    expect((await listSessions(dir)).map((session) => session.id)).toEqual(["normal-visible"]);
  });
});
