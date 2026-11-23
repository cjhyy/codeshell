import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StoredMimiWorkMemory } from "./mimi-work-memory.js";
test("work-memory owner reopens a pending clear once, closes at the real turn anchor and returns only bounded segment data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-mimi-work-"));
  try {
    const sessionId = "mimi-restart";
    const first = new StoredMimiWorkMemory(dir);
    await first.run({ type: "begin", sessionId, clientMessageId: "first" });
    await first.run({ type: "clear", sessionId });
    const next = new StoredMimiWorkMemory(dir);
    const result = await next.run({ type: "begin", sessionId, clientMessageId: "second" });
    expect(result.turn?.archiveSummary).toContain("cleared");
    expect(result.segments.at(-1)?.boundaryBeforeMessageId).toBe("second");
    const reopened = new StoredMimiWorkMemory(dir);
    expect(
      (await reopened.run({ type: "begin", sessionId, clientMessageId: "third" })).turn,
    ).toBeUndefined();
    await reopened.run({
      type: "delegation",
      sessionId,
      closure: { objective: "synthetic task", outcome: "completed" },
    });
    const snapshot = await reopened.run({ type: "snapshot" });
    expect(snapshot).not.toHaveProperty("entries");
    expect(JSON.parse(await readFile(join(dir, "work-memory.json"), "utf8")).entries).toHaveLength(
      1,
    );
    await expect(reopened.run({ type: "begin", sessionId: "other" })).rejects.toThrow(
      "session changed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
