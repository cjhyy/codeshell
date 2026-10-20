import { redactSecrets } from "../logging/sanitize-messages.js";
import type { ModelTraceContentState } from "./types.js";

const MAX_STRING = 64 * 1024;
const MAX_NODES = 12_000;
const REDACTED = "<redacted>";
const SECRET_KEY =
  /(^|[._-])(api[_-]?key|authorization|x[_-]api[_-]key|bearer[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|client[_-]?secret|cookie)($|[._-])/i;
const HEADERS = /^(httpHeaders|headers|defaultHeaders|envHeaders)$/;

/** Provider-neutral diagnostic clone. Never mutate the actual outbound request. */
export function sanitizeTraceValue(
  value: unknown,
  redactions?: ReadonlyMap<string, string>,
): {
  value: any;
  state: ModelTraceContentState;
} {
  let truncated = false,
    redacted = false,
    nodes = 0;
  let remaining = 256 * 1024;
  const seen = new WeakSet<object>();
  const walk = (input: unknown, depth = 0): unknown => {
    if (++nodes > MAX_NODES || depth > 32) {
      truncated = true;
      return "<truncated>";
    }
    if (typeof input === "string") {
      if (/^data:(image|audio|video|application\/pdf)[^,]*,/i.test(input)) {
        redacted = true;
        return "<media payload omitted>";
      }
      let scrubbed = redactSecrets(input);
      if (/^\s*[{[]/.test(scrubbed) && scrubbed.length <= MAX_STRING) {
        try {
          scrubbed = JSON.stringify(walk(JSON.parse(scrubbed), depth + 1));
        } catch {
          /* Partial streamed JSON still needs secret scalar scrubbing below. */
        }
      }
      // Tool arguments are wire-encoded JSON strings and can fail halfway through a
      // secret value. Scrub such scalars before persisting even malformed partial JSON.
      scrubbed = scrubbed.replace(
        /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*("(?:[^"\\]|\\.)*(?:"|$)|[^,}\]\s]+)/g,
        (match, key: string, scalar: string) => {
          let name = key;
          try {
            name = JSON.parse(`"${key}"`);
          } catch {
            /* Use the literal key. */
          }
          if (!SECRET_KEY.test(name) || /^(null|"")$/.test(scalar)) return match;
          redacted = true;
          return `${JSON.stringify(name)}:${JSON.stringify(REDACTED)}`;
        },
      );
      if (scrubbed !== input) redacted = true;
      const length = Math.min(MAX_STRING, remaining);
      remaining -= Math.min(scrubbed.length, length);
      if (scrubbed.length > length) {
        truncated = true;
        return `${scrubbed.slice(0, length)}\n<truncated>`;
      }
      return scrubbed;
    }
    if (["bigint", "symbol", "function"].includes(typeof input)) return String(input);
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) {
      truncated = true;
      return "<circular>";
    }
    seen.add(input);
    if (Array.isArray(input)) {
      const result = input.slice(0, 2048).map((item) => walk(item, depth + 1));
      if (input.length > 2048) truncated = true;
      seen.delete(input);
      return result;
    }
    const object = input as Record<string, unknown>;
    const callId = object.tool_use_id ?? object.tool_call_id;
    if (
      object.type === "image" ||
      object.type === "image_url" ||
      object.type === "input_image" ||
      (object.type === "base64" && typeof object.data === "string")
    ) {
      redacted = true;
      seen.delete(input);
      return {
        type: object.type,
        media_type: object.media_type ?? (object.source as any)?.media_type,
        omitted: true,
      };
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [name, child] of Object.entries(object)) {
      if (
        typeof callId === "string" &&
        redactions?.has(callId) &&
        ["content", "result", "contentBlocks"].includes(name)
      ) {
        redacted = true;
        result[name] = redactions.get(callId) ?? REDACTED;
      } else if (SECRET_KEY.test(name)) {
        if (child === null || child === undefined || child === "") result[name] = child;
        else {
          redacted = true;
          result[name] = REDACTED;
        }
      } else if (
        HEADERS.test(name) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        redacted = true;
        result[name] = Object.fromEntries(
          Object.entries(child).map(([header, value]) => [
            header,
            value === null || value === undefined || value === "" ? value : REDACTED,
          ]),
        );
      } else if (
        (name === "inline_data" || name === "inlineData") &&
        child &&
        typeof child === "object" &&
        typeof (child as any).data === "string"
      ) {
        redacted = true;
        result[name] = {
          mime_type: (child as any).mime_type ?? (child as any).mimeType,
          omitted: true,
        };
      } else if (name === "b64_json" && typeof child === "string") {
        redacted = true;
        result[name] = "<media payload omitted>";
      } else result[name] = walk(child, depth + 1);
    }
    seen.delete(input);
    return result;
  };
  return {
    value: walk(value),
    state: truncated ? "truncated" : redacted ? "redacted" : "recorded",
  };
}
