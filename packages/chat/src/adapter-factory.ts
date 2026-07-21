import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isWebhookChannelAdapter,
  type ChannelAdapter,
  type ChannelMessageHandler,
  type ChatCommandDefinition,
  type OutgoingMessage,
  type WebhookChannelAdapter,
} from "./channel.js";
import type { ConfiguredChannel } from "./config.js";

type ChannelName = ConfiguredChannel["channel"];

export type ChannelAdapterModuleLoader = (channel: ChannelName) => Promise<unknown>;

export interface ChannelAdapterFactoryOptions {
  discordCommands?: readonly ChatCommandDefinition[];
  /**
   * Advanced module-resolution seam for custom hosts and tests. The default
   * loader dynamically imports only the selected channel module.
   */
  moduleLoader?: ChannelAdapterModuleLoader;
}

const WEBHOOK_PATHS: Partial<Record<ChannelName, string>> = {
  line: "/webhooks/line",
  whatsapp: "/webhooks/whatsapp",
  teams: "/webhooks/teams",
};

const ADAPTER_DEPENDENCY_HINTS: Partial<Record<ChannelName, string>> = {
  discord: "discord.js",
  slack: "@slack/socket-mode and @slack/web-api",
  lark: "@larksuiteoapi/node-sdk",
  dingtalk: "dingtalk-stream",
  wecom: "@wecom/aibot-node-sdk",
  mattermost: "ws",
  teams: "botbuilder",
};

export class ChannelAdapterLoadError extends Error {
  readonly code = "CHAT_ADAPTER_LOAD_FAILED";

  constructor(
    readonly channel: ChannelName,
    cause: unknown,
  ) {
    const dependency = ADAPTER_DEPENDENCY_HINTS[channel];
    const recovery = dependency
      ? `The default @cjhyy/code-shell-chat installation includes ${dependency}; reinstall the package or add the missing dependency.`
      : "Reinstall @cjhyy/code-shell-chat if its adapter files are incomplete.";
    const detail =
      cause instanceof Error && cause.message.trim() ? ` Cause: ${cause.message.trim()}` : "";
    super(`Failed to load chat adapter "${channel}". ${recovery}${detail}`, { cause });
    this.name = "ChannelAdapterLoadError";
  }
}

/**
 * Load and construct exactly one configured adapter. CLI and host applications
 * should prefer this entry so constructor/configuration failures happen during
 * startup instead of on the first message.
 */
export async function createChannelAdapterAsync(
  config: ConfiguredChannel,
  options: ChannelAdapterFactoryOptions = {},
): Promise<ChannelAdapter> {
  const loaded = await loadChannelAdapterModule(config.channel, options.moduleLoader);
  return instantiateChannelAdapter(config, loaded, options);
}

/**
 * Backwards-compatible synchronous entry. It returns a lightweight proxy and
 * loads only the selected adapter on the first run/send/webhook operation.
 * New hosts should prefer createChannelAdapterAsync().
 */
export function createChannelAdapter(
  config: ConfiguredChannel,
  options: ChannelAdapterFactoryOptions = {},
): ChannelAdapter {
  const load = () => createChannelAdapterAsync(config, options);
  const webhookPath = WEBHOOK_PATHS[config.channel];
  return webhookPath
    ? new LazyWebhookChannelAdapter(config.channel, webhookPath, load)
    : new LazyChannelAdapter(config.channel, load);
}

async function loadChannelAdapterModule(
  channel: ChannelName,
  moduleLoader: ChannelAdapterModuleLoader = loadDefaultChannelAdapterModule,
): Promise<unknown> {
  try {
    return await moduleLoader(channel);
  } catch (error) {
    if (error instanceof ChannelAdapterLoadError) throw error;
    throw new ChannelAdapterLoadError(channel, error);
  }
}

async function loadDefaultChannelAdapterModule(channel: ChannelName): Promise<object> {
  switch (channel) {
    case "telegram":
      return import("./telegram.js");
    case "discord":
      return import("./discord.js");
    case "slack":
      return import("./slack.js");
    case "lark":
      return import("./lark.js");
    case "dingtalk":
      return import("./dingtalk.js");
    case "wecom":
      return import("./wecom.js");
    case "wechat": {
      const [{ WechatAdapter }, { FileWechatStateStore }] = await Promise.all([
        import("./wechat.js"),
        import("./wechat-storage.js"),
      ]);
      return { WechatAdapter, FileWechatStateStore };
    }
    case "matrix":
      return import("./matrix.js");
    case "mattermost":
      return import("./mattermost.js");
    case "line":
      return import("./line.js");
    case "whatsapp":
      return import("./whatsapp.js");
    case "teams":
      return import("./teams.js");
  }
}

