import type { ImGatewayChannel } from "../preload/types";

export const IM_GATEWAY_CHANNEL_NAMES: Record<ImGatewayChannel, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  lark: "飞书 / Lark",
  dingtalk: "钉钉",
  wecom: "企业微信",
  wechat: "个人微信",
  matrix: "Matrix",
  mattermost: "Mattermost",
  line: "LINE",
  whatsapp: "WhatsApp",
  teams: "Microsoft Teams",
};

const CHANNELS = new Set<ImGatewayChannel>(
  Object.keys(IM_GATEWAY_CHANNEL_NAMES) as ImGatewayChannel[],
);

/** Extract the source channel from the stable `im:<channel>:<message>` submit id. */
export function imGatewayChannelFromClientMessageId(
  clientMessageId: string | undefined,
): ImGatewayChannel | undefined {
  if (!clientMessageId?.startsWith("im:")) return undefined;
  const channel = clientMessageId.split(":", 3)[1] as ImGatewayChannel | undefined;
  return channel && CHANNELS.has(channel) ? channel : undefined;
}
