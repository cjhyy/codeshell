import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  statePath?: string;
}

export class TeamsAdapter implements WebhookChannelAdapter {
  readonly channel = "teams";
  readonly webhookPath = "/webhooks/teams";
  private readonly adapter: CloudAdapter;
  private readonly appId: string;
  private readonly contexts = new Map<string, TurnContext>();
  private readonly references = new Map<
    string,
    ReturnType<typeof TurnContext.getConversationReference>
  >();
  private readonly statePath?: string;

  constructor(config: TeamsAdapterConfig) {
    this.appId = config.appId;
    this.statePath = config.statePath;
    const authentication = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppType: config.appType ?? "MultiTenant",
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      ...(config.tenantId ? { MicrosoftAppTenantId: config.tenantId } : {}),
    });
    this.adapter = new CloudAdapter(authentication);
    this.loadReferences();
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
        this.references.set(target, TurnContext.getConversationReference(activity));
        this.saveReferences();
        this.contexts.set(target, context);
        try {
          await handler({
            channel: this.channel,
            target,
            senderId,
            text,
            ...(activity.id ? { messageId: activity.id } : {}),
          });
        } finally {
          this.contexts.delete(target);
        }
      },
    );
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const context = this.contexts.get(target);
    const text = formatOutgoingMarkdown(message.text, message.button);
    if (context) {
      await context.sendActivity(text);
      return;
    }
    const reference = this.references.get(target);
    if (!reference) throw new Error(`Teams 会话 ${target} 尚无 conversation reference`);
    await this.adapter.continueConversationAsync(this.appId, reference, async (turn) => {
      await turn.sendActivity(text);
    });
  }

  private loadReferences(): void {
    if (!this.statePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [target, reference] of Object.entries(parsed as Record<string, unknown>).slice(
        0,
        1_000,
      )) {
        if (target && reference && typeof reference === "object" && !Array.isArray(reference)) {
          this.references.set(
            target,
            reference as ReturnType<typeof TurnContext.getConversationReference>,
          );
        }
      }
    } catch {
      // First run, malformed legacy state, or an unavailable home directory.
    }
  }

  private saveReferences(): void {
    if (!this.statePath) return;
    const entries = [...this.references.entries()].slice(-1_000);
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(entries))}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporary, this.statePath);
    if (process.platform !== "win32") chmodSync(this.statePath, 0o600);
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
