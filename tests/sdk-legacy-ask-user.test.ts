/** Public SDK question lifecycle, including the single-Engine legacy route. */
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "./helpers/network-fixture.js";

const network = installFixtureNetworkGuard(); // No fixture needs a network origin.
const { createServer } = await import("../packages/core/src/protocol/factories.js");
const { Methods, USER_DECISION_TIMEOUT_MS } =
  await import("../packages/core/src/protocol/types.js");
const { askUserTool, ASK_USER_AUTO_RESOLVE_MS } =
  await import("../packages/core/src/tool-system/builtin/ask-user.js");
const { PROVIDER_REGISTRY, registerProvider } =
  await import("../packages/core/src/llm/client-factory.js");
const { LLMClientBase } = await import("../packages/core/src/llm/client-base.js");
afterAll(() => network.restore());

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-legacy-ask-"));
  const saved = new Map(PROVIDER_REGISTRY);
  class FakeProvider extends LLMClientBase {
    protected initClient() {}
    async createMessage(): Promise<any> {
      throw new Error("This protocol fixture must not call a model");
    }
  }
  PROVIDER_REGISTRY.clear();
  registerProvider("openai", FakeProvider);
  const sent: any[] = [];
  let deliver: (message: any) => void = () => {};
  const handle = createServer({
    cwd,
    llm: {
      provider: "openai",
      providerKind: "openai",
      model: "fixture",
      apiKey: "fixture",
      enableStreaming: false,
    },
    engineOverrides: {
      headless: false,
      enabledBuiltinTools: ["AskUserQuestion"],
      sessionStorageDir: join(cwd, "sessions"),
    },
    transport: {
      send: (message) => {
        sent.push(message);
      },
      onMessage: (callback) => {
        deliver = callback;
      },
      close() {},
    },
  });
  return {
    sent,
    deliver: (message: any) => deliver(message),
    ctx: handle.engine.buildToolContext(cwd),
    request: () => sent.find((frame) => frame.method === Methods.ApprovalRequest)?.params,
    async close() {
      await handle.close();
      await handle.engine.dispose();
      PROVIDER_REGISTRY.clear();
      for (const [key, provider] of saved) PROVIDER_REGISTRY.set(key, provider);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const question = {
  question: "Which safe path?",
  options: [
    { label: "Safe default", description: "Use the deterministic fixture", recommended: true },
    { label: "Alternative", description: "Use another fixture" },
  ],
};

test("public createServer AskUserQuestion must honor two-minute recommended default", async () => {
  const f = fixture();
  const timers: Array<{ delay: number; fire: () => void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback,
    delay,
    ...args
  ) => {
    if (typeof delay === "number" && delay >= ASK_USER_AUTO_RESOLVE_MS - 100) {
      timers.push({ delay, fire: () => callback(...args) });
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    // Exercise the real tool -> real Engine context -> real legacy lifecycle.
    const pending = askUserTool(question, f.ctx);
    const request = f.request();
    expect(request?.request.toolName).toBe("__ask_user__");
    expect(timers).toHaveLength(1);
    timers[0]!.fire(); // Time acceleration only; execute the producer's own timeout callback.
    const answer = await pending;
    const actual = {
      advertisedDelay: request.expiresAt - now,
      scheduledDelay: timers[0]!.delay,
      keepWaitable: request.request.args.keepWaitable,
      skippable: request.request.args.skippable,
      usedRecommendedDefault: answer.includes("Safe default"),
    };
    const expected = {
      advertisedDelay: ASK_USER_AUTO_RESOLVE_MS,
      scheduledDelay: ASK_USER_AUTO_RESOLVE_MS,
      keepWaitable: true,
      skippable: true,
      usedRecommendedDefault: true,
    };
    expect(actual).toEqual(expected);
  } finally {
    clock.mockRestore();
    timerSpy.mockRestore();
    await f.close();
  }
});

test("public createServer must accept keep-waiting for a model question", async () => {
  const f = fixture();
  let pending: Promise<string> | undefined;
  try {
    pending = askUserTool(question, f.ctx);
    const request = f.request();
    const { connectionId, sessionId, generation, requestId } = request;
    f.deliver({
      jsonrpc: "2.0",
      id: "keep",
      method: Methods.ApprovalKeepWaiting,
      params: { connectionId, sessionId, generation, requestId },
    });
    await Promise.resolve();
    const actual = f.sent.find((frame) => frame.id === "keep");
    expect(actual?.result).toEqual({ ok: true });
    const requests = f.sent.filter((frame) => frame.method === Methods.ApprovalRequest);
    expect(requests.at(-1)?.params.expiresAt).toBeUndefined();
  } finally {
    await f.close();
    await pending;
  }
});

test("non-model confirmation retains the ten-minute deadline", async () => {
  const f = fixture();
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  let pending: Promise<string> | undefined;
  try {
    pending = f.ctx.askUser!("Allow the operation?", { throwOnFailure: false });
    const request = f.request();
    expect(request.expiresAt - now).toBe(USER_DECISION_TIMEOUT_MS);
    expect(request.request.args.keepWaitable).toBeUndefined();
    expect(request.request.args.skippable).toBeUndefined();
  } finally {
    clock.mockRestore();
    await f.close();
    await pending;
  }
});

test("legacy keep-wait is idempotent, rejects unknown requests and fences an already queued timer", async () => {
  const f = fixture();
  const callbacks: (() => void)[] = [];
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn, delay, ...args) => {
    if (typeof delay === "number" && delay >= ASK_USER_AUTO_RESOLVE_MS - 100)
      callbacks.push(() => fn(...args));
    return original(fn, delay, ...args);
  }) as typeof setTimeout);
  let settled = false;
  const pending = askUserTool(question, f.ctx).then((answer) => {
    settled = true;
    return answer;
  });
  try {
    const { connectionId, sessionId, generation, requestId } = f.request();
    const route = { connectionId, sessionId, generation, requestId };
    f.deliver({
      jsonrpc: "2.0",
      id: "foreign",
      method: Methods.ApprovalKeepWaiting,
      params: { ...route, requestId: "unknown" },
    });
    await Promise.resolve();
    expect(f.sent.find((event) => event.id === "foreign")?.error).toBeDefined();
    for (const id of ["keep-1", "keep-2"])
      f.deliver({ jsonrpc: "2.0", id, method: Methods.ApprovalKeepWaiting, params: route });
    await Promise.resolve();
    expect(
      f.sent.filter((event) => event.id?.startsWith("keep-")).every((event) => event.result?.ok),
    ).toBe(true);
    callbacks[0]!();
    await Promise.resolve();
    expect(settled).toBe(false);
    f.deliver({
      jsonrpc: "2.0",
      id: "answer",
      method: Methods.Approve,
      params: { ...route, decision: { approved: true, answer: "Alternative" } },
    });
    expect(await pending).toContain("Alternative");
    f.deliver({
      jsonrpc: "2.0",
      id: "late-keep",
      method: Methods.ApprovalKeepWaiting,
      params: route,
    });
    await Promise.resolve();
    expect(f.sent.find((event) => event.id === "late-keep")?.error).toBeDefined();
  } finally {
    timer.mockRestore();
    await f.close();
    await pending;
  }
});

