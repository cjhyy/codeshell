import { describe, expect, test } from "bun:test";
import { injectMobileRunAndAwaitAcceptance } from "./mobile-run-dispatch.js";

function fakeBridge(onInject: (line: string, emit: (line: string) => void) => void) {
  let listener: ((line: string) => void) | undefined;
  let unsubscribed = false;
  const injected: string[] = [];
  const metas: unknown[] = [];
  return {
    injected,
    metas,
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
      injectWorkerMessage(line: string, meta: unknown) {
        injected.push(line);
        metas.push(meta);
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

    const result = await injectMobileRunAndAwaitAcceptance(
      fake.bridge,
      {
        id: "mobile-run-1",
        params: { task: "", sessionId: "session-1", attachments: [{ id: "image" }] },
      },
      { origin: "mobile", producer: "mobile-chat" },
    );

    expect(result).toEqual({ ok: true });
    expect(fake.injected).toHaveLength(1);
    expect(fake.metas).toEqual([{ origin: "mobile", producer: "mobile-chat" }]);
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
      injectMobileRunAndAwaitAcceptance(
        fake.bridge,
        {
          id: "mobile-run-2",
          params: { task: "", sessionId: "session-1" },
        },
        { origin: "mobile", producer: "mobile-chat" },
      ),
    ).resolves.toEqual({
      ok: false,
      message: "task or a valid attachment is required",
      code: -32602,
    });
  });

  test("an injected run with a delayed acknowledgement is uncertain, never rejected", async () => {
    let acknowledge!: () => void;
    const fake = fakeBridge((line, emit) => {
      const request = JSON.parse(line);
      acknowledge = () =>
        emit(JSON.stringify({ method: "agent/runAccepted", params: { requestId: request.id } }));
    });
    const result = await injectMobileRunAndAwaitAcceptance(
      fake.bridge,
      { id: "slow-run", params: { task: "run once", clientMessageId: "same-intent" } },
      { origin: "mobile", producer: "mobile-chat" },
      10,
    );
    expect(result).toEqual({
      ok: false,
      uncertain: true,
      message: "worker did not acknowledge the run",
    });
    expect(fake.injected).toHaveLength(1);
    expect(fake.unsubscribed).toBe(true);
    // The worker can still accept this input; the expired listener cannot
    // convert the already returned uncertainty into rejection or acceptance.
    acknowledge();
    expect(result).toHaveProperty("uncertain", true);
    expect(fake.injected).toHaveLength(1);
  });

  test("an injection failure may have queued input, while invalid JSON was never sent", async () => {
    const fake = fakeBridge(() => {
      throw new Error("transport failed after writing");
    });
    const result = await injectMobileRunAndAwaitAcceptance(
      fake.bridge,
      { id: "failed-write", params: { task: "run once" } },
      { origin: "mobile", producer: "mobile-chat" },
    );
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(fake.injected).toHaveLength(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalid = fakeBridge(() => {});
    const notSent = await injectMobileRunAndAwaitAcceptance(
      invalid.bridge,
      { id: "invalid", params: circular },
      { origin: "mobile", producer: "mobile-chat" },
    );
    expect(notSent.ok).toBe(false);
    expect(notSent).not.toHaveProperty("uncertain");
    expect(invalid.injected).toHaveLength(0);
    expect(invalid.unsubscribed).toBe(true);
  });
});
