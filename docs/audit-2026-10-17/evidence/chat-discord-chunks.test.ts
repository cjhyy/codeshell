import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { DiscordAdapter } from "../../../packages/chat/src/discord.ts";
import { ChatGateway } from "../../../packages/chat/src/chat-gateway.ts";
import { createMimiPetChat } from "../../../packages/chat/src/gateway.ts";

test("observation: a normal long slash-command reply edits one Discord response three times", async () => {
  const adapter = new DiscordAdapter({ botToken: "local-fixture-not-a-token" }, {
    commands: [{ name: "help", description: "Local fixture command" }],
  });
  const edits: Array<{ content: string }> = [];
  let visible = "";
  let deleted = 0;
  const interaction = {
    channelId: "dm-local", commandName: "help", id: "interaction-local",
    user: { id: "sender-local" }, channel: { type: ChannelType.DM },
    inGuild: () => false,
    deferReply: async () => undefined,
    editReply: async (payload: { content: string }) => {
      edits.push(payload);
      visible = payload.content; // editReply updates this one original reply.
    },
    deleteReply: async () => { deleted++; },
  };
  // No run(), login(), platform sockets, HTTP or real send is used. The only
  // platform operation reached by the production method is fake editReply.
  (adapter as any).client.channels.fetch = async () => {
    throw new Error("Unexpected local fixture channel fetch");
  };
  const original = "Header " + "x".repeat(4_000);
  const gateway = new ChatGateway({ adapters: [adapter] }).use(createMimiPetChat({
    desktop: { petChat: async () => ({ text: original }) } as any,
  }));
  await (adapter as any).handleInteraction(interaction, (message: any) => gateway.dispatch(adapter, message));
  expect(edits).toHaveLength(3);
  expect(edits.map((payload) => payload.content).join("")).toBe(original);
  expect(visible).toBe(edits.at(-1)!.content);
  expect(visible.length).toBeLessThan(original.length);
  expect(deleted).toBe(0);
  console.log(JSON.stringify({ case: "discord-interaction-long-reply", originalLength: original.length, editLengths: edits.map((payload) => payload.content.length), visibleLength: visible.length, visibleIsLastChunk: true }));
});