test("legacy deadline expiry before its timer uses the recommended answer and grants no permission", async () => {
  const f = fixture();
  const pending = askUserTool(question, f.ctx);
  const request = f.request();
  const now = spyOn(Date, "now").mockReturnValue(request.expiresAt + 1);
  try {
    const { connectionId, sessionId, generation, requestId } = request;
    f.deliver({
      jsonrpc: "2.0",
      id: "late-answer",
      method: Methods.Approve,
      params: {
        connectionId,
        sessionId,
        generation,
        requestId,
        decision: { approved: true, answer: "Alternative" },
      },
    });
    expect(await pending).toContain("Safe default");
    expect(f.sent.find((event) => event.id === "late-answer")?.error).toBeDefined();
    expect(f.sent.find((event) => event.method === Methods.ApprovalResolved)?.params).toMatchObject(
      { approved: false, failure: "timed_out" },
    );
  } finally {
    now.mockRestore();
    await f.close();
  }
});

test("legacy cancellation retires its model question and cannot be revived by keep-waiting", async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.ctx.askUser!("question", {
    signal: controller.signal,
    autoResolveMs: ASK_USER_AUTO_RESOLVE_MS,
  });
  try {
    const { connectionId, sessionId, generation, requestId } = f.request();
    controller.abort();
    expect(await pending).toContain("cancelled");
    f.deliver({
      jsonrpc: "2.0",
      id: "after-cancel",
      method: Methods.ApprovalKeepWaiting,
      params: { connectionId, sessionId, generation, requestId },
    });
    await Promise.resolve();
    expect(f.sent.find((event) => event.id === "after-cancel")?.error).toBeDefined();
  } finally {
    await f.close();
  }
});
