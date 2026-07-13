import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
} from "botbuilder";
import type { ChannelMessageHandler, OutgoingMessage, WebhookChannelAdapter } from "./channel.js";
import { formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";
import { readRequestBody, sendResponse } from "./webhook.js";

export interface TeamsAdapterConfig {
  appId: string;
  appPassword: string;
  appType?: string;
  tenantId?: string;
}

export class TeamsAdapter implements WebhookChannelAdapter {
  readonly channel = "teams";
  readonly webhookPath = "/webhooks/teams";
  private readonly adapter: CloudAdapter;
  private readonly contexts = new Map<string, TurnContext>();

  constructor(config: TeamsAdapterConfig) {
    const authentication = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppType: config.appType ?? "MultiTenant",
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      ...(config.tenantId ? { MicrosoftAppTenantId: config.tenantId } : {}),
    });
    this.adapter = new CloudAdapter(authentication);
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
    if (request.method !== "POST") {
      sendResponse(response, 405, "Method not allowed");
      return;
    }
    const raw = await readRequestBody(request, maxBodyBytes);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendResponse(response, 400, "Invalid JSON");
      return;
    }
    await this.adapter.process(
      { method: request.method, headers: request.headers, body },
      new BotFrameworkResponse(response),
      async (context) => {
        const activity = context.activity;
        const target = activity.conversation?.id;
        const senderId = activity.from?.id;
        if (activity.type !== ActivityTypes.Message || !target || !senderId || !activity.text)
          return;
        const text = TurnContext.removeRecipientMention(activity).trim() || activity.text;
        this.contexts.set(target, context);
        try {
          await handler({ channel: this.channel, target, senderId, text });
        } finally {
          this.contexts.delete(target);
        }
      },
    );
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const context = this.contexts.get(target);
    if (!context) throw new Error(`Teams 会话 ${target} 已离开当前 turn，无法回复`);
    await context.sendActivity(formatOutgoingMarkdown(message.text, message.button));
  }
}

class BotFrameworkResponse {
  readonly socket: unknown;

  constructor(private readonly response: ServerResponse) {
    this.socket = response.socket;
  }

  status(code: number): this {
    this.response.statusCode = code;
    return this;
  }

  header(name: string, value: unknown): this {
    this.response.setHeader(name, String(value));
    return this;
  }

  send(...args: unknown[]): this {
    const body = args.at(-1);
    if (body !== undefined) {
      this.response.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    return this;
  }

  end(...args: unknown[]): this {
    this.response.end(...(args as []));
    return this;
  }
}
