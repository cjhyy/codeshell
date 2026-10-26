import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../core/src/session/session-manager.js";
import {
  SessionOutputJournal,
  readOutputJournal,
} from "../../../core/src/session/output-journal.js";
import { SessionOutputCoverageStore } from "../../../core/src/session/output-coverage-state.js";
import { recoverMobileOutput } from "./mobileOutputRecovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mobile-base-consumer-"));
  roots.push(root);
  const manager = new SessionManager(root),
    session = manager.create(root, "fixture", "fixture", "native");
  manager.startSessionRun(session.state, "run");
  const throughEventId = session.transcript.getEvents()[0].id;
  const writer = new SessionOutputJournal(root, "native", "run", throughEventId);
  const outputCursor = writer.append({ type: "turn_complete", reason: "completed" });
  const events = [
    { type: "session_started", sessionId: "native" },
    { type: "stream_request_start" },
    { type: "thinking_delta", text: "reason" },
    { type: "text_delta", text: "answer" },
    { type: "assistant_message" },
    {
      type: "tool_use_start",
      toolCall: { id: "tool", toolName: "Read", args: { path: "fixture" } },
    },
    { type: "tool_result", result: { id: "tool", result: "read", isError: false } },
  ];
  const reply = {
    type: "session.outputJournal",
    sessionId: "native",
    recoveryId: "r",
    requestId: "p",
    page: readOutputJournal(root, "native"),
    legacyBaseComplete: true,
    legacyBase: { throughEventId, events },
    snapshot: {
      ...new SessionOutputCoverageStore(() => root).read("native"),
      epoch: "main",
      nextSeq: 2,
      outputCursor,
      unpaired: false,
    },
  } as any;
  const pages = [
    {
      type: "session.legacyBase",
      sessionId: "native",
      recoveryId: "r",
      requestId: "b",
      ok: true,
      throughEventId,
      index: 0,
      events: events.slice(0, 3),
      complete: false,
      next: "cursor-1",
    },
    {
      type: "session.legacyBase",
      sessionId: "native",
      recoveryId: "r",
      requestId: "b",
      ok: true,
      throughEventId,
      index: 3,
      events: events.slice(3),
      complete: true,
    },
  ];
  return { reply, pages };
}
async function paged(
  f: ReturnType<typeof fixture>,
  readBase?: (options: any) => Promise<any>,
  canContinue = () => true,
) {
  return recoverMobileOutput({
    read: async () => ({
      ...f.reply,
      legacyBaseComplete: false,
      legacyBase: { ...f.reply.legacyBase, events: [] },
    }),
    readBase,
    canContinue,
    latestCursor: () => undefined,
  } as any);
}
test("paged base reduces incrementally to the same final chat as the inline base", async () => {
  const f = fixture();
  let index = 0;
  const inline = await recoverMobileOutput({
    read: async () => f.reply,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  const result = await paged(f, async (options) => {
    expect(options).toEqual(
      index === 0
        ? { throughEventId: f.reply.page.legacyBaseThroughEventId }
        : { cursor: "cursor-1" },
    );
    return f.pages[index++];
  });
  expect(index).toBe(2);
  expect(result).toEqual(inline);
});
for (const fault of [
  "oversize",
  "index-back",
  "index-skip",
  "cursor-repeat",
  "anchor",
  "missing-start",
  "later-start",
  "empty",
  "type",
  "event-schema",
  "complete-next",
  "unfinished-no-next",
  "nonboolean",
  "failure",
  "over40",
  "total-bytes",
  "session-id",
  "recovery-id",
  "request-id-type",
  "wrapper",
  "injected",
  "extra-tool-field",
] as const)
  test(`paged base rejects ${fault} before releasing a candidate`, async () => {
    const f = fixture();
    let calls = 0;
    await expect(
      paged(f, async () => {
        const index = calls++;
        const page: any = structuredClone(f.pages[Math.min(index, 1)]);
        if (fault === "session-id") page.sessionId = "other";
        else if (fault === "recovery-id") page.recoveryId = "other";
        else if (fault === "request-id-type") page.requestId = 1;
        else if (fault === "wrapper")
          Object.assign(page.events[0], {
            method: "agent/streamEvent",
            params: { sessionId: "other", event: { type: "user_message", text: "forged" } },
          });
        else if (fault === "injected")
          page.events[2] = { type: "user_message", text: "lost", injected: true };
        else if (fault === "extra-tool-field")
          page.events[2] = {
            type: "tool_use_start",
            toolCall: { id: "bad", toolName: "Bad", args: {}, summary: {} },
          };
        else if (fault === "oversize")
          page.events.push({ type: "text_delta", text: "汉".repeat(400_000) });
        else if (fault === "index-back" && index) page.index--;
        else if (fault === "index-skip" && index) page.index++;
        else if (fault === "cursor-repeat" && index) {
          page.complete = false;
          page.next = "cursor-1";
        } else if (fault === "anchor") page.throughEventId = "wrong";
        else if (fault === "missing-start")
          page.events[0] = { type: "text_delta", text: "missing" };
        else if (fault === "later-start" && index)
          page.events[0] = { type: "session_started", sessionId: "native" };
        else if (fault === "empty") page.events = [];
        else if (fault === "type") page.type = "session.outputJournal";
        else if (fault === "event-schema") page.events.push({ type: "tool_result", result: null });
        else if (fault === "complete-next" && index) page.next = "unexpected";
        else if (fault === "unfinished-no-next") delete page.next;
        else if (fault === "nonboolean") page.complete = "false";
        else if (fault === "failure") {
          page.ok = false;
          page.reason = "incomplete";
        } else if (fault === "over40" || fault === "total-bytes") {
          page.index = index * 2;
          page.complete = false;
          page.next = `cursor-${index + 1}`;
          page.events = [
            index
              ? { type: "stream_request_start" }
              : { type: "session_started", sessionId: "native" },
            { type: "text_delta", text: "x".repeat(fault === "total-bytes" ? 900_000 : 1) },
          ];
        }
        return page;
      }),
    ).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(40);
  });
test("a host without readBase retains the old incomplete failure and sends no new request", async () => {
  await expect(paged(fixture())).rejects.toThrow("base");
});
test("cancellation between base pages prevents the next read", async () => {
  const f = fixture();
  let current = true,
    reads = 0;
  await expect(
    paged(
      f,
      async () => {
        reads++;
        current = false;
        return f.pages[0];
      },
      () => current,
    ),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});
