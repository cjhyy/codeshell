import type { IncomingMessage, ServerResponse } from "node:http";

export type ChatAttachmentKind = "image" | "file" | "audio" | "video";

/**
 * Lazy inbound attachment. Adapters expose metadata first; bytes are only
 * fetched after allowlist middleware has accepted the sender.
 */
export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name?: string;
  mimeType?: string;
  size?: number;
  load(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ChannelMessage {
  channel: string;
  target: string;
  senderId: string;
  text: string;
  attachments?: readonly ChatAttachment[];
  messageId?: string;
  threadId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface OutgoingMessage {
  text: string;
  title?: string;
  button?: {
    text: string;
    url: string;
  };
}

export type ChannelMessageHandler = (message: ChannelMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly channel: string;
  run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void>;
  send(target: string, message: OutgoingMessage): Promise<void>;
}

export interface ChatCommandDefinition {
  name: string;
  description: string;
}

export interface WebhookChannelAdapter extends ChannelAdapter {
  readonly webhookPath: string;
  handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: ChannelMessageHandler,
    maxBodyBytes: number,
  ): Promise<void>;
}

export function isWebhookChannelAdapter(adapter: ChannelAdapter): adapter is WebhookChannelAdapter {
  return (
    "webhookPath" in adapter &&
    typeof (adapter as Partial<WebhookChannelAdapter>).webhookPath === "string"
  );
}
