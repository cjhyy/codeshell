import { describe, expect, test } from "bun:test";
import {
  initialDialogState,
  enqueue,
  resolveActive,
  type DialogRequest,
} from "./dialogState";

/** A confirm request whose resolver records what it was called with. */
function reqWith<T>(
  kind: DialogRequest["kind"],
  sink: (v: T) => void,
): DialogRequest {
  return {
    kind,
    options: { message: "m" },
    resolve: sink as (v: unknown) => void,
  } as DialogRequest;
}

describe("dialogState reducer", () => {
  test("enqueue surfaces the first request as active", () => {
    let s = initialDialogState();
    expect(s.active).toBeNull();
    s = enqueue(s, reqWith("confirm", () => {}));
    expect(s.active?.kind).toBe("confirm");
    expect(s.queue).toHaveLength(0);
  });

  test("a second enqueue waits in the queue (one dialog at a time)", () => {
    let s = initialDialogState();
    s = enqueue(s, reqWith("confirm", () => {}));
    s = enqueue(s, reqWith("alert", () => {}));
    expect(s.active?.kind).toBe("confirm");
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]!.kind).toBe("alert");
  });

  test("resolveActive calls the active resolver and promotes the next", () => {
    const got: unknown[] = [];
    let s = initialDialogState();
    s = enqueue(s, reqWith("confirm", (v) => got.push(["confirm", v])));
    s = enqueue(s, reqWith("alert", (v) => got.push(["alert", v])));
    s = resolveActive(s, true); // confirm → true
    expect(got).toEqual([["confirm", true]]);
    expect(s.active?.kind).toBe("alert"); // next promoted
    expect(s.queue).toHaveLength(0);
  });

  test("resolving the last request leaves no active dialog", () => {
    const got: unknown[] = [];
    let s = initialDialogState();
    s = enqueue(s, reqWith("prompt", (v) => got.push(v)));
    s = resolveActive(s, "typed value");
    expect(got).toEqual(["typed value"]);
    expect(s.active).toBeNull();
  });

  test("prompt cancel resolves null", () => {
    const got: unknown[] = [];
    let s = initialDialogState();
    s = enqueue(s, reqWith("prompt", (v) => got.push(v)));
    s = resolveActive(s, null);
    expect(got).toEqual([null]);
  });

  test("resolveActive on an empty state is a no-op", () => {
    const s = resolveActive(initialDialogState(), true);
    expect(s.active).toBeNull();
    expect(s.queue).toHaveLength(0);
  });
});
