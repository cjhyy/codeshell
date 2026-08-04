import type { IncomingMessage, ServerResponse } from "node:http";

export type ChatAttachmentKind = "image" | "file" | "audio" | "video";

export type ChannelButtonCapability = "native" | "link";

/**
 * JSON-safe adapter contract shared with the Gateway and Desktop/Pet bridge.
 * Capabilities describe what this implementation actually supports, not every
 * feature offered by the upstream platform.
 */
export interface ChannelCapabilities {
  inbound: {
    text: true;
    attachments: readonly ChatAttachmentKind[];
  };
  outbound: {
    text: true;
    /**
     * Whether the adapter supports an owner-addressed send outside the current
     * reply call. Platform prerequisites may still apply; for example WeChat
     * needs a persisted inbound context token and exposes dynamic readiness in
     * the Desktop status instead of pretending tokenless push is guaranteed.
     */
    proactive: boolean;
    /** Whether send() works on a fresh adapter without run() being active. */
    direct: boolean;
    /** Maximum complete GatewayReply text before transport-safe chunking. */
    maxTextLength?: number;
    /** Native interactive button, or a normal labelled URL rendered in text/markdown. */
    button: ChannelButtonCapability;
    attachments: readonly ChatAttachmentKind[];
    maxAttachments?: number;
    maxAttachmentBytes?: number;
  };
}

const ALL_ATTACHMENT_KINDS = ["image", "file", "audio", "video"] as const;
const TEN_MIB = 10 * 1024 * 1024;

function capabilities(
  button: ChannelButtonCapability,
  inboundAttachments: readonly ChatAttachmentKind[] = [],
  outboundAttachments: readonly ChatAttachmentKind[] = [],
  options: {
    maxTextLength?: number;
    maxAttachmentBytes?: number;
    proactive?: boolean;
    direct?: boolean;
  } = {},
): ChannelCapabilities {
  return {
    inbound: { text: true, attachments: inboundAttachments },
    outbound: {
      text: true,
      proactive: options.proactive ?? true,
      direct: options.direct ?? false,
      maxTextLength: options.maxTextLength ?? 8_000,
      button,
      attachments: outboundAttachments,
      ...(outboundAttachments.length > 0
        ? { maxAttachments: 4, maxAttachmentBytes: options.maxAttachmentBytes ?? TEN_MIB }
        : {}),
    },
  };
}

/** Built-in adapter capability matrix; keep this aligned with adapter send/ingress tests. */
export const BUILTIN_CHANNEL_CAPABILITIES = {
  telegram: capabilities("native", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  discord: capabilities("native", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS),
  slack: capabilities("native", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  lark: capabilities("native", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  dingtalk: capabilities("native"),
  wecom: capabilities("link", ["image", "file", "video"], ALL_ATTACHMENT_KINDS),
  // A fresh adapter can reuse a persisted inbound context_token. Stale tokens
  // are durably evicted; tokenless retry is best-effort, not a protocol promise.
  wechat: capabilities("link", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, {
    direct: true,
  }),
  matrix: capabilities("link", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  mattermost: capabilities("link", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  line: capabilities("native", ALL_ATTACHMENT_KINDS, [], { direct: true }),
  whatsapp: capabilities("native", ALL_ATTACHMENT_KINDS, ALL_ATTACHMENT_KINDS, { direct: true }),
  // Bot Framework supports inline data-URI pictures. General file/audio/video
  // delivery needs a public URL or the Teams file-consent/Graph flow, neither
  // of which this credential shape currently configures.
  teams: capabilities("link", ALL_ATTACHMENT_KINDS, ["image"], {
    maxAttachmentBytes: 1024 * 1024,
  }),
} as const satisfies Readonly<Record<string, ChannelCapabilities>>;

const DEFAULT_CHANNEL_CAPABILITIES = capabilities("link");

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
  /** Materialized outbound media bytes. Adapters may support a bounded subset. */
  attachments?: readonly OutgoingAttachment[];
}

export interface OutgoingAttachment {
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export type ChannelMessageHandler = (message: ChannelMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly channel: string;
  readonly capabilities?: ChannelCapabilities;
  /**
   * True only when one visible platform request atomically publishes both the
   * text and every attachment. Retry coordinators default to separate sends;
   * optimistic combination would duplicate accepted text after a media error.
   */
  readonly combinesTextAndAttachmentsAtomically?: boolean;
  /** @deprecated Use capabilities.outbound.attachments or supportsOutgoingAttachment(). */
  readonly supportsOutgoingAttachments?: boolean;
  run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void>;
  send(target: string, message: OutgoingMessage): Promise<void>;
}

export function channelCapabilities(adapter: ChannelAdapter): ChannelCapabilities {
  if (adapter.capabilities) return adapter.capabilities;
  // Preserve compatibility for third-party adapters built against the old
  // boolean contract. Built-in adapters always publish the granular shape.
  if (adapter.supportsOutgoingAttachments) {
    return capabilities("link", [], ALL_ATTACHMENT_KINDS);
  }
  return DEFAULT_CHANNEL_CAPABILITIES;
}

export function supportsOutgoingAttachment(
  adapter: ChannelAdapter,
  kind: ChatAttachmentKind,
): boolean {
  return channelCapabilities(adapter).outbound.attachments.includes(kind);
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
