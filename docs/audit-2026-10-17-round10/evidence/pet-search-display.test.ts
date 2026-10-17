import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessionTranscripts } from "../../../packages/pet/src/disclosure/search.ts";

function writeSession(root: string, id: string, content: string, at: number): void {
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    sessionId: id, kind: "work", origin: "desktop", parentSessionId: null,
    title: id, cwd: "/owned-fixture", status: "completed",
  }));
  writeFileSync(join(dir, "transcript.jsonl"), JSON.stringify({
    id: `message-${id}`, type: "message", timestamp: at * 1000, turnNumber: 1,
    data: { role: "user", content },
  }) + "\n");
  utimesSync(join(dir, "transcript.jsonl"), at, at);
}

describe("round10 Pet search display characterization", () => {
  test("default match cap silently slices the 21st scanned matching session", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-pet-r10-cap-"));
    try {
      for (let i = 0; i < 20; i++) {
        writeSession(root, `work-${String(i).padStart(2, "0")}`, "orchid search evidence", 1700000000 + i);
      }
      const exact = await searchSessionTranscripts(root, "orchid", {});
      expect(exact.scannedSessions).toBe(20);
      expect(exact.matches).toHaveLength(20);
      expect(exact.truncated).toBe(false);
      writeSession(root, "work-20", "orchid search evidence", 1700000020);
      const overflow = await searchSessionTranscripts(root, "orchid", {});
      expect(overflow.scannedSessions).toBe(21);
      expect(overflow.matches).toHaveLength(20);
      expect(overflow.truncated).toBe(false);
      expect(overflow.matches[0]?.sessionId).toBe("work-20");
      expect(overflow.matches.some((m) => m.sessionId === "work-00")).toBe(false);
      console.log(JSON.stringify({ case: "default-cap", exact: {
        scanned: exact.scannedSessions, matches: exact.matches.length, truncated: exact.truncated,
      }, overflow: {
        scanned: overflow.scannedSessions, matches: overflow.matches.length, truncated: overflow.truncated,
        newest: overflow.matches[0]?.sessionId,
      } }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Unicode lower-case expansion shifts snippet away from its matched text", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-pet-r10-unicode-"));
    try {
      writeSession(root, "ascii-control", "A".repeat(240) + " TARGET " + "z".repeat(240), 1700000000);
      writeSession(root, "unicode-expanded", "İ".repeat(240) + " TARGET " + "z".repeat(240), 1700000001);
      const result = await searchSessionTranscripts(root, "target", {});
      expect(result.matches).toHaveLength(2);
      const ascii = result.matches.find((m) => m.sessionId === "ascii-control")!.snippets[0]!.text;
      const unicode = result.matches.find((m) => m.sessionId === "unicode-expanded")!.snippets[0]!.text;
      expect(ascii).toContain("TARGET");
      expect(unicode).not.toContain("TARGET");
      expect(unicode).toMatch(/^…z+$/u);
      expect(result.truncated).toBe(false);
      console.log(JSON.stringify({ case: "lower-case-offset", asciiSnippet: ascii, unicodeSnippet: unicode }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
