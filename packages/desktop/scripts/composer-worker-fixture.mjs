import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Observe only the owned session on its real worker's stdin, without consuming
 * the stream or starting it before the production stdio transport is ready. */
export function observeComposerWorker({ sessionId, projectPath, origin, ledger }) {
  const record = (row) =>
    appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...row }) + "\n", { mode: 0o600 });
  const decoder = new StringDecoder("utf8");
  const emit = process.stdin.emit;
  let partial = "";
  let marker;
  process.stdin.emit = function (event, ...args) {
    if (event === "data") {
      partial += typeof args[0] === "string" ? args[0] : decoder.write(args[0]);
      const lines = partial.split("\n");
      partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const { method, id, params } = JSON.parse(line);
        if (!["agent/run", "agent/steer", "agent/unsteer", "agent/cancel"].includes(method))
          continue;
        if (params?.sessionId !== sessionId) throw Error("Unexpected composer worker session");
        if (method === "agent/run") {
          marker = params.task?.match(/\[OWNED_([A-Za-z0-9_-]+)\]/)?.[1];
          if (!marker || params.cwd !== projectPath) throw Error("Unexpected composer worker run");
        }
        const { task, text, attachments } = params;
        record({ message: { id, method, params: { sessionId, task, text, attachments } } });
      }
    }
    return emit.call(this, event, ...args);
  };

  const deniedFetch = globalThis.fetch;
  // Node links a Request's derived signal to its caller through a WeakRef.
  // A real fetch owns its in-flight request until completion; our held response must too.
  const heldRequests = new Map();
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== origin + "/v1/chat/completions" || req.method !== "POST" || !marker)
      return deniedFetch(input, init);
    const body = await req.json();
    if (body.model !== "gpt-4o") throw Error("Unexpected composer model");
    const images = body.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "image_url")
            .map((part) => {
              const data = /^data:image\/[a-z]+;base64,(.+)$/.exec(part.image_url?.url ?? "");
              if (!data) throw Error("Composer images must contain fixture bytes");
              return createHash("sha256").update(Buffer.from(data[1], "base64")).digest("hex");
            })
        : [],
    );
    if (body.stream) record({ provider: marker, images });
    if (body.stream && marker.includes("_HOLD_")) {
      const held = marker;
      heldRequests.set(req, input);
      try {
        req.signal.throwIfAborted();
        await new Promise((_, reject) =>
          req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }),
        );
      } finally {
        heldRequests.delete(req);
        if (req.signal.aborted) record({ providerAborted: held });
      }
    }
    const message = { role: "assistant", content: "Owned controlled completion" };
    const response = {
      id: "chatcmpl-owned-composer",
      model: body.model,
      created: 1,
      choices: [{ index: 0, message, finish_reason: "stop" }],
    };
    if (!body.stream) return Response.json({ ...response, object: "chat.completion" });
    const chunk = (delta, finish_reason) =>
      "data: " +
      JSON.stringify({
        ...response,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n";
    return new Response(chunk(message, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  };
}
