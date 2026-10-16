import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearModelTracingConfiguration,
  configureModelTracing,
  recordExternalModelTrace,
  recordExternalModelCall,
  recordModelTraceEvent,
  withModelTrace,
  withModelTraceContext,
} from "./context.js";
import { ModelTraceStore } from "./store.js";
import { UsageLedger } from "../cost-ledger/store.js";
import { withUsageOwner } from "../cost-ledger/context.js";
import { createLLMClient } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";

const response = (text = "answer") => ({
  id: "fixture-response",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});
const options = (fields: Partial<CreateMessageOptions> = {}): CreateMessageOptions => ({
  systemPrompt: "private system",
  messages: [{ role: "user", content: "private input" }],
  tools: [],
  ...fields,
});
const sdkConfig = {
  provider: "openai",
  model: "fixture-model",
  apiKey: "fixture-key",
  baseUrl: "https://model-trace.fixture.invalid/v1",
  maxTokens: 256,
  supportsVision: true,
};

describe("model trace collection at the provider boundary", () => {
  let directory: string, store: ModelTraceStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "codeshell-traces-"));
    store = configureModelTracing({ storageDir: directory, source: "fixture-host" });
  });
  afterEach(() => {
    clearModelTracingConfiguration();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = (fetch: typeof globalThis.fetch, retryMaxAttempts = 1) =>
    createLLMClient(sdkConfig, { fetch, retryMaxAttempts, timeout: 1000 });
  const only = () => {
    const listed = store.list();
    expect(listed.total).toBe(1);
    return store.get(listed.items[0].id)!;
  };
  const mock = (fn: (body: any, number: number) => Response | Promise<Response>): typeof fetch => {
    let number = 0;
    return (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(new URL(url).origin).toBe("https://model-trace.fixture.invalid");
      return fn(JSON.parse(String(init?.body)), ++number);
    }) as typeof fetch;
  };
  test("explicit metadata-only capture covers hidden, billing-disabled calls without a UsageOwner", async () => {
    store.setConfig({ captureContent: false });
    const llm = await client(mock(() => Response.json(response())));
    const result = await llm.createMessage(
      options({ billingEnabled: false, requestVisible: false, usagePurpose: "title" }),
    );
    expect(result.text).toBe("answer");
    const trace = only();
    expect(trace.providerKind).toBe("openai");
    expect(trace.purpose).toBe("title");
    expect(trace.inputState).toBe("not-recorded");
    expect(trace.input).toBeUndefined();
    expect(trace.output).toBeUndefined();
    expect(trace.usage?.totalTokens).toBe(10);
    expect(trace.attempts[0].coverage).toBe("provider-wire");
    expect(trace.attempts[0].httpStatus).toBe(200);
    expect(JSON.stringify(trace)).not.toContain("private");
    expect(JSON.stringify(trace)).not.toContain("answer");
  });
  test("default recording includes Prompt, output and temporary auxiliary calls", async () => {
    const llm = await client(mock(() => Response.json(response())));
    await withModelTraceContext({ ephemeral: true }, () =>
      llm.createMessage(
        options({ billingEnabled: false, requestVisible: false, usagePurpose: "title" }),
      ),
    );
    const trace = only();
    expect(trace.input?.systemPrompt).toBe("private system");
    expect(trace.input?.messages).toEqual([{ role: "user", content: "private input" }]);
    expect(trace.output?.text).toBe("answer");
    expect(trace.attempts[0].inputState).toBe("recorded");
    expect(trace.attempts[0].coverage).toBe("provider-wire");
  });
  test("captures final provider messages and parameters with images, credentials and sensitive tool results removed", async () => {
    store.setConfig({ captureContent: true });
    let sent: any;
    const llm = await client(
      mock((body) => {
        sent = body;
        return Response.json(response());
      }),
    );
    await llm.createMessage(
      options({
        temperature: 0.7,
        maxTokens: 123,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "A".repeat(512) },
              },
              { type: "text", text: "Bearer abcdefghijklmnop" },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "sensitive", name: "Read", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "sensitive", content: "PRIVATE_TOOL_SECRET" },
            ],
          },
        ],
        diagnosticRedactions: new Map([["sensitive", "<sensitive result omitted>"]]),
      }),
    );
    const trace = only(),
      attempt = trace.attempts[0];
    expect(sent.temperature).toBe(0.7);
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(123);
    expect(JSON.stringify(sent)).toContain("PRIVATE_TOOL_SECRET");
    expect((attempt.input as any).temperature).toBe(0.7);
    expect((attempt.input as any).messages[0].role).toBe("system");
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_TOOL_SECRET");
    expect(JSON.stringify(trace)).not.toContain("A".repeat(128));
    expect(JSON.stringify(trace)).not.toContain("abcdefghijklmnop");
    expect(trace.inputState).toBe("redacted");
    expect(attempt.inputState).toBe("redacted");
    expect(trace.output?.text).toBe("answer");
  });
  test("settings change for the same live client and preserve explicit workspace/run ownership", async () => {
    store.setConfig({ captureContent: false });
    const llm = await client(mock(() => Response.json(response())));
    const ledger = new UsageLedger();
    const run = () =>
      withModelTraceContext({ workspacePath: "/workspace", source: "desktop" }, () =>
        withUsageOwner(ledger.owner("session", "run-1", ["parent"], "main"), () =>
          llm.createMessage(options()),
        ),
      );
    await run();
    new ModelTraceStore({ storageDir: directory }).setConfig({ captureContent: true });
    await run();
    const rows = store.list({ workspacePath: "/workspace", traceId: "run-1" }).items;
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.sessionId === "session" && row.parentSessionId === "parent"),
    ).toBe(true);
    expect(rows.map((row) => row.inputState).sort()).toEqual(["not-recorded", "recorded"]);
    store.setConfig({ enabled: false });
    await run();
    expect(store.list().total).toBe(2);
  });
  test("records SDK retries separately without overwriting the failed attempt's end time", async () => {
    store.setConfig({ captureContent: true });
    let count = 0;
    const llm = await client(
      mock((_body, number) => {
        count++;
        return number === 1
          ? Response.json(
              { error: { message: "try again", type: "server_error" } },
              { status: 503, headers: { "x-should-retry": "true", "retry-after-ms": "30" } },
            )
          : Response.json(response());
      }),
    );
    await llm.createMessage(options());
    const trace = only();
    expect(count).toBe(2);
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0].status).toBe("failed");
    expect(trace.attempts[1].status).toBe("completed");
    expect(trace.attempts[0].id).not.toBe(trace.attempts[1].id);
    expect(trace.attempts[0].endedAt!).toBeLessThan(trace.attempts[1].startedAt);
    expect(trace.attempts[0].httpStatus).toBe(503);
    expect(trace.attempts[1].usage?.totalTokens).toBe(10);
  });
  test("retains partial streamed output and TTFT when provider parsing fails without retrying visible deltas", async () => {
    store.setConfig({ captureContent: true });
    let count = 0;
    const deltas: string[] = [];
    const llm = await client(
      mock(() => {
        count++;
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"partial answer"}}]}\n\ndata: invalid-json\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
      3,
    );
    await expect(
      llm.createMessage(
        options({
          stream: true,
          onChunk: (chunk) => {
            if (chunk.type === "text") deltas.push(chunk.text ?? "");
          },
        }),
      ),
    ).rejects.toThrow();
    expect(count).toBe(1);
    expect(deltas.join("")).toBe("partial answer");
    const trace = only();
    expect(trace.status).toBe("failed");
    expect(trace.attempts[0].status).toBe("failed");
    expect(trace.attempts[0].output?.text).toBe("partial answer");
    expect(trace.output?.text).toBe("partial answer");
    expect(trace.attempts[0].firstTokenAt).toBeGreaterThanOrEqual(trace.attempts[0].startedAt);
    expect(trace.attempts[0].endedAt).toBeGreaterThanOrEqual(trace.attempts[0].firstTokenAt!);
  });
  test("streams Anthropic text and usage through the same transport observer", async () => {
    store.setConfig({ captureContent: true });
    const llm = await createLLMClient(
      {
        provider: "anthropic",
        model: "claude-fixture",
        apiKey: "fixture-key",
        baseUrl: "https://model-trace.fixture.invalid",
      },
      {
        retryMaxAttempts: 1,
        fetch: mock(
          () =>
            new Response(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","model":"claude-fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic answer"}}\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
        ),
      },
    );
    await llm.createMessage(options({ stream: true, onChunk: () => {} }));
    const trace = only();
    expect(trace.output?.text).toBe("anthropic answer");
    expect(trace.usage?.totalTokens).toBe(10);
    expect((trace.attempts[0].input as any).system[0].text).toBe("private system");
    expect(trace.attempts[0].firstTokenAt).toBeDefined();
  });
  test("ephemeral opt-out propagates to hidden billing-disabled helpers", async () => {
    store.setConfig({ captureContent: true, includeEphemeral: false });
    const llm = await client(mock(() => Response.json(response())));
    await withModelTraceContext({ ephemeral: true }, () =>
      llm.createMessage(options({ billingEnabled: false, usagePurpose: "aux_summary" })),
    );
    expect(store.list().total).toBe(0);
    store.setConfig({ includeEphemeral: true, captureContent: false });
    await withModelTraceContext({ ephemeral: true }, () =>
      llm.createMessage(options({ billingEnabled: false })),
    );
    expect(only().input).toBeUndefined();
  });
  test("scope overrides prevent separate Hosts in one process from mixing trace stores", async () => {
    const secondPath = join(directory, "second-host");
    const first = store;
    configureModelTracing({ storageDir: secondPath, source: "second" });
    const llm = await client(mock(() => Response.json(response())));
    await withModelTraceContext(
      { storageDir: directory, workspacePath: "/first", source: "first" },
      () => llm.createMessage(options()),
    );
    expect(first.list().items[0].source).toBe("first");
    expect(new ModelTraceStore({ storageDir: secondPath }).list().total).toBe(0);
  });
  test("tool events and external CLI coverage share run attribution without claiming provider-wire visibility", () => {
    store.setConfig({ captureContent: true });
    withModelTraceContext(
      { workspacePath: "/workspace", runId: "run", sessionId: "session" },
      () => {
        const event = recordModelTraceEvent({
          kind: "tool",
          name: "Read",
          startedAt: Date.now(),
          status: "completed",
          input: { file: "/workspace/a" },
          output: "contents",
        });
        expect(event?.traceId).toBe("run");
        expect(store.events("run")[0].workspacePath).toBe("/workspace");
        const initial = recordExternalModelTrace({
          provider: "external",
          model: "codex",
          source: "codex-cli",
          startedAt: Date.now(),
          status: "running",
          input: { messages: [{ role: "user", content: "submitted input" }] },
        })!;
        recordExternalModelTrace({
          id: initial.id,
          provider: "external",
          model: "codex",
          source: "codex-cli",
          startedAt: initial.startedAt,
          endedAt: Date.now(),
          status: "completed",
          output: { text: "cli result" },
        });
      },
    );
    const trace = only();
    expect(trace.attempts[0].coverage).toBe("external-cli-input");
    expect(trace.input?.messages).toHaveLength(1);
    expect(trace.output?.text).toBe("cli result");
  });
  test("a trace persistence failure cannot fail or replay a provider operation", async () => {
    const badPath = join(directory, "regular-file");
    writeFileSync(badPath, "not a directory");
    configureModelTracing({ storageDir: badPath });
    let count = 0;
    const llm = await client(
      mock(() => {
        count++;
        return Response.json(response());
      }),
    );
    expect((await llm.createMessage(options())).text).toBe("answer");
    expect(count).toBe(1);
  });
  test("enabling content or ephemeral persistence during a call only affects later calls", async () => {
    store.setConfig({ captureContent: false, includeEphemeral: false });
    let finish!: () => void;
    const ready = Promise.withResolvers<void>();
    const llm = await client(
      mock(async () => {
        ready.resolve();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return Response.json(response());
      }),
    );
    const pending = llm.createMessage(options());
    await ready.promise;
    store.setConfig({ captureContent: true });
    finish();
    await pending;
    expect(only().outputState).toBe("not-recorded");
    expect(only().attempts[0].output).toBeUndefined();

    const ephemeralReady = Promise.withResolvers<void>();
    const ephemeralClient = await client(
      mock(async () => {
        ephemeralReady.resolve();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return Response.json(response());
      }),
    );
    const ephemeral = withModelTraceContext({ ephemeral: true }, () =>
      ephemeralClient.createMessage(options()),
    );
    await ephemeralReady.promise;
    store.setConfig({ includeEphemeral: true });
    finish();
    await ephemeral;
    expect(store.list().total).toBe(1);
  });
  test("closing content capture during a call stops subsequent response capture", async () => {
    store.setConfig({ captureContent: true });
    const llm = await client(
      mock(() => {
        store.setConfig({ captureContent: false });
        return Response.json(response("AFTER_OPT_OUT"));
      }),
    );
    await llm.createMessage(options());
    expect(only().input?.systemPrompt).toBe("private system");
    expect(JSON.stringify(only())).not.toContain("AFTER_OPT_OUT");
  });
  test("tool events link to the exact model call even before streamed tool-start delivery", async () => {
    store.setConfig({ captureContent: false });
    let parentId: string | undefined;
    const llm = await client(
      mock(
        () =>
          new Response(
            [
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
              "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    await withModelTraceContext({ runId: "run", sessionId: "session" }, async () => {
      await llm.createMessage(
        options({
          stream: true,
          onChunk: (chunk) => {
            if (chunk.type === "tool_use_start")
              parentId = recordModelTraceEvent({
                kind: "tool",
                name: "Read",
                startedAt: Date.now(),
                status: "running",
                input: { toolCallId: "tool-1" },
              })?.parentId;
          },
        }),
      );
    });
    expect(parentId).toBe(only().id);
    expect(store.events("run")[0].parentId).toBe(only().id);
    expect(only().input).toBeUndefined();
  });
  test("reused tool IDs remain unlinked rather than guessing the latest call", async () => {
    const identity = { provider: "fixture", model: "model" };
    const result = {
      text: "",
      toolCalls: [{ id: "reused", toolName: "Read", args: {} }],
      stopReason: "tool_use" as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    await withModelTraceContext({ runId: "run", sessionId: "session" }, async () => {
      await withModelTrace(identity, options(), async () => result);
      await withModelTrace(identity, options(), async () => result);
      const event = recordModelTraceEvent({
        kind: "tool",
        name: "Read",
        startedAt: Date.now(),
        status: "completed",
        input: { toolCallId: "reused" },
      });
      expect(event?.parentId).toBeUndefined();
      const nested = recordModelTraceEvent({
        kind: "tool",
        name: "Read",
        startedAt: Date.now(),
        status: "completed",
        parentId: "explicit-parent",
        input: { toolCallId: "reused" },
      });
      expect(nested?.parentId).toBe("explicit-parent");
    });
  });
  test("locally known pricing and missing attempt prices stay distinguishable", async () => {
    const llm = await createLLMClient(
      { ...sdkConfig, model: "gpt-4o" },
      {
        fetch: mock((_body, number) =>
          number === 1
            ? Response.json(
                { error: { message: "retry" } },
                { status: 503, headers: { "x-should-retry": "true", "retry-after-ms": "1" } },
              )
            : Response.json(response()),
        ),
        retryMaxAttempts: 1,
      },
    );
    await llm.createMessage(options());
    const trace = only();
    expect(trace.estimatedCostUsd).toBeGreaterThan(0);
    expect(trace.unknownCostAttempts).toBe(1);
    expect(trace.attempts[0].estimatedCostUsd).toBeNull();
    expect(trace.attempts[1].pricing?.source).toBe("model-metadata");
  });
  test("custom transports retain a logical attempt when they fail without calling fetch", async () => {
    await expect(
      withModelTrace({ provider: "custom", model: "fixture" }, options(), async () => {
        throw new Error("custom failure");
      }),
    ).rejects.toThrow("custom failure");
    const trace = only();
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0].coverage).toBe("logical-input");
    expect(trace.attempts[0].status).toBe("failed");
  });
  test("explicit diagnostic attribution can clear a stale billing owner without changing accounting", async () => {
    const llm = await client(mock(() => Response.json(response())));
    const ledger = new UsageLedger();
    await withUsageOwner(ledger.owner("old-session", "old-run", ["old-parent"], "main"), () =>
      withModelTraceContext(
        { sessionId: "source-session", runId: undefined, parentSessionId: undefined },
        async () => {
          await llm.createMessage(options());
          const event = recordModelTraceEvent({
            kind: "lifecycle",
            name: "helper",
            startedAt: Date.now(),
            status: "completed",
          });
          expect(event?.sessionId).toBe("source-session");
          expect(event?.runId).toBeUndefined();
          const external = recordExternalModelTrace({
            provider: "external",
            model: "fixture",
            source: "fixture",
            startedAt: Date.now(),
            status: "completed",
          });
          expect(external?.sessionId).toBe("source-session");
          expect(external?.runId).toBeUndefined();
          expect(external?.parentSessionId).toBeUndefined();
        },
      ),
    );
    const native = store.list().items.find((row) => row.provider === "openai")!;
    expect(native.sessionId).toBe("source-session");
    expect(native.runId).toBeUndefined();
    expect(native.parentSessionId).toBeUndefined();
    expect(native.traceId).toBe(native.id);
    expect(ledger.summary({ scope: "session", sessionId: "old-session" }).requests).toBe(1);
  });
  test("the narrow capability observer pins initial scope and ignores runtime scope injection", () => {
    store.setConfig({ captureContent: true, includeEphemeral: false });
    const first = withModelTraceContext(
      { workspacePath: "/first", sessionId: "first-session", runId: "first-run", ephemeral: true },
      () =>
        recordExternalModelCall({
          source: "capability",
          provider: "external",
          model: "fixture",
          startedAt: Date.now(),
          status: "running",
          input: { messages: ["private"] },
          ...({
            storageDir: join(directory, "injected"),
            workspacePath: "/injected",
            ephemeral: false,
            sessionId: "injected",
            runId: "injected",
          } as any),
        }),
    )!;
    expect(first.runId).toBe("first-run");
    expect(first.workspacePath).toBe("/first");
    expect(store.list().total).toBe(0);
    store.setConfig({ includeEphemeral: true });
    const final = withModelTraceContext(
      {
        storageDir: join(directory, "second-host"),
        sessionId: "second-session",
        runId: "second-run",
        ephemeral: false,
      },
      () =>
        recordExternalModelCall({
          id: first.id,
          source: "capability",
          provider: "external",
          model: "fixture",
          startedAt: first.startedAt,
          status: "completed",
          output: { text: "private final" },
        }),
    )!;
    expect(final.runId).toBe("first-run");
    expect(final.sessionId).toBe("first-session");
    expect(final.workspacePath).toBe("/first");
    expect(store.list().total).toBe(0);
    expect(new ModelTraceStore({ storageDir: join(directory, "second-host") }).list().total).toBe(
      0,
    );
    expect(
      recordExternalModelCall({
        id: first.id,
        source: "capability",
        provider: "external",
        model: "fixture",
        startedAt: first.startedAt,
        status: "completed",
      }),
    ).toBeNull();
  });
  test("oversized partial tool arguments report truncation when the stream later fails", async () => {
    store.setConfig({ captureContent: true });
    const data = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "long-tool",
                type: "function",
                function: { name: "Read", arguments: `{"payload":"${"x".repeat(70 * 1024)}` },
              },
            ],
          },
        },
      ],
    };
    const llm = await client(
      mock(
        () =>
          new Response(`data: ${JSON.stringify(data)}\n\ndata: invalid-json\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    await expect(llm.createMessage(options({ stream: true, onChunk: () => {} }))).rejects.toThrow();
    const trace = only();
    expect(trace.attempts[0].outputState).toBe("truncated");
    expect((trace.attempts[0].output?.toolCalls?.[0] as any).args.length).toBe(64 * 1024);
  });
  test("enabling tracing midway through a disabled tool span cannot capture its earlier input or final output", () => {
    const event = {
      id: "disabled-span",
      kind: "tool" as const,
      name: "Read",
      startedAt: Date.now(),
      input: { text: "EARLIER_INPUT" },
    };
    store.setConfig({ enabled: false, captureContent: true });
    expect(recordModelTraceEvent({ ...event, status: "running", first: true })).toBeNull();
    store.setConfig({ enabled: true });
    expect(
      recordModelTraceEvent({ ...event, status: "completed", output: "LATER_OUTPUT" }),
    ).toBeNull();
    expect(store.events("disabled-span")).toEqual([]);
    expect(
      recordModelTraceEvent({ ...event, id: "new-span", status: "completed", first: true })
        ?.inputState,
    ).toBe("recorded");
  });
  test("off/on between transport reads cannot replay a cumulative native response into an old call", async () => {
    store.setConfig({ captureContent: true });
    let toggled = false;
    const llm = await client(
      mock(() => {
        if (!toggled) {
          toggled = true;
          store.setConfig({ captureContent: false });
          store.setConfig({ captureContent: true });
        }
        return Response.json(response("PRIVATE_WHILE_CAPTURE_WAS_OFF"));
      }),
    );
    expect((await llm.createMessage(options())).text).toBe("PRIVATE_WHILE_CAPTURE_WAS_OFF");
    const old = only();
    expect(old.outputState).toBe("not-recorded");
    expect(JSON.stringify(old)).not.toContain("PRIVATE_WHILE_CAPTURE_WAS_OFF");
    await llm.createMessage(options());
    const saved = store.list().items.map((item) => store.get(item.id)!);
    expect(
      saved.filter((item) => item.output?.text === "PRIVATE_WHILE_CAPTURE_WAS_OFF"),
    ).toHaveLength(1);
  });
  test("capability final-result replay cannot resume an earlier external call after off/on", () => {
    store.setConfig({ captureContent: true });
    const first = recordExternalModelCall({
      source: "driver",
      provider: "fixture",
      model: "fixture",
      startedAt: Date.now(),
      status: "running",
      input: { messages: [{ role: "user", content: "original delegated prompt" }] },
    })!;
    store.setConfig({ captureContent: false });
    store.setConfig({ captureContent: true });
    recordExternalModelCall({
      id: first.id,
      source: "driver",
      provider: "fixture",
      model: "fixture",
      startedAt: first.startedAt,
      status: "completed",
      output: { text: "PRIVATE_CUMULATIVE_CLI_RESPONSE" },
    });
    const old = store.get(first.id)!;
    expect(old.status).toBe("completed");
    expect(old.outputState).toBe("not-recorded");
    expect(JSON.stringify(old)).not.toContain("PRIVATE_CUMULATIVE_CLI_RESPONSE");
  });
  test("a native stream retains its safe prefix without replaying cumulative output after off/on", async () => {
    store.setConfig({ captureContent: true });
    const tail = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    const llm = await client(
      mock(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"SAFE_PREFIX"}}]}\n\n',
                  ),
                );
              },
              async pull(controller) {
                await tail.promise;
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"PRIVATE_TAIL"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const result = await llm.createMessage(
      options({
        stream: true,
        onChunk: (chunk) => {
          if (chunk.type === "text" && chunk.text === "SAFE_PREFIX") {
            store.setConfig({ captureContent: false });
            store.setConfig({ captureContent: true });
            tail.resolve();
          }
        },
      }),
    );
    expect(result.text).toBe("SAFE_PREFIXPRIVATE_TAIL");
    const saved = only();
    expect(saved.output?.text).toBe("SAFE_PREFIX");
    expect(saved.outputState).toBe("truncated");
    expect(saved.attempts[0].output?.text).toBe("SAFE_PREFIX");
    expect(saved.attempts[0].outputState).toBe("truncated");
    expect(saved.status).toBe("completed");
    expect(JSON.stringify(saved)).not.toContain("PRIVATE_TAIL");
  });
  test("evicting an active external policy cannot recreate capture after off/on", () => {
    store.setConfig({ captureContent: true });
    const first = recordExternalModelCall({
      source: "driver",
      provider: "fixture",
      model: "fixture",
      startedAt: Date.now(),
      status: "running",
      input: { messages: ["SAFE_INPUT"] },
      output: { text: "SAFE_PREFIX" },
    })!;
    store.setConfig({ enabled: false });
    for (let index = 0; index < 4100; index++)
      recordModelTraceEvent({
        id: `eviction-${index}`,
        first: true,
        kind: "tool",
        name: "Other",
        startedAt: Date.now(),
        status: "running",
      });
    store.setConfig({ enabled: true });
    const final = recordExternalModelCall({
      id: first.id,
      source: "driver",
      provider: "fixture",
      model: "fixture",
      startedAt: first.startedAt,
      endedAt: Date.now(),
      status: "completed",
      output: { text: "SAFE_PREFIX_PRIVATE_WHILE_DISABLED" },
    });
    expect(final?.status).toBe("completed");
    const saved = store.get(first.id)!;
    expect(saved.input?.messages).toEqual(["SAFE_INPUT"]);
    expect(saved.output?.text).toBe("SAFE_PREFIX");
    expect(saved.outputState).toBe("truncated");
    expect(JSON.stringify(saved)).not.toContain("PRIVATE_WHILE_DISABLED");
  });
});
