import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelMessageHandler, OutgoingMessage, WebhookChannelAdapter } from "./channel.js";
import { waitForAbort } from "./lifecycle.js";
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
        messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
      };
    }>;
  }>;
}

export class WhatsAppAdapter implements WebhookChannelAdapter {
  readonly channel = "whatsapp";
  readonly webhookPath = "/webhooks/whatsapp";
  private readonly config: Required<WhatsAppAdapterConfig>;

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
        (change.value?.messages ?? []).flatMap((message) =>
          message.type === "text" && message.from && message.text?.body
            ? [
                {
                  channel: this.channel,
                  target: message.from,
                  senderId: message.from,
                  text: message.text.body,
                  ...(message.id ? { messageId: message.id } : {}),
                },
              ]
            : [],
        ),
      ),
    );
    await Promise.all(messages.map((message) => handler(message)));
    sendResponse(response, 200, "OK");
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
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
