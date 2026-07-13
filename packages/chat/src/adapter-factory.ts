import type { ChannelAdapter, ChatCommandDefinition } from "./channel.js";
import type { ConfiguredChannel } from "./config.js";
import { DingTalkAdapter } from "./dingtalk.js";
import { DiscordAdapter } from "./discord.js";
import { LarkAdapter } from "./lark.js";
import { LineAdapter } from "./line.js";
import { MattermostAdapter } from "./mattermost.js";
import { MatrixAdapter } from "./matrix.js";
import { SlackAdapter } from "./slack.js";
import { TelegramAdapter } from "./telegram.js";
import { TeamsAdapter } from "./teams.js";
import { WeComAdapter } from "./wecom.js";
import { WechatAdapter } from "./wechat.js";
import { FileWechatStateStore } from "./wechat-storage.js";
import { WhatsAppAdapter } from "./whatsapp.js";

export interface ChannelAdapterFactoryOptions {
  discordCommands?: readonly ChatCommandDefinition[];
}

export function createChannelAdapter(
  config: ConfiguredChannel,
  options: ChannelAdapterFactoryOptions = {},
): ChannelAdapter {
  switch (config.channel) {
    case "telegram":
      return new TelegramAdapter(config, {
        log: (message) => console.error(`[chat] ${message}`),
      });
    case "discord":
      return new DiscordAdapter(config, { commands: options.discordCommands });
    case "slack":
      return new SlackAdapter(config);
    case "lark":
      return new LarkAdapter(config);
    case "dingtalk":
      return new DingTalkAdapter(config);
    case "wecom":
      return new WeComAdapter(config);
    case "wechat":
      return new WechatAdapter(config, {
        stateStore: new FileWechatStateStore(config.statePath),
        log: (message) => console.error(`[chat] ${message}`),
      });
    case "matrix":
      return new MatrixAdapter(config);
    case "mattermost":
      return new MattermostAdapter(config);
    case "line":
      return new LineAdapter(config);
    case "whatsapp":
      return new WhatsAppAdapter(config);
    case "teams":
      return new TeamsAdapter(config);
  }
}
