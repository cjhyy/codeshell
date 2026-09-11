import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { StreamEvent } from "../../types.js";
import { ModelFacade } from "../../engine/model-facade.js";
import { Transcript } from "../../session/transcript.js";
import { OpenAIClient } from "./openai.js";

function send(
  res: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  res.write(
    `data: ${JSON.stringify({
      id: "reasoning-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => res.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    client: (provider = "openai", retryMaxAttempts = 1) =>
      new OpenAIClient(
        {
          provider,
          model: "fixture-model",
          apiKey: "local-fixture",
          baseUrl: `http://127.0.0.1:${port}/v1`,
        },
        { retryMaxAttempts, timeout: 3_000 },
        // Full-suite renderer tests install a mini DOM in this process. This
        // client only targets the loopback fixture with a synthetic credential.
        { dangerouslyAllowBrowser: true },
      ),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function assistantBlocks(transcript: Transcript) {
  return transcript
    .getEvents()
    .flatMap((event) =>
      event.type === "message" && event.data.role === "assistant" ? [event.data.content] : [],
    );
}

describe("OpenAI-compatible reasoning over real SSE", () => {
  for (const provider of ["openai", "deepseek"]) {
    test(`${provider} forwards thinking before completion and persists each field once`, async () => {
      let finish!: () => void;
      const terminal = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const server = await fixture(async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        send(res, { role: "assistant", reasoning_content: "先检查" });
        await terminal;
        send(res, { reasoning_content: "再处理。", content: "结果。" });
        send(res, {
          tool_calls: [
            {
              index: 0,
              id: "read-fixture",
              type: "function",
              function: { name: "Read", arguments: '{"path":' },
            },
          ],
        });
        send(res, { tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] });
        send(res, {}, "tool_calls");
        res.end("data: [DONE]\n\n");
      });
      try {
        const transcript = Transcript.inMemory(`reasoning-${provider}`);
        const facade = new ModelFacade(server.client(provider), transcript);
        const events: StreamEvent[] = [];
        let receivedThinking!: () => void;
        const thinking = new Promise<void>((resolve) => {
          receivedThinking = resolve;
        });
        let settled = false;
        const pending = facade
          .call("fixture", [{ role: "user", content: "fixture" }], [], (event) => {
            events.push(event);
            if (event.type === "thinking_delta") receivedThinking();
          })
          .finally(() => {
            settled = true;
          });
        await thinking;
        expect(settled).toBe(false);
        expect(events).toEqual([{ type: "thinking_delta", text: "先检查" }]);
        finish();
        const response = await pending;
        expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
          { type: "thinking_delta", text: "先检查" },
          { type: "thinking_delta", text: "再处理。" },
        ]);
        expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
        expect(events.filter((event) => event.type === "tool_use_start")).toHaveLength(1);
        expect(events.filter((event) => event.type === "tool_use_args_delta")).toHaveLength(1);
        expect(response.text).toBe("结果。");
        expect(response.reasoningContent).toBe("先检查再处理。");
        expect(response.toolCalls).toEqual([
          { id: "read-fixture", toolName: "Read", args: { path: "notes.txt" } },
        ]);
        expect(assistantBlocks(transcript)).toEqual([
          [
            { type: "reasoning", reasoningContent: "先检查再处理。" },
            { type: "text", text: "结果。" },
            { type: "tool_use", id: "read-fixture", name: "Read", input: { path: "notes.txt" } },
          ],
        ]);
      } finally {
        finish();
        await server.close();
      }
    });
  }

  test("does not infer thinking from answer text or unrelated provider metadata", async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send(res, {
        reasoning_content: null,
        reasoning_details: [{ text: "not part of the supported display field" }],
        content: "<think>ordinary answer text</think>",
      });
      send(res, { reasoning_content: { hidden: "not text" } });
      send(res, {}, "stop");
      res.end("data: [DONE]\n\n");
    });
    try {
      const events: StreamEvent[] = [];
      const transcript = Transcript.inMemory("no-reasoning-fixture");
      const response = await new ModelFacade(server.client(), transcript).call(
        "fixture",
        [],
        [],
        (event) => events.push(event),
      );
      expect(events.filter((event) => event.type === "thinking_delta")).toEqual([]);
      expect(response.reasoningContent).toBeUndefined();
      expect(response.text).toBe("<think>ordinary answer text</think>");
    } finally {
      await server.close();
    }
  });

  test("cancellation after the first thinking delta drops buffered reasoning, text and tools", async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send(res, {
        reasoning_content: "visible before Stop",
        content: "same-chunk late answer",
        tool_calls: [
          {
            index: 0,
            id: "same-chunk",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
        ],
      });
      send(res, {
        reasoning_content: "must not appear",
        content: "late answer",
        tool_calls: [
          { index: 0, id: "late", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      });
      send(res, {}, "stop");
      res.end("data: [DONE]\n\n");
    });
    try {
      const controller = new AbortController();
      const events: StreamEvent[] = [];
      await new ModelFacade(server.client(), Transcript.inMemory("cancel-reasoning-fixture"))
        .call(
          "fixture",
          [],
          [],
          (event) => {
            events.push(event);
            if (event.type === "thinking_delta") controller.abort();
          },
          controller.signal,
        )
        .catch((error) => {
          if (!controller.signal.aborted) throw error;
        });
      expect(events).toEqual([{ type: "thinking_delta", text: "visible before Stop" }]);
    } finally {
      await server.close();
    }
  });

  test("non-streaming fallback retains the provider's complete reasoning separately from answer text", async () => {
    const server = await fixture(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      expect(body.stream).toBeFalsy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fallback",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "final answer",
                reasoning_content: "provider final reasoning",
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    try {
      const transcript = Transcript.inMemory("fallback-reasoning-fixture");
      const response = await new ModelFacade(server.client(), transcript).callWithoutStreaming(
        "fixture",
        [],
        [],
      );
      expect(response.text).toBe("final answer");
      expect(response.reasoningContent).toBe("provider final reasoning");
      expect(assistantBlocks(transcript)).toEqual([
        [
          { type: "reasoning", reasoningContent: "provider final reasoning" },
          { type: "text", text: "final answer" },
        ],
      ]);
    } finally {
      await server.close();
    }
  });
});

