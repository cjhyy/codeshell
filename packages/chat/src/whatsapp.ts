import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChannelMessageHandler,
  ChatAttachment,
  ChatAttachmentKind,
  OutgoingMessage,
  WebhookChannelAdapter,
} from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { waitForAbort } from "./lifecycle.js";
import {
  downloadRemoteAttachment,
  OutgoingDeliveryTracker,
  outgoingAttachments,
  safeAttachmentName,
} from "./media.js";
import { readRequestBody, sendResponse } from "./webhook.js";

export interface WhatsAppAdapterConfig {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}

interface WhatsAppWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
          image?: WhatsAppMedia;
          audio?: WhatsAppMedia;
          video?: WhatsAppMedia;
          document?: WhatsAppMedia & { filename?: string };
        }>;
      };
    }>;
  }>;
}

interface WhatsAppMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}

export class WhatsAppAdapter implements WebhookChannelAdapter {
  readonly channel = "whatsapp";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.whatsapp;
  readonly webhookPath = "/webhooks/whatsapp";
  private readonly config: Required<WhatsAppAdapterConfig>;
  private readonly delivery = new OutgoingDeliveryTracker();

  constructor(
    config: WhatsAppAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.config = { ...config, apiVersion: config.apiVersion ?? "v25.0" };
  }

  run(_handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    return waitForAbort(signal);
  }

  async handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: ChannelMessageHandler,
    maxBodyBytes: number,
  ): Promise<void> {
    if (request.method === "GET") {
      this.handleVerification(request, response);
      return;
    }
    if (request.method !== "POST") {
      sendResponse(response, 405, "Method not allowed");
      return;
    }
    const raw = await readRequestBody(request, maxBodyBytes);
    if (!verifyMetaSignature(raw, request.headers["x-hub-signature-256"], this.config.appSecret)) {
      sendResponse(response, 401, "Invalid signature");
      return;
    }
    let body: WhatsAppWebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8")) as WhatsAppWebhookBody;
    } catch {
      sendResponse(response, 400, "Invalid JSON");
      return;
    }
    const messages = (body.entry ?? []).flatMap((entry) =>
      (entry.changes ?? []).flatMap((change) =>
        (change.value?.messages ?? []).flatMap((message) => {
          if (!message.from) return [];
          const media = this.inboundMedia(message);
          const text = message.text?.body ?? media?.caption ?? "";
          if (!text && !media?.attachment) return [];
          return [
            {
              channel: this.channel,
              target: message.from,
              senderId: message.from,
              text,
              ...(message.id ? { messageId: message.id } : {}),
              ...(media?.attachment ? { attachments: [media.attachment] } : {}),
            },
          ];
        }),
      ),
    );
    await Promise.all(messages.map((message) => handler(message)));
    sendResponse(response, 200, "OK");
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const attachments = outgoingAttachments(message, this.capabilities.outbound.attachments);
    if (attachments.length > 0) {
      await this.delivery.run(message, async () => {
        const uploaded = await Promise.all(
          attachments.map(async (attachment) => ({
            attachment,
            mediaId: await this.uploadMedia(attachment),
          })),
        );
        let textAssigned = false;
        const steps: Array<() => Promise<void>> = [];
        if (message.button || (message.text && uploaded[0]?.attachment.kind === "audio")) {
          steps.push(() => this.postPayload(this.textPayload(target, message)));
          textAssigned = true;
        }
        for (const [index, item] of uploaded.entries()) {
          const kind = item.attachment.kind === "file" ? "document" : item.attachment.kind;
          const media: Record<string, unknown> = { id: item.mediaId };
          if (!textAssigned && index === 0 && message.text && kind !== "audio") {
            media.caption = message.text;
            textAssigned = true;
          }
          if (kind === "document") media.filename = item.attachment.name;
          const payload = {
            messaging_product: "whatsapp",
            to: target,
            type: kind,
            [kind]: media,
          };
          steps.push(() => this.postPayload(payload));
        }
        if (!textAssigned && message.text) {
          steps.push(() => this.postPayload(this.textPayload(target, message)));
        }
        return steps;
      });
      return;
    }
    await this.postPayload(this.textPayload(target, message));
  }

  private textPayload(target: string, message: OutgoingMessage): Record<string, unknown> {
    const payload = message.button
      ? {
          messaging_product: "whatsapp",
          to: target,
          type: "interactive",
          interactive: {
            type: "cta_url",
            body: { text: message.text },
            action: {
              name: "cta_url",
              parameters: { display_text: message.button.text, url: message.button.url },
            },
          },
        }
      : {
          messaging_product: "whatsapp",
          to: target,
          type: "text",
          text: { body: message.text },
        };
    return payload;
  }

  private async postPayload(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetchFn(
      `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`WhatsApp 发送失败（HTTP ${response.status}）`);
  }

  private async uploadMedia(
    attachment: NonNullable<OutgoingMessage["attachments"]>[number],
  ): Promise<string> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set(
      "file",
      new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }),
      safeAttachmentName(attachment.name),
    );
    const response = await this.fetchFn(
      `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/media`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!response.ok || !body.id) {
      throw new Error(body.error?.message ?? `WhatsApp 媒体上传失败（HTTP ${response.status}）`);
    }
    return body.id;
  }

  private inboundMedia(message: {
    type?: string;
    image?: WhatsAppMedia;
    audio?: WhatsAppMedia;
    video?: WhatsAppMedia;
    document?: WhatsAppMedia & { filename?: string };
  }): { caption?: string; attachment: ChatAttachment } | undefined {
    const kindByType: Record<string, ChatAttachmentKind> = {
      image: "image",
      audio: "audio",
      video: "video",
      document: "file",
    };
    const kind = message.type ? kindByType[message.type] : undefined;
    if (!kind) return undefined;
    const media = message[message.type as "image" | "audio" | "video" | "document"];
    if (!media?.id) return undefined;
    const mediaId = media.id;
    const name = safeAttachmentName(
      "filename" in media ? media.filename : undefined,
      `whatsapp-${mediaId}${kind === "image" ? ".jpg" : kind === "video" ? ".mp4" : ""}`,
    );
    return {
      caption: media.caption,
      attachment: {
        id: mediaId,
        kind,
        name,
        ...(media.mime_type ? { mimeType: media.mime_type } : {}),
        load: (signal) => this.downloadMedia(mediaId, signal),
      },
    };
  }

  private async downloadMedia(mediaId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const metadataResponse = await this.fetchFn(
      `https://graph.facebook.com/${this.config.apiVersion}/${encodeURIComponent(mediaId)}`,
      {
        headers: { authorization: `Bearer ${this.config.accessToken}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    const metadata = (await metadataResponse.json().catch(() => ({}))) as { url?: string };
    if (!metadataResponse.ok || !metadata.url) throw new Error("WhatsApp 媒体下载地址不可用");
    return downloadRemoteAttachment(this.fetchFn, metadata.url, {
      headers: { authorization: `Bearer ${this.config.accessToken}` },
      ...(signal ? { signal } : {}),
    });
  }

  private handleVerification(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      url.searchParams.get("hub.mode") !== "subscribe" ||
      !safeStringEqual(url.searchParams.get("hub.verify_token"), this.config.verifyToken)
    ) {
      sendResponse(response, 403, "Verification failed");
      return;
    }
    sendResponse(response, 200, url.searchParams.get("hub.challenge") ?? "");
  }
}

function verifyMetaSignature(
  body: Buffer,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return safeStringEqual(header.slice(7), expected);
}

function safeStringEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
