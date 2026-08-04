import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  channelCapabilities,
  type ChannelAdapter,
  type ChatAttachmentKind,
  type ChannelCapabilities,
  type OutgoingAttachment,
} from "./channel.js";
import type { GatewayNotificationTarget } from "./config.js";
import type { DesktopEventContext } from "./desktop-control-client.js";
import type { DesktopControlEvent } from "./protocol.js";
import {
  NotificationDeliveryProgress,
  notificationTargetProgressKey,
  type NotificationDeliveryProgressStore,
} from "./notification-progress.js";

// Keep below Discord's 2,000-character content cap as well as Telegram's
// 4,096-character cap. A single conservative relay limit makes every adapter
// safe without letting product events depend on channel-specific truncation.
const MAX_NOTIFICATION_CHUNK_LENGTH = 1_800;
const MAX_NOTIFICATION_TEXT_LENGTH = 100_000;
const MAX_OUTGOING_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const NOTIFICATION_CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const NOTIFICATION_DELIVERY_KEY_RE = /^[a-f0-9]{64}$/u;

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
 * Personal WeChat accepts the adapter's declared 8k text payload as one
 * visible message. Other notification adapters keep the conservative shared
 * limit until their platform-specific limits are represented precisely.
 */
export function splitNotificationTextForChannel(
  text: string,
  channel: string,
  capabilities: ChannelCapabilities,
): string[] {
  const declaredMaximum = capabilities.outbound.maxTextLength;
  const safeDeclaredMaximum =
    Number.isSafeInteger(declaredMaximum) && (declaredMaximum ?? 0) >= 2
      ? declaredMaximum!
      : MAX_NOTIFICATION_CHUNK_LENGTH;
  const maximum =
    channel === "wechat"
      ? safeDeclaredMaximum
      : Math.min(MAX_NOTIFICATION_CHUNK_LENGTH, safeDeclaredMaximum);
  return splitNotificationText(text, maximum);
}

/**
 * Builds an at-least-once Desktop event sender. Successful targets are kept in
 * memory while a failed target is retried, so one unhealthy adapter does not
 * duplicate notifications on the adapters that already accepted the event.
 */
