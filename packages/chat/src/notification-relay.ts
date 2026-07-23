import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { channelCapabilities, type ChannelAdapter, type OutgoingAttachment } from "./channel.js";
import type { GatewayNotificationTarget } from "./config.js";
import type { DesktopEventContext } from "./desktop-control-client.js";
import type { DesktopControlEvent } from "./protocol.js";

// Keep below Discord's 2,000-character content cap as well as Telegram's
// 4,096-character cap. A single conservative relay limit makes every adapter
// safe without letting product events depend on channel-specific truncation.
const MAX_NOTIFICATION_CHUNK_LENGTH = 1_800;
const MAX_OUTGOING_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
        const capabilities = channelCapabilities(adapter);
        const supportedEventAttachments = (event.attachments ?? []).filter((attachment) =>
          capabilities.outbound.attachments.includes(attachment.kind),
        );
        const chunks = splitNotificationText(event.text);
        // Attachments ride on the final text chunk so a completion receipt is
        // one IM message, not text followed by a bare image. Materialize them
        // up front, but never let a bad file block the text: on failure the
        // chunks still go out and the error is rethrown afterwards.
        const wantsAttachments = Boolean(
          supportedEventAttachments.length > 0 && !deliveredAttachments.has(targetKey),
        );
        let attachments: OutgoingAttachment[] = [];
        let attachmentError: unknown;
        if (wantsAttachments) {
          try {
            attachments = await materializeEventAttachments(supportedEventAttachments);
          } catch (error) {
            attachmentError = error;
          }
        }
        let chunkIndex = deliveredChunks.get(targetKey) ?? 0;
        while (chunkIndex < chunks.length) {
          const isLast = chunkIndex === chunks.length - 1;
          await adapter.send(target, {
            text: chunks[chunkIndex]!,
            ...(chunkIndex === 0 && event.title ? { title: event.title } : {}),
            ...(isLast && event.button ? { button: event.button } : {}),
            ...(isLast && attachments.length > 0 ? { attachments } : {}),
          });
          chunkIndex += 1;
          deliveredChunks.set(targetKey, chunkIndex);
          if (isLast && attachments.length > 0) deliveredAttachments.add(targetKey);
        }
        if (attachmentError) throw attachmentError;
        // Retry path: every chunk already went out on a previous attempt (for
        // example when materialization failed after the text was delivered) —
        // the attachments still owe a standalone delivery.
        if (wantsAttachments && attachments.length > 0 && !deliveredAttachments.has(targetKey)) {
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

/**
 * Read validated host-local attachments from disk into outgoing bytes.
 * Shared by desktop event relay and synchronous Mimi chat replies; throws when
 * metadata is invalid or the file changed between publication and delivery.
 */
export async function materializeEventAttachments(
  attachments: NonNullable<DesktopControlEvent["attachments"]>,
): Promise<OutgoingAttachment[]> {
  const output: OutgoingAttachment[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    if (
      !["image", "file", "audio", "video"].includes(attachment.kind) ||
      !isAbsolute(attachment.path) ||
      (attachment.kind === "image"
        ? !attachment.mimeType.startsWith("image/")
        : attachment.kind === "audio"
          ? !attachment.mimeType.startsWith("audio/")
          : attachment.kind === "video"
            ? !attachment.mimeType.startsWith("video/")
            : !attachment.mimeType.trim()) ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 1 ||
      attachment.size > MAX_OUTGOING_ATTACHMENT_BYTES
    ) {
      throw new Error("Desktop completion attachment metadata is invalid");
    }
    const info = await lstat(attachment.path);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== attachment.size) {
      throw new Error("Desktop completion attachment changed before delivery");
    }
    const data = await readFile(attachment.path);
    output.push({
      kind: attachment.kind,
      name:
        attachment.name.slice(0, 255) ||
        (attachment.kind === "image"
          ? "generated-image"
          : attachment.kind === "audio"
            ? "audio"
            : attachment.kind === "video"
              ? "video"
              : "attachment"),
      mimeType: attachment.mimeType,
      data,
    });
  }
  return output;
}
