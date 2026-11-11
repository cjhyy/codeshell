/** Per-channel setup facts and status presentation for the IM Chat Gateway. */
import type { TFunction } from "../i18n/I18nProvider";
import type {
  ImGatewayChannel,
  ImGatewayChannelCapabilities,
  ImGatewayChannelStatus,
} from "../../preload/types";

export const CHANNEL_GUIDES: Record<
  ImGatewayChannel,
  {
    transport: "polling" | "socket" | "webhook" | "qr";
    fields: string;
    manageUrl?: string | { zh: string; en: string };
  }
> = {
  telegram: {
    transport: "polling",
    fields: "botToken · allowedChatIds",
    manageUrl: "https://t.me/BotFather",
  },
  discord: {
    transport: "socket",
    fields: "botToken · allowedChannelIds",
    manageUrl: "https://discord.com/developers/applications",
  },
  slack: {
    transport: "socket",
    fields: "botToken · appToken · allowedChannelIds",
    manageUrl: "https://api.slack.com/apps",
  },
  lark: {
    transport: "socket",
    fields: "appId · appSecret · allowedChatIds",
    manageUrl: { zh: "https://open.feishu.cn/app", en: "https://open.larksuite.com/app" },
  },
  dingtalk: {
    transport: "socket",
    fields: "clientId · clientSecret · allowedConversationIds",
    manageUrl: "https://open-dev.dingtalk.com/fe/app",
  },
  wecom: {
    transport: "socket",
    fields: "botId · secret · allowedChatIds",
    manageUrl: "https://work.weixin.qq.com/wework_admin/frame#apps",
  },
  wechat: { transport: "qr", fields: "accountId · allowedUserIds (auto-saved)" },
  matrix: { transport: "polling", fields: "homeserverUrl · accessToken · allowedRoomIds" },
  mattermost: { transport: "socket", fields: "serverUrl · botToken · allowedChannelIds" },
  line: {
    transport: "webhook",
    fields: "channelSecret · channelAccessToken · allowedTargetIds",
    manageUrl: "https://developers.line.biz/console/",
  },
  whatsapp: {
    transport: "webhook",
    fields: "accessToken · appSecret · phoneNumberId",
    manageUrl: "https://developers.facebook.com/apps/",
  },
  teams: {
    transport: "webhook",
    fields: "appId · appPassword · appType · tenantId",
    manageUrl: "https://portal.azure.com/#create/Microsoft.AzureBot",
  },
};

export const CHANNEL_STATE_CLASS: Record<ImGatewayChannelStatus["state"], string> = {
  disabled: "bg-muted text-muted-foreground",
  "needs-config": "bg-status-err/10 text-status-err",
  ready: "bg-sky-500/10 text-sky-600",
  starting: "bg-status-warn/10 text-status-warn",
  running: "bg-status-ok/10 text-status-ok",
  retrying: "bg-status-err/10 text-status-err",
};

export function gatewayCapabilityLabels(
  capabilities: ImGatewayChannelCapabilities,
  t: TFunction,
): { inbound: string; outbound: string } {
  const attachmentLabel = (kind: ImGatewayChannelCapabilities["inbound"]["attachments"][number]) =>
    t(`ext.link.gatewayCapability.${kind}`);
  return {
    inbound: [
      t("ext.link.gatewayCapability.text"),
      ...capabilities.inbound.attachments.map(attachmentLabel),
    ].join("、"),
    outbound: [
      t("ext.link.gatewayCapability.text"),
      t(
        capabilities.outbound.button === "native"
          ? "ext.link.gatewayCapability.buttonNative"
          : "ext.link.gatewayCapability.buttonLink",
      ),
      ...capabilities.outbound.attachments.map(attachmentLabel),
      t(
        capabilities.outbound.proactive !== false
          ? "ext.link.gatewayCapability.proactive"
          : "ext.link.gatewayCapability.replyOnly",
      ),
      ...(capabilities.outbound.direct ? [t("ext.link.gatewayCapability.direct")] : []),
    ].join("、"),
  };
}

export function gatewayToolNames(
  status: Pick<ImGatewayChannelStatus, "capabilities" | "proactiveReady">,
): string {
  return status.capabilities?.outbound.proactive !== false && status.proactiveReady !== false
    ? "GatewayReply · SendMessage"
    : "GatewayReply";
}
