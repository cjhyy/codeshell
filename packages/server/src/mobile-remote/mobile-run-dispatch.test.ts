import { describe, expect, test } from "bun:test";
import { injectMobileRunAndAwaitAcceptance } from "./mobile-run-dispatch.js";

function fakeBridge(onInject: (line: string, emit: (line: string) => void) => void) {
  let listener: ((line: string) => void) | undefined;
  let unsubscribed = false;
  const injected: string[] = [];
  return {
    injected,
    get unsubscribed() {
      return unsubscribed;
    },
    bridge: {
      subscribeOutbound(next: (line: string) => void) {
        listener = next;
        return () => {
          unsubscribed = true;
          listener = undefined;
        };
      },
      injectWorkerMessage(line: string) {
        injected.push(line);
        onInject(line, (outbound) => listener?.(outbound));
      },
    },
  };
}

describe("injectMobileRunAndAwaitAcceptance", () => {
  test("resolves only after the worker accepts the matching request id", async () => {
    const fake = fakeBridge((line, emit) => {
      const request = JSON.parse(line);
      emit(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "agent/runAccepted",
          params: { requestId: "other-run", sessionId: "session-1" },
        }),
      );
      queueMicrotask(() =>
        emit(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/runAccepted",
            params: { requestId: request.id, sessionId: "session-1" },
          }),
        ),
      );
    });

    const result = await injectMobileRunAndAwaitAcceptance(fake.bridge, {
      id: "mobile-run-1",
      params: { task: "", sessionId: "session-1", attachments: [{ id: "image" }] },
    });

    expect(result).toEqual({ ok: true });
    expect(fake.injected).toHaveLength(1);
    expect(fake.unsubscribed).toBe(true);
  });

  test("returns the worker validation error instead of reporting chat.accepted", async () => {
    const fake = fakeBridge((line, emit) => {
      const request = JSON.parse(line);
      queueMicrotask(() =>
        emit(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: "task or a valid attachment is required" },
          }),
        ),
      );
    });

    await expect(
      injectMobileRunAndAwaitAcceptance(fake.bridge, {
        id: "mobile-run-2",
        params: { task: "", sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      message: "task or a valid attachment is required",
      code: -32602,
    });
  });
});
