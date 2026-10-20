import { describe, it, expect } from "bun:test";
import OpenAI from "openai";
import { ModelFacade } from "../../engine/model-facade.js";
import { Transcript } from "../../session/transcript.js";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * Build a fake OpenAI streaming response: an async-iterable of chat-completion
 * chunks. The final chunk carries `finish_reason` like the real SDK does.
 */
function fakeStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** An OpenAIClient whose network client is replaced by a canned stream. */
function clientReturning(chunks: any[], maxTokens?: number): OpenAIClient {
  const client = new OpenAIClient(
    { provider: "openai", model: "gpt-4o", apiKey: "test", maxTokens },
    { retryMaxAttempts: 1 },
  );
  // Replace the lazy SDK client with a stub that yields our chunks.
  (client as any)._client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };
  return client;
}

const baseOpts = (): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: true,
  onChunk: () => {},
});

describe("OpenAIClient streaming stopReason", () => {
  it("returns finish_reason 'length' (output cap) instead of hardcoded 'stop'", async () => {
    const chunks = [
      { choices: [{ delta: { content: "partial answer" } }] },
      // Final chunk: content delta empty, finish_reason set — like the SDK.
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    const resp = await clientReturning(chunks).createMessage(baseOpts());
    expect(resp.text).toBe("partial answer");
    expect(resp.stopReason).toBe("length");
  });

  it("returns 'stop' for a normally-completed stream", async () => {
    const chunks = [
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const resp = await clientReturning(chunks).createMessage(baseOpts());
    expect(resp.stopReason).toBe("stop");
  });

  it("normalizes a cap-truncated OpenRouter tool call from 'tool_calls' to 'length'", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_write",
                  function: {
                    name: "Write",
                    arguments: '{"file_path":"/tmp/report.json","content":"unfinished',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196 },
      },
    ];

    const resp = await clientReturning(chunks, 4096).createMessage(baseOpts());

    expect(resp.stopReason).toBe("length");
    expect(resp.toolCalls).toEqual([
      { id: "call_write", toolName: "Write", args: {}, invalidArguments: true },
    ]);
    expect(resp.usage?.completionTokens).toBe(4096);
  });

  it("does not infer truncation for malformed tool arguments below the output cap", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_write",
                  function: { name: "Write", arguments: '{"file_path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    ];

    const resp = await clientReturning(chunks, 4096).createMessage(baseOpts());

    expect(resp.stopReason).toBe("tool_calls");
  });

  const prematureStreams: [string, any[]][] = [
    ["no chunks", []],
    ["role-only chunks", [{ choices: [{ delta: { role: "assistant" } }] }]],
    ["partial text", [{ choices: [{ delta: { content: "unfinished" } }] }]],
    ["reasoning only", [{ choices: [{ delta: { reasoning_content: "unfinished thought" } }] }]],
    [
      "empty finish reason",
      [{ choices: [{ delta: { content: "unfinished" }, finish_reason: "" }] }],
    ],
    [
      "null finish reason",
      [{ choices: [{ delta: { content: "unfinished" }, finish_reason: null }] }],
    ],
    [
      "usage-only chunks",
      [{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }],
    ],
    [
      "complete tool arguments without a terminal choice",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    function: { name: "Read", arguments: '{"path":"note.txt"}' },
                  },
                ],
              },
            },
          ],
        },
      ],
    ],
  ];

  it.each(prematureStreams)(
    "rejects natural EOF after %s instead of inventing stop",
    async (_name, chunks) => {
      await expect(clientReturning(chunks).createMessage(baseOpts())).rejects.toThrow(
        "OpenAI stream ended before receiving a finish_reason",
      );
    },
  );

  it.each(["content_filter", "function_call", "vendor_finish"])(
    "preserves compatible terminal reason %s without a whitelist",
    async (finishReason) => {
      const response = await clientReturning([
        { choices: [{ delta: {}, finish_reason: finishReason }] },
      ]).createMessage(baseOpts());
      expect(response.stopReason).toBe(finishReason);
    },
  );

  it("accepts empty choices before and after a finish-only choice and retains final usage", async () => {
    const response = await clientReturning([
      { choices: [] },
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]).createMessage(baseOpts());
    expect(response.text).toBe("done");
    expect(response.stopReason).toBe("stop");
    expect(response.usage).toMatchObject({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it("keeps reported usage when an unfinished stream is rejected", async () => {
    const client = clientReturning([
      { choices: [{ delta: { content: "unfinished" } }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]);
    await expect(client.createMessage(baseOpts())).rejects.toThrow("finish_reason");
    expect(client.getUsage()).toMatchObject({
      totalPromptTokens: 3,
      totalCompletionTokens: 2,
      totalTokens: 5,
    });
  });

  it("accepts a completed reasoning-only stream", async () => {
    const response = await clientReturning([
      { choices: [{ delta: { reasoning_content: "complete thought" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]).createMessage(baseOpts());
    expect(response.text).toBe("");
    expect(response.reasoningContent).toBe("complete thought");
    expect(response.stopReason).toBe("stop");
  });

  it("accepts completed tool calls without requiring answer text", async () => {
    const response = await clientReturning([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  function: { name: "Read", arguments: '{"path":"note.txt"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]).createMessage(baseOpts());
    expect(response.stopReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "call_read", toolName: "Read", args: { path: "note.txt" } },
    ]);
  });

  it("does not turn cancellation while consuming buffered chunks into an EOF error", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const response = await clientReturning([
      { choices: [{ delta: { content: "before cancel" } }] },
      { choices: [{ delta: { content: "must not be forwarded" } }] },
    ]).createMessage({
      ...baseOpts(),
      signal: controller.signal,
      onChunk: (chunk) => {
        if (chunk.type === "text") {
          seen.push(chunk.text ?? "");
          controller.abort();
        }
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(seen).toEqual(["before cancel"]);
    expect(response.text).toBe("before cancel");
  });

  it("preserves the SDK abort error without retrying it", async () => {
    const controller = new AbortController();
    const client = new OpenAIClient(
      { provider: "openai", model: "gpt-4o", apiKey: "test" },
      { retryMaxAttempts: 3 },
    );
    const abort = new OpenAI.APIUserAbortError();
    let calls = 0;
    (client as any)._client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            controller.abort();
            throw abort;
          },
        },
      },
    };
    await expect(client.createMessage({ ...baseOpts(), signal: controller.signal })).rejects.toBe(
      abort,
    );
    expect(calls).toBe(1);
  });

  it("does not start a request when its caller signal is already cancelled", async () => {
    const client = clientReturning([]);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    (client as any)._client.chat.completions.create = async () => {
      calls++;
      return fakeStream([]);
    };
    await expect(
      client.createMessage({ ...baseOpts(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  it("does not persist an unfinished assistant response through ModelFacade", async () => {
    const transcript = Transcript.inMemory("openai-premature-eof");
    const facade = new ModelFacade(
      clientReturning([{ choices: [{ delta: { content: "unfinished answer" } }] }]),
      transcript,
    );
    const emitted: string[] = [];
    await expect(
      facade.call("sys", baseOpts().messages, [], (event) => {
        if (event.type === "text_delta") emitted.push(event.text);
      }),
    ).rejects.toThrow("finish_reason");
    expect(emitted).toEqual(["unfinished answer"]);
    expect(
      transcript
        .getEvents()
        .filter((event) => event.type === "message" && event.data.role === "assistant"),
    ).toEqual([]);
  });
});
