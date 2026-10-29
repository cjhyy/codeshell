import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionOutputJournal, readOutputJournal } from "./output-journal.js";
import { SessionOutputCoverageStore } from "./output-coverage-state.js";
import { outputUserMessage } from "../engine/run-output-user-message.js";
import { OutputHistoryRecovery } from "./output-history-recovery.js";
import { outputJournalAnchorName } from "./output-journal-binding.js";
import { backupOutputJournal } from "./output-journal-manual-repair.js";
import type { StreamEvent } from "../types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "output-history-"));
  roots.push(root);
  const id = "historical-session",
    manager = new SessionManager(root);
  const bundle = manager.create(root, "fixture", "codex", id);
  const base = bundle.transcript.getEvents()[0]!.id;
  const user = bundle.transcript.appendMessage("user", "synthetic question", {
    clientMessageId: "input",
  });
  manager.startSessionRun(bundle.state, user.id);
  const writer = new SessionOutputJournal(root, id, user.id, base);
  const emit = (event: StreamEvent) => writer.append(event);
  emit(outputUserMessage(user.data, id, root));
  emit({ type: "session_started", sessionId: id, promptTokens: 0 });
  emit({ type: "text_delta", text: "answer" });
  bundle.transcript.appendMessage("assistant", "answer");
  emit({ type: "tool_use_start", toolCall: { id: "tool", toolName: "Read", args: {} } });
  emit({ type: "tool_use_args_delta", toolCallId: "tool", args: { path: "fixture" } });
  bundle.transcript.appendToolUse("Read", "tool", { path: "fixture" });
  bundle.transcript.appendMessage("assistant", [
    { type: "tool_use", id: "tool", name: "Read", input: { path: "fixture" } },
  ]);
  emit({
    type: "tool_result",
    result: { id: "tool", toolName: "Read", result: "synthetic result" },
  });
  bundle.transcript.appendToolResult("tool", "Read", "synthetic result");
  bundle.transcript.appendTurnBoundary();
  bundle.transcript.sync();
  const cursor = emit({ type: "turn_complete", reason: "completed" });
  manager.updateSessionState(id, { status: "completed" });
  new SessionOutputCoverageStore(() => root).record(id, { unpaired: true, inputIds: [] });
  const dir = join(root, id),
    statePath = join(dir, "state.json");
  const authority = { key: "owner-and-generation", assertCurrent() {} };
  return { root, dir, id, manager, bundle, writer, cursor, statePath, authority };
}
function ready(service: OutputHistoryRecovery, f: ReturnType<typeof fixture>) {
  const result = service.plan(f.id, f.authority);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.reason);
  return result;
}

test("explicit new epoch preserves original conversation/context/evidence and rejects old cursors", () => {
  const f = fixture();
  writeFileSync(
    join(f.dir, "external-runtime.json"),
    JSON.stringify({ kind: "codex", runtimeSessionId: "provider-context" }),
  );
  const oldState = readFileSync(f.statePath),
    oldJournal = readFileSync(join(f.dir, "output-journal.jsonl"));
  const oldTranscript = readFileSync(join(f.dir, "transcript.jsonl")),
    oldContext = readFileSync(join(f.dir, "external-runtime.json"));
  const service = new OutputHistoryRecovery(() => f.root),
    plan = ready(service, f);
  expect(plan.comparison).toEqual({ turns: 1, userInputs: 1, toolCalls: 1, toolResults: 1 });
  expect(
    service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, f.authority),
  ).toEqual({ status: "applied", sessionId: f.id, historicalGap: true });
  const next = f.manager.readSessionState(f.id)!;
  expect(next.outputCoverage?.unpaired).toBe(false);
  expect(next.outputHistoryRecovery?.historicalGap).toBe(true);
  expect(next.sessionId).toBe(f.id);
  expect(next.runId).toBe(JSON.parse(oldState.toString()).runId);
  expect(readFileSync(join(f.dir, "output-journal.jsonl")).equals(oldJournal)).toBe(true);
  expect(readFileSync(join(f.dir, "transcript.jsonl")).equals(oldTranscript)).toBe(true);
  expect(readFileSync(join(f.dir, "external-runtime.json")).equals(oldContext)).toBe(true);
  const archive = join(f.dir, ".output-history-recovery", next.outputHistoryRecovery!.recoveryId);
  expect(readFileSync(join(archive, "state.json")).equals(oldState)).toBe(true);
  expect(readFileSync(join(archive, "journal.jsonl")).equals(oldJournal)).toBe(true);
  expect(readOutputJournal(f.root, f.id, { after: f.cursor }).status).toBe("cursor_invalid");
  const page = readOutputJournal(f.root, f.id);
  expect(page).toMatchObject({ status: "ok", complete: true, historicalGap: true });
  expect(page.frames.map((frame) => frame.event?.type)).toEqual([
    "session_user_message",
    "session_started",
    "text_delta",
    "tool_use_start",
    "tool_use_args_delta",
    "tool_result",
    "turn_complete",
  ]);
  expect(() => f.writer.append({ type: "text_delta", text: "late old source" })).toThrow();
  const publisher = new SessionOutputJournal(f.root, f.id, { kind: "host", id: "fresh-host" });
  publisher.append({
    type: "background_agent_completed",
    agentId: "fresh",
    description: "new completion",
    status: "completed",
    enqueuedAt: 1,
  });
  expect(readOutputJournal(f.root, f.id)).toMatchObject({ status: "ok", historicalGap: true });
  // Ordinary whole-state saves cannot erase the accepted historical limitation.
  const resumed = f.manager.resume(f.id);
  delete resumed.state.outputHistoryRecovery;
  f.manager.saveState(resumed.state);
  expect(f.manager.readSessionState(f.id)?.outputHistoryRecovery?.historicalGap).toBe(true);
  expect(new SessionOutputCoverageStore(() => f.root).read(f.id)).toMatchObject({
    unpaired: false,
    historicalGap: true,
  });
  expect(() => backupOutputJournal(f.root, f.id, join(f.root, "backup"))).toThrow();
});