function instantiateChannelAdapter(
  config: ConfiguredChannel,
  loaded: unknown,
  options: ChannelAdapterFactoryOptions,
): ChannelAdapter {
  switch (config.channel) {
    case "telegram": {
      const TelegramAdapter = readModuleExport<typeof import("./telegram.js").TelegramAdapter>(
        loaded,
        config.channel,
        "TelegramAdapter",
      );
      return new TelegramAdapter(config, {
        log: (message) => console.error(`[chat] ${message}`),
      });
    }
    case "discord": {
      const DiscordAdapter = readModuleExport<typeof import("./discord.js").DiscordAdapter>(
        loaded,
        config.channel,
        "DiscordAdapter",
      );
      return new DiscordAdapter(config, { commands: options.discordCommands });
    }
    case "slack": {
      const SlackAdapter = readModuleExport<typeof import("./slack.js").SlackAdapter>(
        loaded,
        config.channel,
        "SlackAdapter",
      );
      return new SlackAdapter(config);
    }
    case "lark": {
      const LarkAdapter = readModuleExport<typeof import("./lark.js").LarkAdapter>(
        loaded,
        config.channel,
        "LarkAdapter",
      );
      return new LarkAdapter(config);
    }
    case "dingtalk": {
      const DingTalkAdapter = readModuleExport<typeof import("./dingtalk.js").DingTalkAdapter>(
        loaded,
        config.channel,
        "DingTalkAdapter",
      );
      return new DingTalkAdapter(config);
    }
    case "wecom": {
      const WeComAdapter = readModuleExport<typeof import("./wecom.js").WeComAdapter>(
        loaded,
        config.channel,
        "WeComAdapter",
      );
      return new WeComAdapter(config);
    }
    case "wechat": {
      const WechatAdapter = readModuleExport<typeof import("./wechat.js").WechatAdapter>(
        loaded,
        config.channel,
        "WechatAdapter",
      );
      const FileWechatStateStore = readModuleExport<
        typeof import("./wechat-storage.js").FileWechatStateStore
      >(loaded, config.channel, "FileWechatStateStore");
      return new WechatAdapter(config, {
        stateStore: new FileWechatStateStore(config.statePath),
        log: (message) => console.error(`[chat] ${message}`),
      });
    }
    case "matrix": {
      const MatrixAdapter = readModuleExport<typeof import("./matrix.js").MatrixAdapter>(
        loaded,
        config.channel,
        "MatrixAdapter",
      );
      return new MatrixAdapter(config);
    }
    case "mattermost": {
      const MattermostAdapter = readModuleExport<
        typeof import("./mattermost.js").MattermostAdapter
      >(loaded, config.channel, "MattermostAdapter");
      return new MattermostAdapter(config);
    }
    case "line": {
      const LineAdapter = readModuleExport<typeof import("./line.js").LineAdapter>(
        loaded,
        config.channel,
        "LineAdapter",
      );
      return new LineAdapter(config);
    }
    case "whatsapp": {
      const WhatsAppAdapter = readModuleExport<typeof import("./whatsapp.js").WhatsAppAdapter>(
        loaded,
        config.channel,
        "WhatsAppAdapter",
      );
      return new WhatsAppAdapter(config);
    }
    case "teams": {
      const TeamsAdapter = readModuleExport<typeof import("./teams.js").TeamsAdapter>(
        loaded,
        config.channel,
        "TeamsAdapter",
      );
      return new TeamsAdapter(config);
    }
  }
}

function readModuleExport<T>(loaded: unknown, channel: ChannelName, exportName: string): T {
  const value =
    loaded && typeof loaded === "object"
      ? (loaded as Readonly<Record<string, unknown>>)[exportName]
      : undefined;
  if (typeof value !== "function") {
    throw new Error(`Chat adapter module "${channel}" does not export ${exportName}`);
  }
  return value as T;
}

class LazyChannelAdapter implements ChannelAdapter {
  private adapterPromise?: Promise<ChannelAdapter>;
  readonly supportsOutgoingAttachments: boolean;

  constructor(
    readonly channel: string,
    private readonly loader: () => Promise<ChannelAdapter>,
  ) {
    this.supportsOutgoingAttachments = channel === "telegram" || channel === "wechat";
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const adapter = await this.load();
    return adapter.run(handler, signal);
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const adapter = await this.load();
    return adapter.send(target, message);
  }

  protected load(): Promise<ChannelAdapter> {
    this.adapterPromise ??= this.loader();
    return this.adapterPromise;
  }
}

class LazyWebhookChannelAdapter extends LazyChannelAdapter implements WebhookChannelAdapter {
  constructor(
    channel: string,
    readonly webhookPath: string,
    loader: () => Promise<ChannelAdapter>,
  ) {
    super(channel, loader);
  }

  async handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: ChannelMessageHandler,
    maxBodyBytes: number,
  ): Promise<void> {
    const adapter = await this.load();
    if (!isWebhookChannelAdapter(adapter)) {
      throw new Error(`Loaded chat adapter "${this.channel}" does not implement webhook ingress`);
    }
    return adapter.handleWebhook(request, response, handler, maxBodyBytes);
  }
}
