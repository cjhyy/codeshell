import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRunHistory, listRunHistory, listRunsForUi } from "./run-history-service";
import { deleteRunDir, listRuns } from "./runs-service";

describe("Session execution history", () => {
  let root: string;
  let options: { sessionsDir: string; runsDir: string };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-run-history-"));
    options = { sessionsDir: path.join(root, "sessions"), runsDir: path.join(root, "runs") };
    fs.mkdirSync(options.sessionsDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function event(id: string, type: string, timestamp: number, data: Record<string, unknown>) {
    return { id, type, timestamp, turnNumber: 1, data };
  }
  function receipt(sessionId: string, id: string, reason = "completed", timestamp = 20) {
    return event(id, "run_result", timestamp, {
      clientMessageId: `client-${id}`,
      result: {
        sessionId,
        reason,
        text: reason === "completed" ? "actual answer" : "",
        turnCount: 1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
  }
  function seed(sessionId: string, events: unknown[], state: Record<string, unknown> = {}) {
    const dir = path.join(options.sessionsDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        sessionId,
        cwd: "/workspace",
        status: "active",
        origin: "desktop",
        kind: "work",
        ...state,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "transcript.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return dir;
  }

  it("reads distinct executions and exact result details without mutating session state", async () => {
    const first = receipt("s-1", "receipt-1");
    const second = receipt("s-1", "receipt-2", "model_error", 40);
    const dir = seed(
      "s-1",
      [
        event("message-1", "message", 10, {
          role: "user",
          content: "model prompt",
          displayText: "visible objective",
          clientMessageId: first.data.clientMessageId,
        }),
        event("tool-1", "tool_use", 15, { toolName: "Read", args: { file: "/workspace/file" } }),
        first,
        event("message-2", "message", 30, {
          role: "user",
          content: "second objective",
          clientMessageId: second.data.clientMessageId,
        }),
        second,
      ],
      { status: "active" },
    );
    const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    const list = await listRunHistory(options);
    expect(list.map((row) => row.runId)).toEqual([
      "session:s-1:receipt-2",
      "session:s-1:receipt-1",
    ]);
    expect(list.map((row) => row.status)).toEqual(["failed", "completed"]);
    const detail = await getRunHistory("session:s-1:receipt-1", options);
    expect(detail).toMatchObject({
      objective: "visible objective",
      startedAt: 10,
      finishedAt: 20,
      summary: "actual answer",
    });
    expect(detail?.events.map((item) => item.eventId)).toEqual([
      "message-1",
      "tool-1",
      "receipt-1",
    ]);
    expect(detail?.metadata).toMatchObject({
      historySource: "session_receipt",
      terminalReason: "completed",
    });
    expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(before);
  });

  it("does not invent executions for drafts, active snapshots, or completed legacy state", async () => {
    seed("draft", [event("user", "message", 1, { role: "user", content: "unsent task" })]);
    seed("completed-state", [], { status: "completed", turnCount: 10 });
    seed("paused-state", [], { status: "paused" });
    expect(await listRunHistory(options)).toEqual([]);
    expect(await getRunHistory("session:draft:user", options)).toBeNull();
  });

  it("excludes internal, ephemeral and copied foreign-session results", async () => {
    for (const [sid, state] of Object.entries({
      child: { parentSessionId: "parent" },
      pet: { kind: "pet" },
      ephemeral: { ephemeral: true },
      childOrigin: { origin: "subagent" },
      "qchat-old": {},
      "panel-task-hidden": {},
      ".pending-fork-hidden": {},
      "pet-old": { kind: undefined },
    }))
      seed(sid, [receipt(sid, "receipt")], state);
    seed("fork", [receipt("original", "copied-receipt")]);
    expect(await listRunHistory(options)).toEqual([]);
    expect(await getRunHistory("session:child:receipt", options)).toBeNull();
  });

  it("preserves terminal reasons and deduplicates duplicate client receipts", async () => {
    const duplicate = receipt("work", "duplicate", "completed", 99);
    duplicate.data.clientMessageId = "client-cancelled";
    seed("work", [
      receipt("work", "cancelled", "aborted_streaming"),
      receipt("work", "blocked", "max_turns"),
      receipt("work", "unknown", "future_reason"),
      duplicate,
    ]);
    expect((await listRunHistory(options)).map((run) => run.status).sort()).toEqual([
      "blocked",
      "completed",
      "unknown",
    ]);
    seed("cancelled", [receipt("cancelled", "cancelled", "aborted_tools")]);
    expect((await getRunHistory("session:cancelled:cancelled", options))?.status).toBe("cancelled");
  });

  it("keeps legacy RunStore listing, detail and deletion semantics separate", async () => {
    seed("linked", [receipt("linked", "receipt")]);
    seed("ordinary", [receipt("ordinary", "receipt")]);
    const legacyDir = path.join(options.runsDir, "legacy");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "run.json"),
      JSON.stringify({
        runId: "legacy",
        sessionId: "linked",
        objective: "managed run",
        status: "running",
        updatedAt: 50,
      }),
    );
    expect((await listRunHistory(options)).map((run) => run.runId)).toEqual([
      "legacy",
      "session:ordinary:receipt",
    ]);
    expect((await getRunHistory("legacy", options))?.objective).toBe("managed run");
    expect((await listRuns(options.runsDir)).map((run) => run.runId)).toEqual(["legacy"]);
    expect((await listRunsForUi(undefined, options)).map((run) => run.runId)).toEqual(["legacy"]);
    expect(
      (await listRunsForUi({ includeSessions: false }, options)).map((run) => run.runId),
    ).toEqual(["legacy"]);
    expect(
      (await listRunsForUi({ includeSessions: true }, options)).map((run) => run.runId),
    ).toEqual(["legacy", "session:ordinary:receipt"]);
    await expect(deleteRunDir("session:ordinary:receipt", options.runsDir)).rejects.toThrow();
    expect(fs.existsSync(path.join(options.sessionsDir, "ordinary"))).toBe(true);
  });

  it("includes legacy top-level sessions whose parent marker is an empty string", async () => {
    seed("legacy-top-level", [receipt("legacy-top-level", "receipt")], { parentSessionId: "" });
    expect((await listRunHistory(options)).map((run) => run.runId)).toEqual([
      "session:legacy-top-level:receipt",
    ]);
  });

  it("isolates malformed data and reads recent receipts beyond oversized transcript prefixes", async () => {
    const dir = seed("large", []);
    fs.writeFileSync(
      path.join(dir, "transcript.jsonl"),
      "x".repeat(17 * 1024 * 1024) + "\n{torn\n" + JSON.stringify(receipt("large", "valid")) + "\n",
    );
    seed("corrupt", []);
    fs.writeFileSync(path.join(options.sessionsDir, "corrupt", "state.json"), "{torn");
    const invalid = receipt("invalid", "invalid");
    invalid.data.result.usage.totalTokens = NaN;
    seed("invalid", [invalid]);
    expect((await listRunHistory(options)).map((run) => run.runId)).toEqual([
      "session:large:valid",
    ]);
    const detail = await getRunHistory("session:large:valid", options);
    expect(detail?.startedAt).toBeNull();
    expect(detail?.objective).toBe("");
    expect(detail?.events.map((event) => event.eventId)).toEqual(["valid"]);
  });

  it("rejects traversal addresses and ignores symlinked history files", async () => {
    for (const id of ["session:../outside:e", "session:ok:../e", "session:ok:e:extra"]) {
      await expect(getRunHistory(id, options)).rejects.toThrow();
    }
    if (process.platform === "win32") return;
    const outside = seed("outside", [receipt("outside", "receipt")]);
    fs.symlinkSync(outside, path.join(options.sessionsDir, "linked-dir"));
    const linked = seed("linked-file", []);
    fs.rmSync(path.join(linked, "transcript.jsonl"));
    fs.symlinkSync(path.join(outside, "transcript.jsonl"), path.join(linked, "transcript.jsonl"));
    expect((await listRunHistory(options)).map((run) => run.runId)).toEqual([
      "session:outside:receipt",
    ]);
    expect(await getRunHistory("session:linked-dir:receipt", options)).toBeNull();
  });
});
