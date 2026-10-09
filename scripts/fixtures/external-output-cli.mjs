// Synthetic stdio protocol backends. No installed/logged-in CLI or provider is used.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { once } from "node:events";
const kind = process.env.CODESHELL_OUTPUT_KIND;
const send = async (value) => {
  if (!process.stdout.write(JSON.stringify(value) + "\n")) await once(process.stdout, "drain");
};
const record = (event) =>
  appendFileSync(
    process.env.CODESHELL_OUTPUT_REQUEST_LOG,
    JSON.stringify({
      event,
      kind,
      pid: process.pid,
      ppid: process.ppid,
      homeHash: process.env.CODESHELL_OUTPUT_HOME_HASH,
    }) + "\n",
    { mode: 0o600 },
  );
const part = (index) => `${index.toString().padStart(4, "0")}-汉🙂${"x".repeat(48 * 1024)}\n`;
const count = Number(process.env.CODESHELL_OUTPUT_PARTS ?? "1");
if (kind === "claude-code") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  record("physical-turn");
  await send({ type: "system", subtype: "init", session_id: "fixture-claude" });
  await send({
    type: "stream_event",
    event: { type: "message_start", message: { id: "message" } },
  });
  for (let index = 0; index < count; index++)
    await send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: part(index) },
      },
    });
  await send({
    type: "result",
    subtype: "success",
    result: "",
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  if (process.env.CODESHELL_OUTPUT_DELAYED_EXIT) {
    record("result-before-exit");
    await new Promise((done) => setTimeout(done, 1000));
  }
} else {
  let turns = 0;
  const input = createInterface({ input: process.stdin });
  input.on("close", () => process.exit(0));
  input.on("line", async (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") return send({ id: request.id, result: {} });
    if (request.method === "thread/start" || request.method === "thread/resume") {
      await send({ id: request.id, result: { thread: { id: "fixture-thread" } } });
      if (process.env.CODESHELL_OUTPUT_DELAYED_TOOL) {
        const flag = process.argv.find((arg) => arg.startsWith("mcp_servers.codeshell_tools.url="));
        const url = JSON.parse(flag.slice(flag.indexOf("=") + 1));
        void fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.CODESHELL_CODEX_MCP_TOKEN}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "DelayedRead",
              arguments: {},
              _meta: { threadId: "codeshell-factory-bound" },
            },
          }),
        })
          .then(async (response) => {
            if (response.status !== 200) throw new Error("fixture MCP refused");
            await response.text();
            record("old-tool-returned");
          })
          .catch(() => {
            record("old-tool-error");
          });
      }
      return;
    }
    if (request.method === "turn/interrupt") {
      await send({ id: request.id, result: {} });
      return send({
        method: "turn/completed",
        params: {
          threadId: "fixture-thread",
          turn: { id: `turn-${turns}`, status: "interrupted" },
        },
      });
    }
    if (request.method !== "turn/start") return;
    const number = ++turns,
      turnId = `turn-${number}`;
    record("physical-turn");
    if (process.env.CODESHELL_OUTPUT_START_ERROR && number === 1) {
      await send({
        id: request.id,
        error: { code: -32000, message: "synthetic turn start failed" },
      });
      setTimeout(() => {
        void send({
          method: "turn/completed",
          params: { threadId: "fixture-thread", turn: { id: turnId, status: "completed" } },
        });
      }, 50);
      return;
    }
    await send({ id: request.id, result: { turn: { id: turnId } } });
    await send({
      method: "turn/started",
      params: { threadId: "fixture-thread", turn: { id: turnId } },
    });
    if (number > 1) {
      await send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "fixture-thread",
          turnId: `turn-${number - 1}`,
          itemId: "late",
          delta: "STALE-OLD-TURN",
        },
      });
      await send({
        method: "turn/completed",
        params: {
          threadId: "fixture-thread",
          turn: { id: `turn-${number - 1}`, status: "completed" },
        },
      });
    }
    if (process.env.CODESHELL_OUTPUT_DELAYED_TOOL)
      await new Promise((resolve) => setTimeout(resolve, 100));
    for (let index = 0; index < count; index++)
      await send({
        method: "item/agentMessage/delta",
        params: { threadId: "fixture-thread", turnId, itemId: "message", delta: part(index) },
      });
    if (process.env.CODESHELL_OUTPUT_PARTIAL_USAGE) {
      for (let repeat = 0; repeat < 2; repeat++)
        await send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "fixture-thread",
            turnId,
            tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } },
          },
        });
    } else {
      await send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "fixture-thread",
          turnId,
          tokenUsage: {
            last: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 4 },
            total: {
              inputTokens: 100 + number * 20,
              outputTokens: 10 + number * 2,
              cachedInputTokens: 20 + number * 4,
            },
          },
        },
      });
    }
    if (process.env.CODESHELL_OUTPUT_HOLD) return;
    await send({
      method: "turn/completed",
      params: { threadId: "fixture-thread", turn: { id: turnId, status: "completed" } },
    });
  });
}
