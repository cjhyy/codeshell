import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom } from "../test-utils/renderHook";
import { NativeOutputHistoryRecovery } from "./NativeOutputHistoryRecovery";

let original: PropertyDescriptor | undefined;
afterEach(() => {
  if (original) Object.defineProperty(window, "codeshell", original);
  else Reflect.deleteProperty(window, "codeshell");
});

test("native adapter exposes held inputs without authorizing resend until complete hydration", () => {
  ensureMiniDom();
  original = Object.getOwnPropertyDescriptor(window, "codeshell");
  let calls = 0;
  const unavailable = async () => {
    calls++;
    throw new Error("render cannot invoke Host");
  };
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      getSessionOutputRecoveryPlan: unavailable,
      applySessionOutputRecovery: unavailable,
    },
  });
  const base = {
    sessionId: "owned-session",
    identity: "owned-workspace/session",
    failed: true,
    historicalGap: false,
    disabled: false,
    pending: true,
    heldInputs: [
      {
        id: "held",
        clientMessageId: "held-client",
        text: "retained text",
        attachments: [{ kind: "file", path: "owned-fixture.txt" }],
      },
    ] as any,
    beforeApply() {},
    onApplied() {},
    onReload() {},
    onConfirmHeld() {},
  };
  const blocked = renderToStaticMarkup(<NativeOutputHistoryRecovery {...base} />);
  expect(blocked).toContain("retained text");
  expect(blocked).toContain('disabled=""');
  const ready = renderToStaticMarkup(
    <NativeOutputHistoryRecovery {...base} failed={false} pending={false} historicalGap />,
  );
  expect(ready).toContain("retained text");
  expect(ready).not.toContain('disabled=""');
  expect(ready).toContain("历史");
  expect(calls).toBe(0);
  // A legacy Host still displays held input; no unimplemented RPC is guessed.
  Object.defineProperty(window, "codeshell", { configurable: true, value: {} });
  const legacy = renderToStaticMarkup(<NativeOutputHistoryRecovery {...base} />);
  expect(legacy).toContain("retained text");
  expect(calls).toBe(0);
});
