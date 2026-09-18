import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A cancelled scenario may never consume its gate promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

export function normalizeUsage(usage) {
  if (!usage) return null;
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    inputTokens: number(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: number(usage.total_tokens),
    costUsd: number(usage.cost),
  };
}

export function redact(value, secrets = []) {
  const replace = (text) =>
    secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join("[REDACTED]"), text);
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|access[_-]?token|password|secret)$/i.test(key)
          ? "[REDACTED]"
          : redact(item, secrets),
      ]),
    );
  return value;
}

/** A real upstream transport. The only response intervention is a recorded
 * pause AFTER actual text has been delivered, to exercise reload/stop races. */
export async function createProviderProxy({ model, budget = {}, fetchImpl = fetch }) {
  const limits = {
    maxRequests: 30,
    maxOutputTokens: 2048,
    maxRequestBytes: 2_000_000,
    maxResponseBytes: 2_000_000,
    requestTimeoutMs: 120_000,
    maxReportedCostUsd: 3,
    ...budget,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid budget ${name}`);
  }
  const requests = [];
  const controllers = new Set();
  const apiKey = randomUUID();
  const secrets = [model.apiKey, apiKey];
  let pendingGate;
  let lastGate;
  let closed = false;
  const gates = new Set();
  const safe = (value) => redact(value, secrets);
  const server = createServer(async (req, res) => {
    const reject = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "eval_transport" } }));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return reject(401, "Eval token required");
    if (req.method !== "POST" || req.url !== "/v1/chat/completions")
      return reject(404, "Unsupported eval route");
    const knownCost = requests.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0);
    if (closed || requests.length >= limits.maxRequests || knownCost >= limits.maxReportedCostUsd) {
      return reject(429, "Eval request or reported-cost budget exhausted");
    }
    // Reserve before reading/fetching so concurrent auxiliary calls count too.
    const record = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finished: false,
      aborted: false,
      usage: null,
      status: null,
      text: "",
      responseModels: [],
      faultInjection: null,
      captureTruncated: false,
    };
    requests.push(record);
    const controller = new AbortController();
    controllers.add(controller);
    let gate;
    const timer = setTimeout(() => {
      record.error = "request_timeout";
      controller.abort();
    }, limits.requestTimeoutMs);
    controller.signal.addEventListener(
      "abort",
      () => {
        record.aborted = true;
        gate?.release.resolve();
        gate?.held.reject(new Error(record.error ?? "request_aborted"));
        res.destroy();
      },
      { once: true },
    );
    const disconnect = () => {
      if (!res.writableEnded) {
        record.aborted = true;
        controller.abort();
        gate?.release.resolve();
      }
    };
    res.on("close", disconnect);
    req.on("aborted", disconnect);
    const socket = req.socket;
    socket?.on("close", disconnect);
    try {
      const chunks = [];
      let requestBytes = 0;
      for await (const chunk of req) {
        requestBytes += chunk.length;
        if (requestBytes > limits.maxRequestBytes) throw new Error("request_capture_limit");
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      if (body.model !== model.model) throw new Error("unexpected_model");
      record.stream = body.stream === true;
      record.streamed = record.stream;
      record.requestedBody = safe(body);
      const tokenField =
        body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
      body[tokenField] = Math.min(
        Number(body[tokenField]) || limits.maxOutputTokens,
        limits.maxOutputTokens,
      );
      if (tokenField === "max_completion_tokens") delete body.max_tokens;
      record.body = safe(body);
      record.outputTokenCap = body[tokenField];
      if (record.stream && pendingGate) {
        gate = pendingGate;
        pendingGate = undefined;
        gate.requestId = record.id;
      }
      const upstream = await fetchImpl(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      record.status = upstream.status;
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-cache" });
      res.flushHeaders();
      let responseBytes = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      let textChars = 0;
      record.events = [];
      const observe = (event) => {
        if (event.model && !record.responseModels.includes(event.model))
          record.responseModels.push(event.model);
        if (event.usage) record.usage = normalizeUsage(event.usage);
        const text = (event.choices ?? [])
          .map((choice) => choice.delta?.content ?? choice.message?.content ?? "")
          .join("");
        if (typeof text === "string") {
          record.text += safe(text);
          textChars += text.length;
        }
        record.events.push(safe(event));
      };
      const emit = async (frame) => {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            observe(JSON.parse(payload));
          } catch {
            record.unparsedEvent = true;
          }
        }
        if (controller.signal.aborted) return;
        res.write(frame);
        if (gate && !gate.hit && textChars >= gate.minTextChars) {
          gate.hit = true;
          record.faultInjection = {
            kind: "pause_after_real_text",
            deliveredTextChars: textChars,
            startedAt: new Date().toISOString(),
          };
          gate.held.resolve({
            requestId: record.id,
            deliveredText: record.text,
            deliveredTextChars: textChars,
          });
          await gate.release.promise;
          record.faultInjection.releasedAt = new Date().toISOString();
        }
      };
      for await (const bytes of upstream.body) {
        responseBytes += bytes.length;
        if (responseBytes > limits.maxResponseBytes) {
          record.captureTruncated = true;
          throw new Error("response_capture_limit");
        }
        buffer += decoder.decode(bytes, { stream: true });
        if (contentType.includes("text/event-stream")) {
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const end = match.index + match[0].length;
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end);
            await emit(frame);
          }
        }
        if (controller.signal.aborted) break;
      }
      buffer += decoder.decode();
      if (buffer && !controller.signal.aborted) {
        if (contentType.includes("text/event-stream")) await emit(buffer);
        else {
          try {
            observe(JSON.parse(buffer));
          } catch {
            record.responseBody = safe(buffer);
          }
          res.write(buffer);
        }
      }
      record.finished = !controller.signal.aborted;
      if (gate && !gate.hit)
        gate.held.reject(new Error("No sufficient real text before request ended"));
      res.end();
    } catch (error) {
      record.error ??= controller.signal.aborted ? "request_aborted" : safe(String(error.message));
      record.aborted ||= controller.signal.aborted;
      gate?.held.reject(new Error(record.error));
      if (!res.headersSent) reject(502, record.error);
      else res.destroy();
    } finally {
      clearTimeout(timer);
      socket?.off("close", disconnect);
      req.off("aborted", disconnect);
      controllers.delete(controller);
      gate?.release.resolve();
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey,
    requests,
    limits,
    holdNextText({ minTextChars = 1 } = {}) {
      if (pendingGate) throw new Error("A text gate is already armed");
      if (!Number.isInteger(minTextChars) || minTextChars < 1)
        throw new Error("Invalid text gate threshold");
      const gate = {
        id: randomUUID(),
        minTextChars,
        held: deferred(),
        release: deferred(),
        hit: false,
      };
      pendingGate = gate;
      lastGate = gate;
      gates.add(gate);
      return gate;
    },
    async waitForHold(ticket = lastGate, { timeoutMs = limits.requestTimeoutMs } = {}) {
      if (!ticket) throw new Error("No text gate armed");
      let timer;
      try {
        return await Promise.race([
          ticket.held.promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Real text gate timed out")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release(ticket = lastGate) {
      ticket?.release.resolve();
      if (pendingGate === ticket) {
        pendingGate = undefined;
        ticket?.held.reject(new Error("Text gate cancelled"));
      }
    },
    async close() {
      closed = true;
      for (const gate of gates) {
        gate.release.resolve();
        gate.held.reject(new Error("Proxy closed"));
      }
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
