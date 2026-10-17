import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexSessionsForCwds } from "../../../packages/coding/src/cc-orchestrator/codex-session-discovery.ts";
import { findCodexRolloutFile, readCodexRecentHistory } from "../../../packages/coding/src/cc-orchestrator/codex-session-history.ts";

function rollout(file: string, cwd: string, text: string) {
  writeFileSync(file, [
    { type: "session_meta", payload: { id: "thread-same", cwd } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
}

test("R2-02 list selects newest resumed rollout but history reader selects an older enumeration entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "cs-audit-rollout-"));
  try {
    const directory = join(home, "sessions", "2026", "10", "17");
    mkdirSync(directory, { recursive: true });
    const cwd = "/fixture/project";
    const a = join(directory, "rollout-a.jsonl");
    const b = join(directory, "rollout-b.jsonl");
    rollout(a, cwd, "A question"); rollout(b, cwd, "B question");
    // Observe the platform enumeration first, then freeze that entry as older.
    // This avoids relying on filesystem ordering to construct the fixture.
    const first = findCodexRolloutFile(home, cwd, "thread-same")!;
    expect([a, b]).toContain(first);
    const latest = first === a ? b : a;
    utimesSync(first, new Date("2026-10-16T00:00:00Z"), new Date("2026-10-16T00:00:00Z"));
    utimesSync(latest, new Date("2026-10-17T00:00:00Z"), new Date("2026-10-17T00:00:00Z"));
    const list = await listCodexSessionsForCwds([cwd], home);
    expect(list.total).toBe(1);
    expect(list.sessions[0].firstMessage).toBe(latest === a ? "A question" : "B question");
    const history = readCodexRecentHistory(cwd, "thread-same", 20, home);
    expect(history.messages[0].text).toBe(first === a ? "A question" : "B question");
    expect(history.messages[0].text).not.toBe(list.sessions[0].firstMessage);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("R2-02 one rollout keeps list and history consistent", async () => {
  const home = mkdtempSync(join(tmpdir(), "cs-audit-rollout-control-"));
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    rollout(join(home, "sessions", "rollout-only.jsonl"), "/fixture/project", "same question");
    const list = await listCodexSessionsForCwds(["/fixture/project"], home);
    const history = readCodexRecentHistory("/fixture/project", "thread-same", 20, home);
    expect(list.sessions[0].firstMessage).toBe(history.messages[0].text);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
