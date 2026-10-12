import { createServer } from "node:http";
import { installLocalNetworkGuard } from "../runtime-cost-smoke-isolation.mjs";
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const cancelled = JSON.stringify(body.messages).includes("CANCEL_FIXTURE");
  response.setHeader("content-type", "text/event-stream");
  const begun = Date.now(),
    count = cancelled ? 500 : 150,
    interval = 20;
  for (let index = 0; index < count && !response.destroyed; index++) {
    const remaining = begun + index * interval - Date.now();
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining));
    const text = JSON.stringify({ index, sentAt: Date.now() }) + "\n";
    response.write(
      `data: ${JSON.stringify({ id: "paced", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
  }
  if (!response.destroyed)
    response.end(
      `data: ${JSON.stringify({ id: "paced", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: count, total_tokens: count + 1 } })}\n\ndata: [DONE]\n\n`,
    );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
installLocalNetworkGuard(origin);
process.send({ origin, pid: process.pid });
process.on("disconnect", () => server.close(() => process.exit(0)));
