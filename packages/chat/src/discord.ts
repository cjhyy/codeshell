import { AsyncLocalStorage } from "node:async_hooks";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import type {
  ChannelAdapter,
  ChannelMessageHandler,
  ChatCommandDefinition,
  OutgoingMessage,
} from "./channel.js";
import { dispatchSafely, waitForAbort } from "./lifecycle.js";

export interface DiscordAdapterConfig {
  botToken: string;
}

export interface DiscordAdapterOptions {
  commands?: readonly ChatCommandDefinition[];
}

export class DiscordAdapter implements ChannelAdapter {
  readonly channel = "discord";
  private readonly client: Client;
  private readonly interactionContext = new AsyncLocalStorage<{
    interaction: ChatInputCommandInteraction;
    replied: boolean;
  }>();
  private readonly commands: readonly ChatCommandDefinition[];

  constructor(
    private readonly config: DiscordAdapterConfig,
    options: DiscordAdapterOptions = {},
  ) {
    this.commands = options.commands ?? [];
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async run(handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    const onMessage = (message: Message) => {
      if (message.author.bot || !message.content) return;
      void dispatchSafely(handler, {
        channel: this.channel,
        target: message.channelId,
        senderId: message.author.id,
        text: message.content,
        messageId: message.id,
      });
    };
    const onInteraction = (interaction: Interaction) => {
      if (!interaction.isChatInputCommand() || !interaction.channelId) return;
      if (!this.commands.some(({ name }) => name === interaction.commandName)) return;
      void this.handleInteraction(interaction, handler);
    };
    this.client.on(Events.MessageCreate, onMessage);
    this.client.on(Events.InteractionCreate, onInteraction);
    await this.client.login(this.config.botToken);
    if (this.commands.length > 0) await this.registerCommands();
    try {
      await waitForAbort(signal);
    } finally {
      this.client.off(Events.MessageCreate, onMessage);
      this.client.off(Events.InteractionCreate, onInteraction);
      this.client.destroy();
    }
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const payload = toDiscordPayload(message);
    const interactionState = this.interactionContext.getStore();
    if (interactionState?.interaction.channelId === target) {
      interactionState.replied = true;
      await interactionState.interaction.editReply(payload);
      return;
    }
    const channel = await this.client.channels.fetch(target);
    if (!channel || channel.type === ChannelType.GuildCategory || !channel.isSendable()) {
      throw new Error(`Discord channel ${target} 不支持发送消息`);
    }
    await channel.send(payload);
  }

  private async handleInteraction(
    interaction: ChatInputCommandInteraction,
    handler: ChannelMessageHandler,
  ): Promise<void> {
    const target = interaction.channelId;
    await interaction.deferReply({ ephemeral: interaction.inGuild() });
    const state = { interaction, replied: false };
    await this.interactionContext.run(state, () =>
      dispatchSafely(handler, {
        channel: this.channel,
        target,
        senderId: interaction.user.id,
        text: `/${interaction.commandName}`,
        messageId: interaction.id,
      }),
    );
    if (!state.replied) await interaction.deleteReply().catch(() => undefined);
  }

  private async registerCommands(): Promise<void> {
    const commands = this.client.application?.commands;
    if (!commands) throw new Error("Discord application command manager 不可用");
    const existing = await commands.fetch();
    for (const command of this.commands) {
      if (!existing.some(({ name }) => name === command.name)) await commands.create(command);
    }
  }
}

function toDiscordPayload(message: OutgoingMessage): {
  content: string;
  components?: Array<ActionRowBuilder<ButtonBuilder>>;
} {
  return {
    content: message.text,
    ...(message.button
      ? {
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(message.button.text)
                .setURL(message.button.url),
            ),
          ],
        }
      : {}),
  };
}
