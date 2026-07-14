import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const SCENARIOS = new Set(["plain-text", "tool-call", "usage-with-cache", "error-then-ok"]);

function scenarioFrom(req, body) {
  const header = req.headers["x-mock-scenario"];
  if (typeof header === "string" && SCENARIOS.has(header)) return header;
  const model = typeof body?.model === "string" ? body.model : "";
  for (const scenario of SCENARIOS) {
    if (model.includes(scenario)) return scenario;
  }
  return "plain-text";
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("request body exceeds 2 MiB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function openAiChunk(model, choices, usage) {
  return {
    id: "chatcmpl-codeshell-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    ...(usage ? { usage } : {}),
  };
}

function writeOpenAiSse(res, chunks) {
  openSse(res);
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function usageFor(scenario) {
  return {
    prompt_tokens: 128,
    completion_tokens: 12,
    total_tokens: 140,
    ...(scenario === "usage-with-cache"
      ? { prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 16 } }
      : {}),
  };
}

function hasOpenAiToolResult(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) => message?.role === "tool");
}

function openAiResponse(body, scenario) {
  const model = typeof body.model === "string" ? body.model : `mock-${scenario}`;
  const usage = usageFor(scenario);
  if (scenario === "tool-call" && !hasOpenAiToolResult(body)) {
    const call = {
      id: "call_codeshell_smoke",
      type: "function",
      function: { name: "Glob", arguments: '{"pattern":"__codeshell_mock_no_match__"}' },
    };
    if (!body.stream) {
      return {
        id: "chatcmpl-codeshell-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [call] },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      };
    }
    return [
      openAiChunk(model, [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: "function",
                function: { name: call.function.name, arguments: '{"pattern":' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
      openAiChunk(model, [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"__codeshell_mock_no_match__"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
      openAiChunk(model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage),
    ];
  }

  const text =
    scenario === "tool-call"
      ? "The smoke tool call completed."
      : scenario === "usage-with-cache"
        ? "The cache usage smoke response completed."
        : scenario === "error-then-ok"
          ? "The retry smoke response completed."
          : "The plain streaming smoke response completed.";
  if (!body.stream) {
    return {
      id: "chatcmpl-codeshell-smoke",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    };
  }
  const split = Math.max(1, Math.floor(text.length / 2));
  return [
    openAiChunk(model, [
      {
        index: 0,
        delta: { role: "assistant", content: text.slice(0, split) },
        finish_reason: null,
      },
    ]),
    openAiChunk(model, [{ index: 0, delta: { content: text.slice(split) }, finish_reason: null }]),
    openAiChunk(model, [{ index: 0, delta: {}, finish_reason: "stop" }], usage),
  ];
}

function writeAnthropicEvent(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function hasAnthropicToolResult(body) {
  if (!Array.isArray(body?.messages)) return false;
  return body.messages.some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((block) => block?.type === "tool_result"),
  );
}

function writeAnthropicSse(res, body, scenario) {
  const model = typeof body.model === "string" ? body.model : `mock-${scenario}`;
  const toolCall = scenario === "tool-call" && !hasAnthropicToolResult(body);
  const cacheUsage =
    scenario === "usage-with-cache"
      ? { cache_read_input_tokens: 80, cache_creation_input_tokens: 16 }
      : {};
  openSse(res);
  writeAnthropicEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_codeshell_smoke",
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 128, output_tokens: 0, ...cacheUsage },
    },
  });
  if (toolCall) {
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_codeshell_smoke",
        name: "Glob",
        input: {},
      },
    });
    writeAnthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"pattern":"__codeshell_mock_no_match__"}',
      },
    });
    writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 },
    });
  } else {
    const text =
      scenario === "usage-with-cache"
        ? "The Anthropic cache smoke response completed."
        : "The Anthropic streaming smoke response completed.";
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeAnthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    });
  }
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

/**
 * Start a real local provider endpoint for smoke/E2E tests and manual use.
 * No application code knows this is a mock: callers configure baseUrl exactly
 * as they would for an OpenAI- or Anthropic-compatible provider.
 */
export async function startMockProviderServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const requests = [];
  const attempts = new Map();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/fixture") {
        const html =
          "<!doctype html><html><body><main id=mock-provider-fixture>CodeShell smoke fixture</main></body></html>";
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
        });
        return res.end(html);
      }
      if (req.method === "GET" && url.pathname === "/__mock/requests") {
        return sendJson(res, 200, { requests });
      }
      if (req.method === "POST" && url.pathname === "/__mock/reset") {
        requests.length = 0;
        attempts.clear();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [...SCENARIOS].map((id) => ({ id, object: "model", owned_by: "codeshell-smoke" })),
        });
      }
      if (
        req.method !== "POST" ||
        (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/messages")
      ) {
        return sendJson(res, 404, { error: { message: "mock provider route not found" } });
      }

      const body = await readJson(req);
      const scenario = scenarioFrom(req, body);
      const protocol = url.pathname.endsWith("/messages") ? "anthropic" : "openai";
      requests.push({ protocol, scenario, body, at: Date.now() });
      if (requests.length > 100) requests.shift();

      const attemptKey = `${protocol}:${scenario}`;
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);
      if (scenario === "error-then-ok" && attempt === 1) {
        return sendJson(
          res,
          429,
          { error: { type: "rate_limit_error", message: "scripted retryable smoke failure" } },
          { "retry-after": "0", "retry-after-ms": "1" },
        );
      }

      if (protocol === "anthropic") return writeAnthropicSse(res, body, scenario);
      const response = openAiResponse(body, scenario);
      if (Array.isArray(response)) return writeOpenAiSse(res, response);
      return sendJson(res, 200, response);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      } else {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind TCP");
  const origin = `http://${host}:${address.port}`;
  return {
    server,
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const instance = await startMockProviderServer({
    port: process.env.MOCK_PROVIDER_PORT ? Number(process.env.MOCK_PROVIDER_PORT) : undefined,
  });
  console.log(`CodeShell mock provider listening at ${instance.baseUrl}`);
  const stop = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
