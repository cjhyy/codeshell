import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessionTranscripts } from "./search.js";

interface MessageEvent {
  role: string;
  content: unknown;
  turnNumber?: number;
}

function writeSession(
  root: string,
  sessionId: string,
  state: Record<string, unknown>,
  messages: MessageEvent[],
): void {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ sessionId, ...state }), "utf-8");
  const lines = messages.map((message, index) =>
    JSON.stringify({
      id: `e${index}`,
      type: "message",
      timestamp: 1000 + index,
      turnNumber: message.turnNumber ?? 0,
      data: { role: message.role, content: message.content },
    }),
  );
  writeFileSync(join(dir, "transcript.jsonl"), lines.join("\n") + "\n", "utf-8");
}

describe("searchSessionTranscripts", () => {
  test("finds a keyword across sessions case-insensitively with multiple snippets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-"));
    writeSession(root, "session-a", { kind: "work", cwd: "/a", title: "Session A" }, [
      { role: "user", content: "Can you help me fix the Widget rendering bug?", turnNumber: 0 },
      { role: "assistant", content: "Sure, let's look at the widget code.", turnNumber: 1 },
    ]);
    writeSession(root, "session-b", { kind: "work", cwd: "/b", title: "Session B" }, [
      { role: "user", content: "unrelated question about pizza", turnNumber: 0 },
    ]);

    const result = await searchSessionTranscripts(root, "widget", {});

    expect(result.truncated).toBe(false);
    expect(result.scannedSessions).toBe(2);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.sessionId).toBe("session-a");
    expect(result.matches[0]?.snippets.length).toBe(2);
  });

  test("excludes pet/subagent sessions and respects maxSessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-cap-"));
    writeSession(root, "work-1", { kind: "work", cwd: "/a", title: "Work 1" }, [
      { role: "user", content: "banana smoothie recipe", turnNumber: 0 },
    ]);
    writeSession(root, "work-2", { kind: "work", cwd: "/b", title: "Work 2" }, [
      { role: "user", content: "banana bread recipe", turnNumber: 0 },
    ]);
    writeSession(root, "pet-1", { kind: "pet", cwd: "/c" }, [
      { role: "user", content: "banana secret pet chat", turnNumber: 0 },
    ]);
    writeSession(root, "subagent-1", { kind: "work", origin: "subagent", cwd: "/d" }, [
      { role: "user", content: "banana subagent chat", turnNumber: 0 },
    ]);

    const result = await searchSessionTranscripts(root, "banana", { maxSessions: 1 });

    expect(result.matches.length).toBe(1);
    expect(["work-1", "work-2"]).toContain(result.matches[0]?.sessionId);
  });

  test("truncated is true when the deadline is exceeded before all candidates are scanned", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-deadline-"));
    writeSession(root, "work-1", { kind: "work", cwd: "/a", title: "Work 1" }, [
      { role: "user", content: "papaya smoothie recipe", turnNumber: 0 },
    ]);
    writeSession(root, "work-2", { kind: "work", cwd: "/b", title: "Work 2" }, [
      { role: "user", content: "papaya bread recipe", turnNumber: 0 },
    ]);

    const result = await searchSessionTranscripts(root, "papaya", { budgetMs: -1 });

    expect(result.truncated).toBe(true);
  });

  test("blank query returns empty matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-blank-"));
    writeSession(root, "work-1", { kind: "work", cwd: "/a", title: "Work 1" }, [
      { role: "user", content: "hello", turnNumber: 0 },
    ]);

    const result = await searchSessionTranscripts(root, "   ", {});

    expect(result.matches).toEqual([]);
  });

  test("truncated is false when all candidates are processed and matches exactly fill maxSessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-exact-"));
    writeSession(root, "work-1", { kind: "work", cwd: "/a", title: "Work 1" }, [
      { role: "user", content: "mango smoothie recipe", turnNumber: 0 },
    ]);
    writeSession(root, "work-2", { kind: "work", cwd: "/b", title: "Work 2" }, [
      { role: "user", content: "mango bread recipe", turnNumber: 0 },
    ]);

    const result = await searchSessionTranscripts(root, "mango", { maxSessions: 2 });

    expect(result.matches.length).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("scannedSessions does not count a candidate missing transcript.jsonl", async () => {
    const root = mkdtempSync(join(tmpdir(), "pet-disclosure-search-missing-transcript-"));
    writeSession(root, "work-1", { kind: "work", cwd: "/a", title: "Work 1" }, [
      { role: "user", content: "kiwi smoothie recipe", turnNumber: 0 },
    ]);
    // Work session on disk with state.json but no transcript.jsonl.
    mkdirSync(join(root, "work-no-transcript"), { recursive: true });
    writeFileSync(
      join(root, "work-no-transcript", "state.json"),
      JSON.stringify({ sessionId: "work-no-transcript", kind: "work", cwd: "/c" }),
      "utf-8",
    );

    const result = await searchSessionTranscripts(root, "kiwi", {});

    expect(result.scannedSessions).toBe(1);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.sessionId).toBe("work-1");
  });
});
