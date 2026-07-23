import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkSessionsOnDisk } from "./catalog.js";
import { sessionSelectorId } from "./selector.js";

function writeSession(
  root: string,
  sessionId: string,
  state: Record<string, unknown>,
  mtimeMs?: number,
): void {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ sessionId, ...state }), "utf-8");
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(transcriptPath, "", "utf-8");
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    utimesSync(transcriptPath, seconds, seconds);
  }
}

describe("listWorkSessionsOnDisk", () => {
  test("filters pet/subagent/child/ephemeral sessions, keeps a work session with title/cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-catalog-"));
    writeSession(root, "work-1", {
      kind: "work",
      cwd: "/Users/dev/project",
      title: "Fix the bug",
      status: "active",
    });
    writeSession(root, "pet-1", { kind: "pet", cwd: "/x" });
    writeSession(root, "subagent-1", { kind: "work", origin: "subagent", cwd: "/x" });
    writeSession(root, "child-1", { kind: "work", parentSessionId: "work-1", cwd: "/x" });
    writeSession(root, "ephemeral-1", { kind: "work", ephemeral: true, cwd: "/x" });

    const result = await listWorkSessionsOnDisk(root, { limit: 10 });

    expect(result.length).toBe(1);
    expect(result[0]?.sessionId).toBe("work-1");
    expect(result[0]?.title).toBe("Fix the bug");
    expect(result[0]?.cwd).toBe("/Users/dev/project");
    expect(result[0]?.status).toBe("active");
  });

  test("sorts by updatedAt desc and honours limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-catalog-sort-"));
    const now = Date.now();
    writeSession(root, "older", { kind: "work", cwd: "/a", summary: "older session" }, now);
    writeSession(root, "newer", { kind: "work", cwd: "/b", summary: "newer session" }, now + 20);

    const result = await listWorkSessionsOnDisk(root, { limit: 1 });

    expect(result.length).toBe(1);
    expect(result[0]?.sessionId).toBe("newer");
  });

  test("missing root directory returns empty array", async () => {
    const root = join(tmpdir(), "pet-disclosure-catalog-missing-" + Date.now());

    const result = await listWorkSessionsOnDisk(root, { limit: 10 });

    expect(result).toEqual([]);
  });
});

describe("sessionSelectorId", () => {
  test("matches the desktop pet-dispatch-service reusableSessionId convention", () => {
    const expected = `session-${createHash("sha256").update("abc").digest("hex").slice(0, 20)}`;

    expect(sessionSelectorId("abc")).toBe(expected);
  });
});
