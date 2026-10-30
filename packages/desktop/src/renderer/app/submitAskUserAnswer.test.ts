import { afterEach, beforeEach, expect, test } from "bun:test";
import { ensureMiniDom } from "../test-utils/renderHook";
import { submitAskUserAnswer } from "./submitAskUserAnswer";

let savedBridge: PropertyDescriptor | undefined;
beforeEach(() => {
  ensureMiniDom();
  savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
});
afterEach(() => {
  if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
  else Reflect.deleteProperty(window, "codeshell");
});

for (const sessionId of ["origin-session", undefined]) {
  test(`answer submission retains the ${sessionId ? "origin session" : "legacy"} route`, async () => {
    const calls: unknown[][] = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        approve: async (...args: unknown[]) => {
          calls.push(args);
          return { result: { ok: true } };
        },
      },
    });
    expect(await submitAskUserAnswer(sessionId, "request", "answer", () => true)).toBe(true);
    expect(calls).toEqual([
      [...(sessionId ? [sessionId] : []), "request", "approve", undefined, "answer"],
    ]);
  });
}

test("a rejected RPC cannot report an accepted answer", async () => {
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: { approve: async () => ({ error: { message: "Confirmation already resolved" } }) },
  });
  await expect(submitAskUserAnswer("session", "request", "answer", () => true)).rejects.toThrow(
    "Confirmation already resolved",
  );
});

test("a retired submission cannot acknowledge a replacement UI after its response arrives", async () => {
  let complete!: (value: unknown) => void;
  let current = true;
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      approve: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  });
  const submission = submitAskUserAnswer("session", "request", "answer", () => current);
  current = false;
  complete({ error: { message: "Old session ended" } });
  expect(await submission).toBe(false);
});
