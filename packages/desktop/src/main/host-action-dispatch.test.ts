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