export function createDesktopNotificationHandler(
  adapters: readonly ChannelAdapter[],
  targets: readonly GatewayNotificationTarget[],
  options: {
    progressStore?: NotificationDeliveryProgressStore;
    /** Revalidate current owner authorization immediately before transport. */
    authorizeTarget?: (target: GatewayNotificationTarget) => boolean | Promise<boolean>;
  } = {},
): (event: DesktopControlEvent, context: DesktopEventContext) => Promise<void> {
  const adapterByChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  const progress = new NotificationDeliveryProgress(options.progressStore);
  const configuredTargetKeys = new Set(
    targets.map(({ channel, target }) => `${channel}\0${target}`),
  );
  const authorizeTarget =
    options.authorizeTarget ??
    (({ channel, target }: GatewayNotificationTarget) =>
      configuredTargetKeys.has(`${channel}\0${target}`));

  return async (event, context) => {
    validateDesktopNotificationEvent(event);
    const requestedTargets = event.target ? [event.target] : targets;
    const authorizations = await Promise.all(
      requestedTargets.map((target) => authorizeTarget(target)),
    );
    const eventTargets = requestedTargets.filter((_, index) => authorizations[index] === true);
    // Revoking a target is an owner decision, not a transient transport
    // failure. Treat a fully-revoked event as handled so it cannot block every
    // later outbox event while still guaranteeing no send occurs.
    if (eventTargets.length === 0) return;
    // A semantic key survives Desktop/event-server restarts. Keep the on-disk
    // progress schema compact by using its first 128 bits plus a reserved zero
    // event suffix; the producer supplies a full SHA-256 key.
    const eventKey = event.deliveryKey
      ? `${event.deliveryKey.slice(0, 32)}:0`
      : `${context.streamId}:${event.id}`;
    await progress.begin(eventKey);

    const results = await Promise.allSettled(
      eventTargets.map(async ({ channel, target }) => {
        const targetKey = notificationTargetProgressKey(channel, target);
        const adapter = adapterByChannel.get(channel);
        if (!adapter) throw new Error(`Notification adapter is unavailable: ${channel}`);
        const capabilities = channelCapabilities(adapter);
        const supportedEventAttachments = (event.attachments ?? []).filter((attachment) =>
          capabilities.outbound.attachments.includes(attachment.kind),
        );
        const chunks = splitNotificationTextForChannel(event.text, channel, capabilities);
        let attachmentIndex = Math.min(
          progress.attachmentIndex(eventKey, targetKey),
          supportedEventAttachments.length,
        );
        let combinedAttachments: OutgoingAttachment[] = [];
        let attachmentError: unknown;
        let chunkIndex = progress.chunkIndex(eventKey, targetKey);
        // Only adapters that explicitly guarantee one visible platform request
        // may combine the final text chunk with media. Everyone else sends and
        // checkpoints each attachment independently, so a later media failure
        // cannot repeat already accepted text or earlier attachments.
        const canCombine =
          adapter.combinesTextAndAttachmentsAtomically === true &&
          attachmentIndex === 0 &&
          supportedEventAttachments.length > 0 &&
          chunkIndex < chunks.length;
        if (canCombine) {
          try {
            combinedAttachments = await materializeOutgoingAttachments(supportedEventAttachments);
          } catch (error) {
            attachmentError = error;
          }
        }
        const combineAttachments = combinedAttachments.length > 0;
        while (chunkIndex < chunks.length) {
          const isLast = chunkIndex === chunks.length - 1;
          await adapter.send(target, {
            text: chunks[chunkIndex]!,
            ...(chunkIndex === 0 && event.title ? { title: event.title } : {}),
            ...(isLast && event.button ? { button: event.button } : {}),
            ...(isLast && combineAttachments ? { attachments: combinedAttachments } : {}),
          });
          chunkIndex += 1;
          if (isLast && combineAttachments) {
            attachmentIndex = supportedEventAttachments.length;
          }
          await progress.mark(
            eventKey,
            targetKey,
            chunkIndex,
            isLast && combineAttachments ? attachmentIndex : undefined,
          );
        }
        if (attachmentError) throw attachmentError;
        while (attachmentIndex < supportedEventAttachments.length) {
          const descriptor = supportedEventAttachments[attachmentIndex]!;
          const [attachment] = await materializeOutgoingAttachments([descriptor]);
          if (!attachment) throw new Error("Outgoing attachment could not be materialized");
          await adapter.send(target, { text: "", attachments: [attachment] });
          attachmentIndex += 1;
          await progress.mark(eventKey, targetKey, chunkIndex, attachmentIndex);
        }
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Desktop event ${eventKey} notification failed`);
    }
    await progress.flush();
  };
}

function validateDesktopNotificationEvent(event: DesktopControlEvent): void {
  if (
    typeof event.text !== "string" ||
    !event.text.trim() ||
    event.text.length > MAX_NOTIFICATION_TEXT_LENGTH ||
    NOTIFICATION_CONTROL_CHARACTER_RE.test(event.text) ||
    (event.deliveryKey !== undefined &&
      (typeof event.deliveryKey !== "string" ||
        !NOTIFICATION_DELIVERY_KEY_RE.test(event.deliveryKey))) ||
    (event.title !== undefined &&
      (typeof event.title !== "string" ||
        !event.title.trim() ||
        event.title.length > 256 ||
        NOTIFICATION_CONTROL_CHARACTER_RE.test(event.title))) ||
    (event.target !== undefined &&
      (!event.target ||
        typeof event.target !== "object" ||
        typeof event.target.channel !== "string" ||
        !/^[a-z0-9_-]{1,64}$/u.test(event.target.channel) ||
        typeof event.target.target !== "string" ||
        !event.target.target.trim() ||
        event.target.target.length > 4_096 ||
        NOTIFICATION_CONTROL_CHARACTER_RE.test(event.target.target))) ||
    (event.button !== undefined && !isValidNotificationButton(event.button)) ||
    !Array.isArray(event.attachments ?? []) ||
    (event.attachments?.length ?? 0) > 4 ||
    (event.attachments ?? []).some((attachment) => !isValidAttachmentDescriptor(attachment))
  ) {
    throw new Error("Desktop notification event is invalid");
  }
}

function isValidNotificationButton(button: unknown): button is { text: string; url: string } {
  if (
    !button ||
    typeof button !== "object" ||
    !("text" in button) ||
    !("url" in button) ||
    typeof button.text !== "string" ||
    !button.text.trim() ||
    button.text.length > 256 ||
    NOTIFICATION_CONTROL_CHARACTER_RE.test(button.text) ||
    typeof button.url !== "string" ||
    button.url.length > 2_048
  ) {
    return false;
  }
  try {
    const url = new URL(button.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isValidAttachmentDescriptor(
  attachment: unknown,
): attachment is LocalOutgoingAttachmentDescriptor {
  if (!attachment || typeof attachment !== "object") return false;
  return (
    "kind" in attachment &&
    "path" in attachment &&
    "name" in attachment &&
    "mimeType" in attachment &&
    "size" in attachment &&
    typeof attachment.kind === "string" &&
    ["image", "file", "audio", "video"].includes(attachment.kind) &&
    typeof attachment.path === "string" &&
    isAbsolute(attachment.path) &&
    typeof attachment.name === "string" &&
    Boolean(attachment.name.trim()) &&
    attachment.name.length <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/u.test(attachment.name) &&
    typeof attachment.mimeType === "string" &&
    Boolean(attachment.mimeType.trim()) &&
    attachment.mimeType.length <= 255 &&
    !/[\u0000-\u001f\u007f]/u.test(attachment.mimeType) &&
    (attachment.kind === "image"
      ? attachment.mimeType.startsWith("image/")
      : attachment.kind === "audio"
        ? attachment.mimeType.startsWith("audio/")
        : attachment.kind === "video"
          ? attachment.mimeType.startsWith("video/")
          : true) &&
    typeof attachment.size === "number" &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size >= 1 &&
    attachment.size <= MAX_OUTGOING_ATTACHMENT_BYTES
  );
}

/**
 * Transport-neutral descriptor for one already-authorized host-local file.
 * Path authorization remains a host concern; this layer verifies immutable
 * file metadata before exposing bytes to a channel adapter.
 */
export interface LocalOutgoingAttachmentDescriptor {
  kind: ChatAttachmentKind;
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Read validated host-local attachments from disk into outgoing bytes.
 * Shared by event relays, Mimi replies, and proactive sends; throws when
 * metadata is invalid or the file changed before the transport accepts it.
 */
export async function materializeOutgoingAttachments(
  attachments: readonly LocalOutgoingAttachmentDescriptor[],
): Promise<OutgoingAttachment[]> {
  if (attachments.length > 4) throw new Error("Outgoing attachment metadata is invalid");
  const output: OutgoingAttachment[] = [];
  for (const attachment of attachments) {
    if (!isValidAttachmentDescriptor(attachment)) {
      throw new Error("Outgoing attachment metadata is invalid");
    }
    const data = await readStableOutgoingAttachment(attachment.path, attachment.size);
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

async function readStableOutgoingAttachment(path: string, expectedSize: number): Promise<Buffer> {
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expectedSize) {
        throw new Error("file metadata changed");
      }
      const data = await handle.readFile();
      if (data.byteLength !== expectedSize) throw new Error("file size changed while reading");
      return data;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error("Outgoing attachment changed before delivery", { cause: error });
  }
}

/** @deprecated Use materializeOutgoingAttachments for transport-neutral code. */
export const materializeEventAttachments = materializeOutgoingAttachments;
