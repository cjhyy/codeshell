import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecentExternalSession } from "@cjhyy/code-shell-capability-coding/orchestration";
import { parseCodexTranscriptLine, parseClaudeTranscriptLine } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { DesktopPetSession } from "./pet-state-aggregator";
import { ExternalSessionAdapter, type ExternalPetSessionSink } from "./external-session-adapter";

/** A codex response_item rollout line (tool / message). */
function codexLine(payload: unknown): string {
  return JSON.stringify({ type: "response_item", payload }) + "\n";
}
/** The codex turn-complete line shape parseCodexTranscriptLine recognizes. */
function codexTaskComplete(): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n";
}

function recordingSink(): ExternalPetSessionSink & { upserts: DesktopPetSession[]; removals: string[] } {
  const upserts: DesktopPetSession[] = [];
  const removals: string[] = [];
  return {
    upserts,
    removals,
    upsertExternalSession: (session) => upserts.push(session),
    removeExternalSession: (id) => removals.push(id),
  };
}

function makeRollout(dir: string, name: string, threadId: string, cwd: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd } }) + "\n");
  return file;
}

describe("ExternalSessionAdapter", () => {
  test("scan publishes discovered sessions; appended tool line flips phase to tool", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-a.jsonl", "thread-a", "/tmp/proj-a");
    let now = 10_000;
    const meta: RecentExternalSession = {
      sessionId: "thread-a", cwd: "/tmp/proj-a", file, lastModified: now, firstMessage: "fix login",
    };
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => [meta], scanIntervalMs: 0, now: () => now,
    });
    await adapter.scanOnce();
    expect(sink.upserts.at(-1)).toMatchObject({
      agentSessionId: "thread-a", title: "fix login", workspaceDisplayName: "proj-a",
      runState: "running", external: { cli: "codex", cwd: "/tmp/proj-a" },
      freshness: { source: "external-tail" },
    });

    appendFileSync(file, codexLine({ type: "function_call", name: "shell", arguments: "{}" }));
    now = 11_000;
    adapter.pollOnce();
    expect(sink.upserts.at(-1)).toMatchObject({ agentSessionId: "thread-a", runState: "running", phase: "tool" });

    const count = sink.upserts.length;
    adapter.pollOnce();
    expect(sink.upserts.length).toBe(count); // 无变化不重复推送
    adapter.stop();
  });

  test("task_complete flips to idle; quiet decay flips a stuck running session to idle", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-b.jsonl", "thread-b", "/tmp/proj-b");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => [{ sessionId: "thread-b", cwd: "/tmp/proj-b", file, lastModified: now, firstMessage: "" }],
      scanIntervalMs: 0, quietMs: 90_000, now: () => now,
    });
    await adapter.scanOnce();
    appendFileSync(file, codexLine({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }));
    adapter.pollOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("running");
    appendFileSync(file, codexTaskComplete());
    adapter.pollOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("idle");
    adapter.stop();
  });

  test("running session with no new events decays to idle after quietMs", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-d.jsonl", "thread-d", "/tmp/proj-d");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => [{ sessionId: "thread-d", cwd: "/tmp/proj-d", file, lastModified: now, firstMessage: "" }],
      scanIntervalMs: 0, quietMs: 90_000, now: () => now,
    });
    await adapter.scanOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("running"); // seeded running (fresh mtime)
    now = 200_000;
    adapter.pollOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("idle");
    adapter.stop();
  });

  test("sessions leaving the discovery window are removed and unwatched", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-c.jsonl", "thread-c", "/tmp/proj-c");
    const metas: RecentExternalSession[] = [
      { sessionId: "thread-c", cwd: "/tmp/proj-c", file, lastModified: 10_000, firstMessage: "" },
    ];
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => metas, scanIntervalMs: 0, now: () => 10_000,
    });
    await adapter.scanOnce();
    metas.length = 0;
    await adapter.scanOnce();
    expect(sink.removals).toEqual(["thread-c"]);
    adapter.stop();
  });

  test("claude cli dispatch: tool_use flips phase to tool with claude tag", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    const dir = join(home, "proj");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess-x.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", cwd: "/tmp/proj-x", message: { role: "user", content: "hi" } }) + "\n");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "claude", parseLine: parseClaudeTranscriptLine, sink,
      discover: () => [{ sessionId: "sess-x", cwd: "/tmp/proj-x", file, lastModified: now, firstMessage: "hi" }],
      scanIntervalMs: 0, now: () => now,
    });
    await adapter.scanOnce();
    expect(sink.upserts.at(-1)).toMatchObject({ agentSessionId: "sess-x", external: { cli: "claude" } });
    appendFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n");
    now = 11_000;
    adapter.pollOnce();
    expect(sink.upserts.at(-1)).toMatchObject({ agentSessionId: "sess-x", phase: "tool" });
    adapter.stop();
  });

  test("a multibyte UTF-8 char split across two drains is not corrupted", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-utf8.jsonl", "thread-utf8", "/tmp/proj-utf8");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => [{ sessionId: "thread-utf8", cwd: "/tmp/proj-utf8", file, lastModified: now, firstMessage: "" }],
      scanIntervalMs: 0, now: () => now,
    });
    await adapter.scanOnce();

    // Full message line whose text contains multibyte (CJK) characters.
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "处理中文" }] },
    }) + "\n";
    const bytes = Buffer.from(line, "utf-8");
    // Split the byte stream mid-multibyte-char: cut inside the first CJK char's
    // 3-byte sequence (the JSON prefix is ASCII, so an offset past it but before
    // a char boundary lands mid-char). Chunk 1 has no newline.
    const cut = bytes.indexOf(Buffer.from("处", "utf-8")) + 1;
    appendFileSync(file, bytes.subarray(0, cut));
    now = 11_000;
    adapter.pollOnce();
    // No complete line yet: nothing parsed, no corrupted upsert.
    expect(JSON.stringify(sink.upserts.at(-1))).not.toContain("�");

    appendFileSync(file, bytes.subarray(cut));
    now = 12_000;
    adapter.pollOnce();
    // The assistant message reduced correctly; projection carries no U+FFFD.
    expect(sink.upserts.at(-1)!.runState).toBe("running");
    expect(sink.upserts.at(-1)!.phase).toBe("model");
    expect(JSON.stringify(sink.upserts.at(-1))).not.toContain("�");
    adapter.stop();
  });

  test("a >64KB line is parsed whole with correct offset and no duplicate push", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-big.jsonl", "thread-big", "/tmp/proj-big");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex", parseLine: parseCodexTranscriptLine, sink,
      discover: () => [{ sessionId: "thread-big", cwd: "/tmp/proj-big", file, lastModified: now, firstMessage: "" }],
      scanIntervalMs: 0, now: () => now,
    });
    await adapter.scanOnce();

    const bigArg = JSON.stringify({ cmd: "x".repeat(100_000) });
    appendFileSync(file, codexLine({ type: "function_call", name: "shell", arguments: bigArg }));
    now = 11_000;
    adapter.pollOnce();
    // The whole large line parsed → tool phase (would be missing if the read
    // short-changed the buffer or left half a line as carry).
    expect(sink.upserts.at(-1)).toMatchObject({ agentSessionId: "thread-big", phase: "tool" });

    const count = sink.upserts.length;
    adapter.pollOnce();
    // Offset advanced fully; nothing re-parsed, so no repeat push.
    expect(sink.upserts.length).toBe(count);
    adapter.stop();
  });
});
