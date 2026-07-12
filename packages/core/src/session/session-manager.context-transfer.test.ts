import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager context-transfer fork", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("persists one context_transfer event and hydrates it as model background", () => {
    dir = mkdtempSync(join(tmpdir(), "session-context-transfer-"));
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "source");
    const from = source.transcript.appendMessage("user", "selected original text");
    const to = source.transcript.appendMessage("assistant", "selected original answer");

    manager.createSummaryFork("source", {
      targetSessionId: "target",
      fromEventId: from.id,
      toEventId: to.id,
      summary: "portable background only",
      sourceEventCount: 2,
      estimatedTokens: 4,
    });

    const persisted = readFileSync(join(dir, "target", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persisted.map((event) => event.type)).toEqual(["session_meta", "context_transfer"]);
    expect(persisted[1]?.data).toMatchObject({
      summary: "portable background only",
      sourceRange: {
        sessionId: "source",
        fromEventId: from.id,
        toEventId: to.id,
      },
      sourceEventCount: 2,
      estimatedTokens: 4,
      summaryVersion: 1,
    });

    const messages = new SessionManager(dir).resume("target").transcript.toMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(String(messages[0]?.content)).toContain("portable background only");
    expect(String(messages[0]?.content)).toContain("Background context");
    expect(JSON.stringify(messages)).not.toContain("selected original text");
  });
});
