import { describe, expect, test } from "bun:test";
import { HostActionHandlers } from "./host-action-dispatch.js";
import type { ParsedHostAction } from "./browser-driver/intercept.js";

const parsed = (overrides: Partial<ParsedHostAction> = {}): ParsedHostAction => ({
  sessionId: "s1",
  requestId: "rq1",
  action: "notice.create",
  args: { title: "x" },
  ...overrides,
});

describe("HostActionHandlers", () => {
  test("dispatches to the registered handler with sessionId and args", async () => {
    const handlers = new HostActionHandlers();
    const calls: unknown[] = [];
    handlers.set("notice.create", async (sessionId, args) => {
      calls.push({ sessionId, args });
      return { ok: true, id: "rule-1" };
    });
    expect(JSON.parse(await handlers.dispatch(parsed()))).toEqual({ ok: true, id: "rule-1" });
    expect(calls).toEqual([{ sessionId: "s1", args: { title: "x" } }]);
  });

  test("replies ok:false for an unknown action", async () => {
    const handlers = new HostActionHandlers();
    expect(JSON.parse(await handlers.dispatch(parsed({ action: "nope" })))).toEqual({
      ok: false,
      error: "unknown host action: nope",
    });
  });

  test("replies ok:false with the thrown message when the handler fails", async () => {
    const handlers = new HostActionHandlers();
    handlers.set("notice.create", async () => {
      throw new Error("disk full");
    });
    expect(JSON.parse(await handlers.dispatch(parsed()))).toEqual({
      ok: false,
      error: "disk full",
    });
  });

  test("requires a sessionId before calling any handler", async () => {
    const handlers = new HostActionHandlers();
    let called = false;
    handlers.set("notice.create", async () => {
      called = true;
      return {};
    });
    expect(JSON.parse(await handlers.dispatch(parsed({ sessionId: undefined })))).toEqual({
      ok: false,
      error: "host action requires sessionId",
    });
    expect(called).toBe(false);
  });

  test("unregister removes only its own registration", async () => {
    const handlers = new HostActionHandlers();
    const first = handlers.set("notice.create", async () => ({ ok: true, by: "first" }));
    const second = handlers.set("notice.create", async () => ({ ok: true, by: "second" }));
    first();
    expect(JSON.parse(await handlers.dispatch(parsed()))).toEqual({ ok: true, by: "second" });
    second();
    expect(JSON.parse(await handlers.dispatch(parsed()))).toEqual({
      ok: false,
      error: "unknown host action: notice.create",
    });
  });

  test("always produces a JSON answer, even for an unserializable result", async () => {
    const handlers = new HostActionHandlers();
    handlers.set("undef", async () => undefined);
    handlers.set("bigint", async () => ({ n: 1n }));
    expect(JSON.parse(await handlers.dispatch(parsed({ action: "undef" })))).toBeNull();
    const failed = JSON.parse(await handlers.dispatch(parsed({ action: "bigint" })));
    expect(failed.ok).toBe(false);
    expect(typeof failed.error).toBe("string");
  });
});

const hostLine = (args: unknown, requestId: unknown = "rq9") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: {
      sessionId: "s9",
      requestId,
      connectionId: "c9",
      generation: 4,
      request: { toolName: "__host_action__", args },
    },
  });

describe("HostActionHandlers.intercept", () => {
  test("consumes a valid request and replies with the handler result", async () => {
    const handlers = new HostActionHandlers();
    handlers.set("notice.create", async () => ({ ok: true, id: "r" }));
    const sent: string[] = [];
    const consumed = handlers.intercept(
      hostLine({ action: "notice.create", args: {} }),
      (line) => sent.push(line),
      () => {},
    );
    expect(consumed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]);
    expect(reply.method).toBe("agent/approve");
    expect(reply.params).toEqual({
      connectionId: "c9",
      generation: 4,
      sessionId: "s9",
      requestId: "rq9",
      decision: { approved: true, answer: '{"ok":true,"id":"r"}' },
    });
  });

  test.each([
    ["null args", { action: "notice.create", args: null }],
    ["array args", { action: "notice.create", args: [1] }],
    ["missing action", { args: {} }],
    ["no args object", null],
  ])("consumes and answers a malformed request (%s)", (_name, args) => {
    const handlers = new HostActionHandlers();
    let called = false;
    handlers.set("notice.create", async () => {
      called = true;
      return {};
    });
    const sent: string[] = [];
    expect(
      handlers.intercept(
        hostLine(args),
        (line) => sent.push(line),
        () => {},
      ),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]);
    expect(reply.params).toMatchObject({
      connectionId: "c9",
      generation: 4,
      sessionId: "s9",
      requestId: "rq9",
    });
    expect(JSON.parse(reply.params.decision.answer)).toEqual({
      ok: false,
      error: "malformed host action request",
    });
    expect(called).toBe(false);
  });

  test("leaves lines that are not host-action requests alone", () => {
    const handlers = new HostActionHandlers();
    const sent: string[] = [];
    const other = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/approvalRequest",
      params: { sessionId: "s9", requestId: "rq9", request: { toolName: "Bash", args: {} } },
    });
    for (const line of [other, hostLine({ action: "a", args: {} }, 7), "not json"]) {
      expect(
        handlers.intercept(
          line,
          (l) => sent.push(l),
          () => {},
        ),
      ).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  test("logs instead of leaking a rejection when sending the reply fails", async () => {
    const handlers = new HostActionHandlers();
    handlers.set("notice.create", async () => ({ ok: true }));
    const logged: unknown[] = [];
    handlers.intercept(
      hostLine({ action: "notice.create", args: {} }),
      () => {
        throw new Error("worker gone");
      },
      (error) => logged.push(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(logged[0])).toContain("worker gone");
  });
});
