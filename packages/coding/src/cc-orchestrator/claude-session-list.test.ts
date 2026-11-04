import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRelatedClaudeSessions } from "./claude-session-list.js";
import { encodeCwd } from "./session-discovery.js";

test("worker preserves Claude history titles/counts while the host remains responsive", async () => {
  const home = mkdtempSync(join(tmpdir(), "claude-list-worker-"));
  const cwd = join(home, "project");
  const dir = join(home, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const user = JSON.stringify({ type: "user", cwd, message: { content: "Fixture request" } });
  const line = JSON.stringify({ type: "assistant", message: { content: "x".repeat(1024) } });
  writeFileSync(join(dir, "session.jsonl"), [user, ...Array(4000).fill(line), user].join("\n"));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const result = await listRelatedClaudeSessions(
      cwd,
      { limit: 20 },
      { claudeHome: home, bindings: [] },
    );
    expect(result.total).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "session",
      cwd,
      firstMessage: "Fixture request",
      messageCount: 2,
    });
    expect(ticks).toBeGreaterThan(0);
    expect(
      await listRelatedClaudeSessions(cwd, {}, { claudeHome: home, bindings: [] }, true),
    ).toEqual(result);
  } finally {
    clearInterval(timer);
    rmSync(home, { recursive: true, force: true });
  }
});
