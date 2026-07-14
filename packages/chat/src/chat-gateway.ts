import type { ChannelAdapter, ChannelMessage, OutgoingMessage } from "./channel.js";
import { isWebhookChannelAdapter } from "./channel.js";
import {
  DeliveryQueue,
  UnroutableDeliveryError,
  type DeliveryQueueConfig,
} from "./delivery-queue.js";
import { waitForAbort } from "./lifecycle.js";
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
  delivery?: Partial<DeliveryQueueConfig>;
  adapterRestart?: Partial<{ baseMs: number; maxMs: number }>;
  onError?: (error: unknown, message: ChannelMessage) => void;
  onAdapterState?: (state: AdapterRuntimeState) => void;
}

export interface AdapterRuntimeState {
  id: string;
  channel: string;
  state: "starting" | "running" | "backoff" | "stopped";
  attempts: number;
  error?: string;
}

export interface ChatAllowlistRule {
  targetIds: Iterable<string>;
  userIds?: Iterable<string>;
}

const DEFAULT_WEBHOOK_CONFIG: WebhookIngressConfig = {
  host: "127.0.0.1",
  port: 8787,
  maxBodyBytes: 1_048_576,
  healthPath: "/healthz",
  readyPath: "/readyz",
  requestTimeoutMs: 15_000,
};

const DEFAULT_DELIVERY_CONFIG: DeliveryQueueConfig = {
  maxPending: 1_000,
  maxConcurrent: 4,
  maxPerTarget: 1,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  completedTtlMs: 7 * 24 * 60 * 60 * 1_000,
};

/**
 * Transport-agnostic chat runtime. It owns channel lifecycles and webhook ingress,
 * while application behavior is supplied entirely through middleware.
 */
export class ChatGateway {
  private readonly middleware: ChatMiddleware[] = [];
  private readonly adapters: ChannelAdapter[];
  private readonly webhook: WebhookIngressConfig;
  private readonly delivery: DeliveryQueueConfig;
  private readonly adapterRestart: { baseMs: number; maxMs: number };
  private readonly onError: NonNullable<ChatGatewayOptions["onError"]>;
  private readonly onAdapterState?: ChatGatewayOptions["onAdapterState"];
  private readonly adapterStates = new Map<string, AdapterRuntimeState>();
  private queue?: DeliveryQueue;
  private startedAt?: number;

  constructor(options: ChatGatewayOptions) {
    this.adapters = [...options.adapters];
    this.webhook = { ...DEFAULT_WEBHOOK_CONFIG, ...options.webhook };
    this.delivery = { ...DEFAULT_DELIVERY_CONFIG, ...options.delivery };
    this.adapterRestart = {
      baseMs: options.adapterRestart?.baseMs ?? 1_000,
      maxMs: options.adapterRestart?.maxMs ?? 30_000,
    };
    this.onAdapterState = options.onAdapterState;
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
    if (this.startedAt) throw new Error("ChatGateway is already running");
    this.startedAt = Date.now();
    const ownedAbort = new AbortController();
    const stopOwned = () => ownedAbort.abort();
    if (signal.aborted) ownedAbort.abort();
    else signal.addEventListener("abort", stopOwned, { once: true });

    const webhooks: WebhookRegistration[] = [];
    const adapterById = new Map<string, ChannelAdapter>();
    // Key adapters by a per-channel ordinal (channel:0, channel:1, …) rather
    // than the global array index. Delivery-queue records persist this id and
    // are replayed on the next run; a global index would shift when an
    // unrelated channel is removed from config, orphaning durable messages
    // against an id that no longer maps to their adapter.
    const perChannelCount = new Map<string, number>();
    for (const adapter of this.adapters) {
      const ordinal = perChannelCount.get(adapter.channel) ?? 0;
      perChannelCount.set(adapter.channel, ordinal + 1);
      adapterById.set(`${adapter.channel}:${ordinal}`, adapter);
    }
    const queue = new DeliveryQueue(
      this.delivery,
      async (adapterId, message) => {
        const adapter = adapterById.get(adapterId);
        if (!adapter) {
          // A durable record survived a config change that removed its adapter.
          // Signal unroutable so the queue drops it instead of retrying forever.
          throw new UnroutableDeliveryError(`Chat adapter no longer exists: ${adapterId}`);
        }
        await this.dispatch(adapter, message);
      },
      this.onError,
    );
    this.queue = queue;
    await queue.start();

    const runners: Promise<void>[] = [];
    for (const [adapterId, adapter] of adapterById) {
      const handler = (message: ChannelMessage) =>
        queue.enqueue(adapterId, message).then(() => undefined);
      if (isWebhookChannelAdapter(adapter)) webhooks.push({ adapter, handler });
      runners.push(this.superviseAdapter(adapterId, adapter, handler, ownedAbort.signal));
    }
    // Only bind the ingress host:port when a channel actually needs a webhook
    // route. A polling-only config (e.g. Telegram/Discord) must not open an
    // HTTP listener — doing so unexpectedly exposes a port and fails startup
    // outright when that port is already taken.
    if (webhooks.length > 0) {
      runners.push(
        new WebhookIngressServer(this.webhook, webhooks, () => this.healthSnapshot()).run(
          ownedAbort.signal,
        ),
      );
    }
    try {
      await Promise.all(runners);
    } finally {
      ownedAbort.abort();
      queue.stop();
      this.queue = undefined;
      this.startedAt = undefined;
      signal.removeEventListener("abort", stopOwned);
    }
  }

  healthSnapshot(): Record<string, unknown> {
    const adapters = [...this.adapterStates.values()];
    return {
      status: adapters.every(({ state }) => state === "running") ? "ready" : "degraded",
      startedAt: this.startedAt,
      adapters,
      inbox: this.queue?.status() ?? { pending: 0, inFlight: 0, delayed: 0 },
    };
  }

  private async superviseAdapter(
    id: string,
    adapter: ChannelAdapter,
    handler: (message: ChannelMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let attempts = 0;
    while (!signal.aborted) {
      this.setAdapterState({ id, channel: adapter.channel, state: "starting", attempts });
      try {
        this.setAdapterState({ id, channel: adapter.channel, state: "running", attempts });
        await adapter.run(handler, signal);
        if (signal.aborted) break;
        throw new Error("adapter exited unexpectedly");
      } catch (error) {
        if (signal.aborted) break;
        attempts += 1;
        const delay = Math.min(
          this.adapterRestart.maxMs,
          this.adapterRestart.baseMs * 2 ** Math.min(attempts - 1, 10),
        );
        this.setAdapterState({
          id,
          channel: adapter.channel,
          state: "backoff",
          attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await abortableDelay(delay, signal);
      }
    }
    this.setAdapterState({ id, channel: adapter.channel, state: "stopped", attempts });
  }

  private setAdapterState(state: AdapterRuntimeState): void {
    this.adapterStates.set(state.id, state);
    this.onAdapterState?.({ ...state });
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

/** Fixed-window per-sender limiter; rejected messages never reach expensive middleware. */
export function createRateLimitMiddleware(
  maxMessages: number,
  windowMs = 60_000,
  onLimited?: (message: ChannelMessage) => void,
): ChatMiddleware {
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0 || windowMs <= 0) {
    throw new Error("invalid chat rate limit");
  }
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return async ({ message }, next) => {
    const now = Date.now();
    const key = `${message.channel}\0${message.senderId}`;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= maxMessages) {
      onLimited?.(message);
      return;
    }
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (now - value.startedAt >= windowMs) buckets.delete(candidate);
      }
    }
    await next();
  };
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
    waitForAbort(signal),
  ]);
}