function failSse(res: ServerResponse) {
  res.end(
    `data: ${JSON.stringify({ error: { message: "fixture interrupted stream", type: "server_error" } })}\n\n`,
  );
}

for (const first of ["thinking", "text", "tool"] as const) {
  test(`does not transparently retry after a ${first} delta escaped`, async () => {
    let requests = 0;
    const server = await fixture((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests === 1) {
        send(
          res,
          first === "thinking"
            ? { reasoning_content: "partial reasoning" }
            : first === "text"
              ? { content: "partial answer" }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: "partial-tool",
                      type: "function",
                      function: { name: "Read", arguments: "{}" },
                    },
                  ],
                },
        );
        failSse(res);
        return;
      }
      // This request would succeed if the client silently replayed the call.
      send(res, { reasoning_content: "different reasoning", content: "different answer" });
      send(res, {}, "stop");
      res.end("data: [DONE]\n\n");
    });
    try {
      const events: StreamEvent[] = [];
      const transcript = Transcript.inMemory(`no-retry-after-${first}`);
      await expect(
        new ModelFacade(server.client("openai", 3), transcript).call("fixture", [], [], (event) =>
          events.push(event),
        ),
      ).rejects.toThrow("fixture interrupted stream");
      expect(requests).toBe(1);
      expect(events.some((event) => "text" in event && event.text?.includes("different"))).toBe(
        false,
      );
      expect(assistantBlocks(transcript)).toEqual([]);
      expect(
        events.filter(
          (event) =>
            event.type ===
            (first === "thinking"
              ? "thinking_delta"
              : first === "text"
                ? "text_delta"
                : "tool_use_start"),
        ),
      ).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
}

test("still retries transient stream errors before the first visible delta", async () => {
  let requests = 0;
  const server = await fixture((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests === 1) {
      failSse(res);
      return;
    }
    send(res, { reasoning_content: "complete reasoning", content: "complete answer" });
    send(res, {}, "stop");
    res.end("data: [DONE]\n\n");
  });
  try {
    const events: StreamEvent[] = [];
    const transcript = Transcript.inMemory("retry-before-first-delta");
    const response = await new ModelFacade(server.client("openai", 3), transcript).call(
      "fixture",
      [],
      [],
      (event) => events.push(event),
    );
    expect(requests).toBe(2);
    expect(response.reasoningContent).toBe("complete reasoning");
    expect(response.text).toBe("complete answer");
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "complete reasoning" },
    ]);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
    expect(assistantBlocks(transcript)).toHaveLength(1);
  } finally {
    await server.close();
  }
});
