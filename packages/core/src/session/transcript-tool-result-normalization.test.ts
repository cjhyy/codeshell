import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "./transcript.js";

describe("Transcript tool-result normalization", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-transcript-tool-result-"));
    file = join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not persist an interrupted result when a reader loads an in-flight tool", () => {
    const transcript = new Transcript(file);
    transcript.appendMessage("assistant", [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/a" } },
    ]);
    transcript.appendToolUse("Read", "read-1", { file_path: "/tmp/a" });
    const before = readFileSync(file, "utf8");

    const loaded = Transcript.loadFromFile(file);

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(loaded.getEvents("tool_result")).toHaveLength(0);
  });

  it("prefers a real late result over a legacy synthetic duplicate", () => {
    const transcript = new Transcript(file);
    transcript.appendMessage("assistant", [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/a" } },
    ]);
    transcript.appendToolUse("Read", "read-1", { file_path: "/tmp/a" });
    transcript.append("tool_result", {
      toolCallId: "read-1",
      toolName: "unknown",
      error: "[Tool result missing due to interrupted session]",
    });
    transcript.appendToolResult("read-1", "Read", "real file contents");
    const before = readFileSync(file, "utf8");

    const loaded = Transcript.loadFromFile(file);
    const results = loaded.getEvents("tool_result");
    const messages = loaded.toMessages();
    const resultBlocks = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result")
        : [],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.data.toolName).toBe("Read");
    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0]?.content).toBe("real file contents");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("drops an orphaned result from a detached loaded snapshot", () => {
    const transcript = new Transcript(file);
    transcript.appendToolResult("never-declared", "Read", "orphan");

    const loaded = Transcript.loadFromFile(file);

    expect(loaded.getEvents("tool_result")).toHaveLength(0);
    expect(loaded.toMessages()).toHaveLength(0);
  });
});