test.each(["owner", "revoked", "state", "transcript"] as const)(
  "plan cannot survive changed %s authority/evidence",
  (change) => {
    const f = fixture(),
      service = new OutputHistoryRecovery(() => f.root),
      plan = ready(service, f);
    const old = readFileSync(join(f.dir, "output-journal.jsonl"));
    let authority = f.authority;
    if (change === "owner") authority = { ...authority, key: "another-owner" };
    if (change === "revoked")
      authority = {
        ...authority,
        assertCurrent() {
          throw new Error("revoked");
        },
      };
    if (change === "state") f.manager.updateSessionState(f.id, { title: "changed after review" });
    if (change === "transcript")
      writeFileSync(
        join(f.dir, "transcript.jsonl"),
        readFileSync(join(f.dir, "transcript.jsonl"), "utf8").replace(
          "synthetic result",
          "modified result",
        ),
      );
    expect(
      service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, authority).status,
    ).not.toBe("applied");
    expect(readFileSync(join(f.dir, "output-journal.jsonl")).equals(old)).toBe(true);
    expect(f.manager.readSessionState(f.id)?.outputCoverage?.unpaired).toBe(true);
  },
);

test.each(["evidence-durable", "epoch-durable", "state-durable"] as const)(
  "interruption at %s never exposes a half-selected epoch",
  (phase) => {
    const f = fixture();
    let fail = true;
    const service = new OutputHistoryRecovery(() => f.root, {
      onCheckpoint(at) {
        if (fail && at === phase) throw new Error("synthetic interruption");
      },
    });
    const plan = ready(service, f),
      input = { planId: plan.planId, acceptHistoricalGap: true as const };
    const before = readFileSync(f.statePath);
    const result = service.apply(f.id, input, f.authority);
    if (phase === "state-durable") expect(result.status).toBe("applied");
    else {
      expect(result.status).toBe("blocked");
      expect(readFileSync(f.statePath).equals(before)).toBe(true);
      expect(f.manager.readSessionState(f.id)?.outputCoverage?.unpaired).toBe(true);
      fail = false;
      expect(service.apply(f.id, input, f.authority).status).toBe("applied");
    }
    expect(readOutputJournal(f.root, f.id)).toMatchObject({ status: "ok", historicalGap: true });
  },
);

test.each(["text", "args", "result", "tail", "hardlink", "unknown"] as const)(
  "refuses unproved %s before any epoch writes",
  (change) => {
    const f = fixture(),
      path = join(f.dir, "transcript.jsonl");
    if (change === "hardlink") linkSync(path, join(f.dir, "alias"));
    else {
      let text = readFileSync(path, "utf8");
      if (change === "text") text = text.replace('"answer"', '"altered"');
      if (change === "args") text = text.replace('"path":"fixture"', '"path":"other"');
      if (change === "result") text = text.replace("synthetic result", "altered result");
      if (change === "tail") text += '{"unfinished":';
      if (change === "unknown")
        text = text.replace('"type":"turn_boundary"', '"type":"unknown_history"');
      writeFileSync(path, text);
    }
    const service = new OutputHistoryRecovery(() => f.root);
    expect(service.plan(f.id, f.authority).status).toBe("blocked");
    expect(readdirSync(f.dir).some((name) => /^output-journal-[a-f0-9]{8}-/.test(name))).toBe(
      false,
    );
    expect(outputJournalAnchorName(f.manager.readSessionState(f.id)!.outputJournalBinding)).toBe(
      "output-journal.jsonl",
    );
  },
);

test("a stale active label does not override Host quiescence and a closed canonical history", () => {
  const f = fixture();
  f.manager.updateSessionState(f.id, { status: "active" });
  ready(new OutputHistoryRecovery(() => f.root), f);
});

test("a lost acknowledgement is idempotent after restart and under fresh authorization", () => {
  const f = fixture(),
    service = new OutputHistoryRecovery(() => f.root),
    plan = ready(service, f);
  const input = { planId: plan.planId, acceptHistoricalGap: true as const };
  expect(service.apply(f.id, input, f.authority).status).toBe("applied");
  const state = readFileSync(f.statePath);
  const restarted = new OutputHistoryRecovery(() => f.root);
  expect(
    restarted.apply(f.id, input, { ...f.authority, key: "fresh-authorized-owner" }).status,
  ).toBe("applied");
  expect(readFileSync(f.statePath).equals(state)).toBe(true);
  const damaged = JSON.parse(state.toString());
  damaged.outputHistoryRecovery.recoveryId = "00000000-0000-0000-0000-000000000000";
  writeFileSync(f.statePath, JSON.stringify(damaged));
  expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
});

test("a modified evidence copy cannot become an accepted checkpoint", () => {
  const f = fixture();
  const service = new OutputHistoryRecovery(() => f.root, {
    onCheckpoint(phase) {
      if (phase !== "epoch-durable") return;
      const evidence = join(f.dir, ".output-history-recovery");
      writeFileSync(
        join(evidence, readdirSync(evidence)[0]!, "transcript.jsonl"),
        "modified backup",
      );
    },
  });
  const plan = ready(service, f),
    before = readFileSync(f.statePath);
  expect(
    service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, f.authority),
  ).toMatchObject({ status: "blocked", reason: "storage_error" });
  expect(readFileSync(f.statePath).equals(before)).toBe(true);
});
