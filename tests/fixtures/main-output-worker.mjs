import { createInterface } from "node:readline";
import { installLocalNetworkGuard } from "../../scripts/runtime-cost-smoke-isolation.mjs";
installLocalNetworkGuard("http://127.0.0.1:1");
const { SessionOutputPublisher } = await import("../../packages/core/dist/index.internal.js");
const publisher = new SessionOutputPublisher(() => process.env.MAIN_OUTPUT_ROOT, "protocol");
const sessionId = process.env.MAIN_OUTPUT_SESSION;
const held = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "hold") {
    const event = publisher.project(sessionId, { type: "text_delta", text: request.params.text });
    held.push(event);
    // This is a genuine RPC response after commit, before the notification.
    // A response fence alone must never imply event.outputCursor was applied.
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { cursor: event.outputCursor, pid: process.pid },
    });
  } else if (request.method === "release") {
    for (const event of held.splice(0))
      send({ jsonrpc: "2.0", method: "agent/streamEvent", params: { sessionId, event } });
    send({ jsonrpc: "2.0", id: request.id, result: { released: true } });
  }
}
