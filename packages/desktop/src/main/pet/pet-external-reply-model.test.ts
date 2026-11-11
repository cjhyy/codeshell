import { describe, expect, test } from "bun:test";
import { createPetExternalReplyModel } from "./pet-external-reply-model.js";
import type {
  ExternalRuntimeService,
  ExternalRuntimeStartRequest,
  DesktopExternalRuntimeTurnInput,
} from "../external-runtime-service.js";
import type { ExternalRuntimeTurnOutcome } from "../external-runtime-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(options: { ensureGate?: Promise<void>; ensureFailure?: string } = {}) {
  const starts: ExternalRuntimeStartRequest[] = [];
  const sends: Array<{ sessionId: string; input: DesktopExternalRuntimeTurnInput }> = [];
  const stops: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<ExternalRuntimeTurnOutcome>>>();
  const started = deferred<void>();
  const sent = deferred<void>();
  const service = {
    ensure: async (request: ExternalRuntimeStartRequest) => {
      starts.push(request);
      started.resolve();
      await options.ensureGate;
      request.assertStartAuthority?.();
      if (options.ensureFailure) throw new Error(options.ensureFailure);
      return {};
    },
    send: (sessionId: string, input: DesktopExternalRuntimeTurnInput) => {
      sends.push({ sessionId, input });
      const outcome = deferred<ExternalRuntimeTurnOutcome>();
      pending.set(sessionId, outcome);
      sent.resolve();
      return outcome.promise;
    },
    stop: async (sessionId: string) => {
      stops.push(sessionId);
    },
  } as unknown as Pick<ExternalRuntimeService, "ensure" | "send" | "stop">;
  const model = createPetExternalReplyModel({ service: () => service, cwd: "/host/no-repo" });
  return { model, starts, sends, stops, pending, started: started.promise, sent: sent.promise };
}

const REQUEST = {
  systemPrompt: "Return only a strict interpretation JSON object.",
  user: '{"message":"允许","items":[]}',
};

describe("isolated external notice reply interpreter", () => {
  test.each(["codex/gpt-6.1-sol", "claude-code/sonnet"])(
    "%s uses an independent hidden, tool-free runtime and always closes it",
    async (key) => {
      const f = harness();
      const result = f.model(key, { ...REQUEST, signal: new AbortController().signal });
      await f.sent;
      const start = f.starts[0]!;
      expect(start.sessionId).toMatch(/^pet-reply-[a-f0-9-]{36}$/);
      expect(start.modelKey).toBe(key);
      expect(start.cwd).toBe("/host/no-repo");
      expect(start.ownerWindow).toBeUndefined();
      expect(start.toolProfile).toMatchObject({
        catalog: [],
        instructions: REQUEST.systemPrompt,
        readOnly: true,
        disableMemory: true,
        sessionKind: "pet",
      });
      expect(start.toolProfile!.services()).toEqual({});
      expect(f.sends[0]).toEqual({
        sessionId: start.sessionId,
        input: {
          text: REQUEST.user,
          injected: true,
          disableGoal: true,
          modelTraceSource: "pet-notice-reply-external",
        },
      });
      f.pending
        .get(start.sessionId)!
        .resolve({ ok: true, reason: "completed", text: '{"kind":"unrelated"}' });
      expect(await result).toBe('{"kind":"unrelated"}');
      expect(f.stops).toEqual([start.sessionId]);
    },
  );

  test("an already aborted request never starts or stops a runtime", async () => {
    const f = harness();
    const controller = new AbortController();
    controller.abort(new Error("Already expired"));
    await expect(
      f.model("codex/gpt-6.1-sol", { ...REQUEST, signal: controller.signal }),
    ).rejects.toThrow("Already expired");
    expect(f.starts).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(f.stops).toEqual([]);
  });

  test("abort during startup closes only its own Session and never sends a model request", async () => {
    const gate = deferred<void>();
    const f = harness({ ensureGate: gate.promise });
    const controller = new AbortController();
    const result = f.model("codex/gpt-6.1-sol", { ...REQUEST, signal: controller.signal });
    await f.started;
    controller.abort(new Error("Startup expired"));
    await expect(result).rejects.toThrow("Startup expired");
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.sends).toEqual([]);
    expect(f.stops).toEqual([f.starts[0]!.sessionId]);
  });

  test("concurrent interpretations use different Sessions and cancellation cannot affect a successor", async () => {
    const f = harness();
    const firstSignal = new AbortController();
    const first = f.model("codex/gpt-6.1-sol", { ...REQUEST, signal: firstSignal.signal });
    const second = f.model("claude-code/sonnet", {
      ...REQUEST,
      signal: new AbortController().signal,
    });
    await f.sent;
    await Promise.resolve();
    expect(f.sends).toHaveLength(2);
    const [a, b] = f.sends;
    expect(a!.sessionId).not.toBe(b!.sessionId);
    firstSignal.abort(new Error("First interpretation expired"));
    await expect(first).rejects.toThrow("First interpretation expired");
    expect(f.stops).toEqual([a!.sessionId]);
    f.pending
      .get(b!.sessionId)!
      .resolve({ ok: true, reason: "completed", text: '{"kind":"unrelated"}' });
    expect(await second).toBe('{"kind":"unrelated"}');
    expect(f.stops).toEqual([a!.sessionId, b!.sessionId]);
  });

  test("startup and provider failures stay external and are cleaned up", async () => {
    const failedStart = harness({ ensureFailure: "External runtime is disabled" });
    await expect(
      failedStart.model("codex/gpt-6.1-sol", { ...REQUEST, signal: new AbortController().signal }),
    ).rejects.toThrow("External runtime is disabled");
    expect(failedStart.sends).toEqual([]);
    expect(failedStart.stops).toHaveLength(1);
    const f = harness();
    const result = f.model("codex/gpt-6.1-sol", {
      ...REQUEST,
      signal: new AbortController().signal,
    });
    await f.sent;
    f.pending
      .get(f.sends[0]!.sessionId)!
      .resolve({ ok: false, reason: "model_error", text: "External quota unavailable" });
    await expect(result).rejects.toThrow("External quota unavailable");
    expect(f.starts).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
    expect(f.stops).toHaveLength(1);
  });

  test("invalid model and unavailable service do not create a runtime", async () => {
    const f = harness();
    await expect(
      f.model("codex/", { ...REQUEST, signal: new AbortController().signal }),
    ).rejects.toThrow("配置无效");
    expect(f.starts).toEqual([]);
    const unavailable = createPetExternalReplyModel({ service: () => null, cwd: "/unused" });
    await expect(
      unavailable("claude-code/sonnet", { ...REQUEST, signal: new AbortController().signal }),
    ).rejects.toThrow("未切换到 API");
  });
});
