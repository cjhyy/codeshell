import type { ChannelAdapter, ChannelMessage, OutgoingMessage } from "./channel.js";
import { isWebhookChannelAdapter } from "./channel.js";
import {
  WebhookIngressServer,
  type WebhookIngressConfig,
  type WebhookRegistration,
} from "./webhook.js";

export interface ChatContext {
  readonly message: ChannelMessage;
  readonly adapter: ChannelAdapter;
  reply(message: OutgoingMessage): Promise<void>;
}

export type ChatMiddleware = (context: ChatContext, next: () => Promise<void>) => Promise<void>;

export interface ChatGatewayOptions {
  adapters: ChannelAdapter[];
  webhook?: Partial<WebhookIngressConfig>;
  onError?: (error: unknown, message: ChannelMessage) => void;
}

export interface ChatAllowlistRule {
  targetIds: Iterable<string>;
  userIds?: Iterable<string>;
}

const DEFAULT_WEBHOOK_CONFIG: WebhookIngressConfig = {
  host: "127.0.0.1",
  port: 8787,
  maxBodyBytes: 1_048_576,
};

/**
 * Transport-agnostic chat runtime. It owns channel lifecycles and webhook ingress,
 * while application behavior is supplied entirely through middleware.
 */
export class ChatGateway {
  private readonly middleware: ChatMiddleware[] = [];
  private readonly adapters: ChannelAdapter[];
  private readonly webhook: WebhookIngressConfig;
  private readonly onError: NonNullable<ChatGatewayOptions["onError"]>;

  constructor(options: ChatGatewayOptions) {
    this.adapters = [...options.adapters];
    this.webhook = { ...DEFAULT_WEBHOOK_CONFIG, ...options.webhook };
    this.onError =
      options.onError ??
      ((error, message) => {
        console.error(
          `[chat] ${message.channel} message failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  use(middleware: ChatMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  async dispatch(adapter: ChannelAdapter, message: ChannelMessage): Promise<void> {
    if (message.channel !== adapter.channel) {
      throw new Error(
        `Adapter ${adapter.channel} emitted a message for channel ${message.channel}`,
      );
    }
    const context: ChatContext = {
      message,
      adapter,
      reply: (outgoing) => adapter.send(message.target, outgoing),
    };
    let index = -1;
    const next = async (position: number): Promise<void> => {
      if (position <= index) throw new Error("Chat middleware called next() more than once");
      index = position;
      const current = this.middleware[position];
      if (current) await current(context, () => next(position + 1));
    };
    await next(0);
  }

  async run(signal: AbortSignal): Promise<void> {
    const webhooks: WebhookRegistration[] = [];
    const runners: Promise<void>[] = [];
    for (const adapter of this.adapters) {
      const handler = (message: ChannelMessage) => this.dispatchSafely(adapter, message);
      if (isWebhookChannelAdapter(adapter)) webhooks.push({ adapter, handler });
      runners.push(adapter.run(handler, signal));
    }
    if (webhooks.length > 0) {
      runners.push(new WebhookIngressServer(this.webhook, webhooks).run(signal));
    }
    await Promise.all(runners);
  }

  private async dispatchSafely(adapter: ChannelAdapter, message: ChannelMessage): Promise<void> {
    try {
      await this.dispatch(adapter, message);
    } catch (error) {
      this.onError(error, message);
    }
  }
}

/** Deny-by-default allowlist middleware for multi-channel gateways. */
export function createAllowlistMiddleware(
  rules: Readonly<Record<string, ChatAllowlistRule>>,
): ChatMiddleware {
  const normalized = new Map(
    Object.entries(rules).map(([channel, rule]) => [
      channel,
      {
        targets: new Set(rule.targetIds),
        users: rule.userIds ? new Set(rule.userIds) : undefined,
      },
    ]),
  );
  return async ({ message }, next) => {
    const rule = normalized.get(message.channel);
    if (!rule?.targets.has(message.target)) return;
    if (rule.users && rule.users.size > 0 && !rule.users.has(message.senderId)) return;
    await next();
  };
}
