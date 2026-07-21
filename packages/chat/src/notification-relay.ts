import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ChannelAdapter, OutgoingAttachment } from "./channel.js";
import type { GatewayNotificationTarget } from "./config.js";
import type { DesktopEventContext } from "./desktop-control-client.js";
import type { DesktopControlEvent } from "./protocol.js";

// Keep below Discord's 2,000-character content cap as well as Telegram's
// 4,096-character cap. A single conservative relay limit makes every adapter
// safe without letting product events depend on channel-specific truncation.
const MAX_NOTIFICATION_CHUNK_LENGTH = 1_800;
const MAX_OUTGOING_IMAGE_BYTES = 10 * 1024 * 1024;

/** Split without breaking UTF-16 surrogate pairs; prefer readable line/word boundaries. */
export function splitNotificationText(
  text: string,
  maximum = MAX_NOTIFICATION_CHUNK_LENGTH,
): string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 2) {
    throw new Error("Notification chunk length must be an integer of at least 2");
  }
  if (text.length <= maximum) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maximum, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
      const minimumReadableBreak = start + Math.floor(maximum * 0.6);
      const newline = text.lastIndexOf("\n", end - 1);
      const space = text.lastIndexOf(" ", end - 1);
      const readableBreak = Math.max(newline, space);
      if (readableBreak >= minimumReadableBreak) end = readableBreak + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Builds an at-least-once Desktop event sender. Successful targets are kept in
 * memory while a failed target is retried, so one unhealthy adapter does not
 * duplicate notifications on the adapters that already accepted the event.
 */
export function createDesktopNotificationHandler(
  adapters: readonly ChannelAdapter[],
  targets: readonly GatewayNotificationTarget[],
): (event: DesktopControlEvent, context: DesktopEventContext) => Promise<void> {
  const adapterByChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  let currentEvent = "";
  let deliveredChunks = new Map<string, number>();
  let deliveredAttachments = new Set<string>();

  return async (event, context) => {
    const eventKey = `${context.streamId}:${event.id}`;
    if (eventKey !== currentEvent) {
      currentEvent = eventKey;
      deliveredChunks = new Map<string, number>();
      deliveredAttachments = new Set<string>();
    }

    const eventTargets = event.target ? [event.target] : targets;
    const results = await Promise.allSettled(
      eventTargets.map(async ({ channel, target }) => {
        const targetKey = `${channel}\0${target}`;
        const adapter = adapterByChannel.get(channel);
        if (!adapter) throw new Error(`Notification adapter is unavailable: ${channel}`);
        const chunks = splitNotificationText(event.text);
        let chunkIndex = deliveredChunks.get(targetKey) ?? 0;
        while (chunkIndex < chunks.length) {
          await adapter.send(target, {
            text: chunks[chunkIndex]!,
            ...(chunkIndex === 0 && event.title ? { title: event.title } : {}),
            ...(chunkIndex === chunks.length - 1 && event.button ? { button: event.button } : {}),
          });
          chunkIndex += 1;
          deliveredChunks.set(targetKey, chunkIndex);
        }
        if (
          event.attachments?.length &&
          adapter.supportsOutgoingAttachments &&
          !deliveredAttachments.has(targetKey)
        ) {
          const attachments = await materializeEventAttachments(event.attachments);
          await adapter.send(target, { text: "", attachments });
          deliveredAttachments.add(targetKey);
        }
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Desktop event ${eventKey} notification failed`);
    }
  };
}

async function materializeEventAttachments(
  attachments: NonNullable<DesktopControlEvent["attachments"]>,
): Promise<OutgoingAttachment[]> {
  const output: OutgoingAttachment[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    if (
      attachment.kind !== "image" ||
      !isAbsolute(attachment.path) ||
      !attachment.mimeType.startsWith("image/") ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 1 ||
      attachment.size > MAX_OUTGOING_IMAGE_BYTES
    ) {
      throw new Error("Desktop completion attachment metadata is invalid");
    }
    const info = await lstat(attachment.path);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== attachment.size) {
      throw new Error("Desktop completion attachment changed before delivery");
    }
    const data = await readFile(attachment.path);
    output.push({
      kind: "image",
      name: attachment.name.slice(0, 255) || "generated-image",
      mimeType: attachment.mimeType,
      data,
    });
  }
  return output;
}
