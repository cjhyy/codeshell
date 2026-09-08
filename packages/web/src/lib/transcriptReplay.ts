/**
 * Browser-safe projection of Core's durable TranscriptEvent log into the same
 * stream events used by the live reducer. Keep Node/Electron readers outside
 * this module: the Hub, phone and other browser hosts can share this boundary.
 */
import {
  initialChatState,
  reduceStream,
  type ChatState,
  type UserAttachmentSummary,
} from "./streamReducer.js";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentBlocks(value: unknown): ObjectValue[] {
  return Array.isArray(value)
    ? value.map(object).filter((block): block is ObjectValue => block !== undefined)
    : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return contentBlocks(value)
    .filter((block) => block.type === "text")
    .map((block) => text(block.text))
    .join("");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attachmentName(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "附件";
  // The canonical staging service prefixes a content hash; it is not part of
  // the filename the user selected. Other paths keep their original basename.
  return path.includes(".code-shell/attachments/") ? name.replace(/^[a-f0-9]{16}-/, "") : name;
}

function byteSize(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/** Hide engine attachment plumbing while retaining attachment-only messages. */
export function transcriptUserDisplay(data: ObjectValue): {
  text: string;
  attachments: UserAttachmentSummary[];
} {
  const attachments: UserAttachmentSummary[] = [];
  const imagePaths: string[] = [];
  let raw = textContent(data.content);
  raw = raw.replace(
    /<attached-file\s+path="([^"]*)">\s*([\s\S]*?)<\/attached-file>/g,
    (match, path: string, metadata: string) => {
      if (!/^absolutePath:\s*.+$/m.test(metadata) || !/^origin:\s*.+$/m.test(metadata)) {
        return match;
      }
      const mime = metadata.match(/^mime:\s*(.+)$/m)?.[1]?.trim();
      attachments.push({
        name: attachmentName(unescapeAttribute(path)),
        path: unescapeAttribute(path),
        size: byteSize(metadata.match(/^size:\s*(\d+)\s*$/m)?.[1]),
        ...(mime ? { mime } : {}),
      });
      return "";
    },
  );
  raw = raw.replace(
    /<attached-directory\s+path="([^"]*)"[^>]*>[\s\S]*?<\/attached-directory>/g,
    (_match, path: string) => {
      attachments.push({
        name: `${attachmentName(unescapeAttribute(path))}/`,
        path: unescapeAttribute(path),
        size: 0,
      });
      return "";
    },
  );
  raw = raw.replace(
    /<attached-image-paths>\s*([\s\S]*?)<\/attached-image-paths>\s*(?:\(上面附带的图片在工作区的真实路径[^\n]*\))?/g,
    (_match, paths: string) => {
      imagePaths.push(
        ...paths
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
      );
      return "";
    },
  );
  const imageBlocks = contentBlocks(data.content).filter((block) => block.type === "image");
  for (let index = 0; index < Math.max(imageBlocks.length, imagePaths.length); index++) {
    const source = object(imageBlocks[index]?.source);
    const encoded = text(source?.data).replace(/\s/g, "");
    attachments.push({
      name: imagePaths[index] ? attachmentName(imagePaths[index]) : `图片 ${index + 1}`,
      ...(imagePaths[index] ? { path: imagePaths[index] } : {}),
      size: encoded
        ? Math.max(
            0,
            Math.floor((encoded.length * 3) / 4) - (encoded.match(/=+$/)?.[0].length ?? 0),
          )
        : 0,
      ...(typeof source?.media_type === "string" ? { mime: source.media_type } : {}),
    });
  }
  const explicit = Array.isArray(data.attachments)
    ? data.attachments.flatMap((item) => {
        const attachment = object(item);
        const name = text(attachment?.name) || text(attachment?.originalName);
        return name
          ? [
              {
                name,
                size: byteSize(attachment?.size),
                ...(typeof attachment?.mime === "string" ? { mime: attachment.mime } : {}),
                ...(typeof attachment?.path === "string" ? { path: attachment.path } : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    text: typeof data.displayText === "string" ? data.displayText : raw.trim(),
    attachments: explicit.length ? explicit : attachments,
  };
}

function eventData(event: ObjectValue): ObjectValue {
  return object(event.data) ?? object(event.message) ?? event;
}

/** Durable logs contain both assistant tool_use blocks and dedicated tool_use
 * events. Their tool IDs are identical: emit idempotent starts, never two cards.
 */
export function transcriptToStreamEvents(records: readonly unknown[]): ObjectValue[] {
  const result: ObjectValue[] = [];
  const seenIds = new Set<string>();
  const starts = new Set<string>();
  const knownTools = new Map<string, { name: string; args: ObjectValue }>();
  for (const raw of records) {
    const record = object(raw);
    if (!record) continue;
    const data = eventData(record);
    if (record.type === "tool_use" && text(data.toolCallId)) {
      knownTools.set(text(data.toolCallId), {
        name: text(data.toolName) || "工具",
        args: object(data.args) ?? {},
      });
    }
    for (const block of contentBlocks(data.content)) {
      if (block.type === "tool_use" && text(block.id)) {
        knownTools.set(text(block.id), {
          name: text(block.name) || "工具",
          args: object(block.input) ?? {},
        });
      }
    }
  }
  const startTool = (id: string, name: string, args: ObjectValue, agentId?: string) => {
    if (!id) return;
    if (!starts.has(id)) {
      starts.add(id);
      result.push({
        type: "tool_use_start",
        toolCall: { id, toolName: name || "工具", args },
        ...(agentId ? { agentId } : {}),
      });
    } else {
      result.push({
        type: "tool_use_args_delta",
        toolCallId: id,
        args,
        ...(agentId ? { agentId } : {}),
      });
    }
  };
  const finishTool = (id: string, data: ObjectValue, agentId?: string) => {
    if (!id) return;
    const known = knownTools.get(id);
    if (!starts.has(id))
      startTool(id, known?.name || text(data.toolName) || "工具", known?.args ?? {}, agentId);
    const output =
      typeof data.result === "string"
        ? data.result
        : textContent(data.content ?? data.contentBlocks);
    const error = text(data.error);
    result.push({
      type: "tool_result",
      result: {
        id,
        result: output || error,
        ...(error ? { error } : {}),
        isError: data.isError === true || data.is_error === true || !!error,
      },
      ...(agentId ? { agentId } : {}),
    });
  };
  for (const raw of records) {
    const record = object(raw);
    if (!record) continue;
    const id = text(record.id);
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const data = eventData(record);
    const agentId = text(data.agentId) || undefined;
    const type =
      typeof record.type === "string"
        ? record.type
        : typeof data.role === "string"
          ? "message"
          : "";
    switch (type) {
      case "message": {
        const blocks = contentBlocks(data.content);
        if (data.role === "user") {
          if (
            data.injected === true ||
            data.authority === "agent" ||
            data.authority === "system" ||
            data.authority === "policy"
          )
            break;
          const display = transcriptUserDisplay(data);
          if (display.text.startsWith("<system-reminder>")) break;
          if (display.text || display.attachments.length) {
            result.push({
              type: "user_message",
              ...display,
              ...(typeof data.clientMessageId === "string"
                ? { clientMessageId: data.clientMessageId }
                : {}),
            });
          }
          for (const block of blocks) {
            if (block.type === "tool_result") finishTool(text(block.tool_use_id), block, agentId);
          }
        } else if (data.role === "assistant") {
          const body = textContent(data.content);
          const reasoning = blocks
            .filter((block) => block.type === "reasoning")
            .map((block) => text(block.reasoningContent) || text(block.text))
            .join("");
          if (body || reasoning) {
            const scope = agentId ? { agentId } : {};
            result.push({ type: "stream_request_start", ...scope });
            if (reasoning) result.push({ type: "thinking_delta", text: reasoning, ...scope });
            if (body) result.push({ type: "text_delta", text: body, ...scope });
            result.push({ type: "assistant_message", ...scope });
          }
          for (const block of blocks) {
            if (block.type === "tool_use")
              startTool(text(block.id), text(block.name), object(block.input) ?? {}, agentId);
          }
        } else if (data.role === "tool") {
          finishTool(text(data.tool_call_id), data, agentId);
        }
        break;
      }
      case "tool_use":
        startTool(text(data.toolCallId), text(data.toolName), object(data.args) ?? {}, agentId);
        break;
      case "tool_result":
        finishTool(text(data.toolCallId), data, agentId);
        break;
      case "subagent":
        if (agentId)
          result.push({
            type: "agent_start",
            agentId,
            name: text(data.name),
            description: text(data.description),
            status: "recorded",
          });
        break;
      case "error":
        if (text(data.error)) result.push({ type: "error", error: data.error });
        break;
      case "turn_stopped":
        result.push({ type: "turn_complete", reason: "aborted_tools" });
        break;
      case "session_meta":
        if (text(data.sessionId))
          result.push({ type: "session_started", sessionId: data.sessionId });
        break;
      // turn_boundary marks the START of a loop, and checkpoint/summary logs
      // are model context maintenance. They are not user-visible messages.
    }
  }
  return result;
}

export function replayTranscript(records: readonly unknown[]): ChatState {
  let state = initialChatState();
  for (const event of transcriptToStreamEvents(records)) state = reduceStream(state, event);
  // A durable snapshot cannot establish liveness. The authenticated host owns
  // running state; leave incomplete tools visible but never spin from old logs.
  return { ...state, run: state.run === "error" ? "error" : "idle", liveByAgent: {} };
}
