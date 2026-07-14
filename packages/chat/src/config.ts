import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultWechatDataDirectory, FileWechatCredentialStore } from "./wechat-storage.js";

export interface AllowlistConfig {
  allowedTargetIds: string[];
  allowedUserIds: string[];
}

export interface TelegramGatewayConfig extends AllowlistConfig {
  channel: "telegram";
  botToken: string;
  apiBaseUrl: string;
}

export interface DiscordGatewayConfig extends AllowlistConfig {
  channel: "discord";
  botToken: string;
}

export interface SlackGatewayConfig extends AllowlistConfig {
  channel: "slack";
  botToken: string;
  appToken: string;
}

export interface LarkGatewayConfig extends AllowlistConfig {
  channel: "lark";
  appId: string;
  appSecret: string;
  domain?: string;
}

export interface DingTalkGatewayConfig extends AllowlistConfig {
  channel: "dingtalk";
  clientId: string;
  clientSecret: string;
}

export interface WeComGatewayConfig extends AllowlistConfig {
  channel: "wecom";
  botId: string;
  secret: string;
}

export interface WechatGatewayConfig extends AllowlistConfig {
  channel: "wechat";
  accountId: string;
  token: string;
  baseUrl: string;
  botAgent?: string;
  protocolVersion?: string;
  allowUnsafeBaseUrl?: boolean;
  credentialsDir: string;
  statePath: string;
}

export interface MatrixGatewayConfig extends AllowlistConfig {
  channel: "matrix";
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
}

export interface MattermostGatewayConfig extends AllowlistConfig {
  channel: "mattermost";
  serverUrl: string;
  botToken: string;
  botUserId?: string;
}

export interface LineGatewayConfig extends AllowlistConfig {
  channel: "line";
  channelSecret: string;
  channelAccessToken: string;
}

export interface WhatsAppGatewayConfig extends AllowlistConfig {
  channel: "whatsapp";
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

export interface TeamsGatewayConfig extends AllowlistConfig {
  channel: "teams";
  appId: string;
  appPassword: string;
  appType: string;
  tenantId?: string;
  statePath: string;
}

export type ConfiguredChannel =
  | TelegramGatewayConfig
  | DiscordGatewayConfig
  | SlackGatewayConfig
  | LarkGatewayConfig
  | DingTalkGatewayConfig
  | WeComGatewayConfig
  | WechatGatewayConfig
  | MatrixGatewayConfig
  | MattermostGatewayConfig
  | LineGatewayConfig
  | WhatsAppGatewayConfig
  | TeamsGatewayConfig;

export interface WebhookGatewayConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
}

export interface DesktopGatewayConfig {
  descriptorPath: string;
  autoLaunch: boolean;
  command?: string;
  args: string[];
  startupTimeoutMs: number;
}

export interface GatewayConfig {
  channels: ConfiguredChannel[];
  desktop: DesktopGatewayConfig;
  webhook: WebhookGatewayConfig;
  runtime: GatewayRuntimeConfig;
  notifications: GatewayNotificationTarget[];
}

export interface GatewayNotificationTarget {
  channel: ConfiguredChannel["channel"];
  target: string;
}

export interface GatewayRuntimeConfig {
  lockPath: string;
  inboxPath: string;
  eventCursorPath: string;
  maxPending: number;
  maxConcurrent: number;
  maxPerTarget: number;
  maxMessagesPerUserPerMinute: number;
  adapterRestartBaseMs: number;
  adapterRestartMaxMs: number;
}

export interface LoadGatewayConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

type RawSection = Record<string, unknown>;

interface RawGatewayConfig {
  telegram?: RawSection;
  discord?: RawSection;
  slack?: RawSection;
  lark?: RawSection;
  dingtalk?: RawSection;
  wecom?: RawSection;
  wechat?: RawSection;
  matrix?: RawSection;
  mattermost?: RawSection;
  line?: RawSection;
  whatsapp?: RawSection;
  teams?: RawSection;
  webhook?: RawSection;
  desktop?: RawSection;
  runtime?: RawSection;
  notifications?: RawSection;
}

export function defaultGatewayConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), ".code-shell", "im-gateway", "config.json");
}

export function defaultDesktopControlDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), ".code-shell", "im-gateway", "desktop-control.json");
}

/** Safe, disabled-by-default starter file used by the Desktop Link editor. */
export function gatewayConfigTemplate(): Record<string, unknown> {
  return {
    _help:
      "Set enabled=true for the channels you want, fill their credentials and allowlists, then start Chat Gateway in CodeShell Desktop.",
    telegram: {
      enabled: false,
      botToken: "",
      allowedChatIds: [],
      allowedUserIds: [],
    },
    discord: {
      enabled: false,
      botToken: "",
      allowedChannelIds: [],
      allowedUserIds: [],
    },
    slack: {
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds: [],
      allowedUserIds: [],
    },
    lark: {
      enabled: false,
      appId: "",
      appSecret: "",
      allowedChatIds: [],
      allowedUserIds: [],
    },
    dingtalk: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      allowedConversationIds: [],
      allowedUserIds: [],
    },
    wecom: {
      enabled: false,
      botId: "",
      secret: "",
      allowedChatIds: [],
      allowedUserIds: [],
    },
    wechat: { enabled: false },
    matrix: {
      enabled: false,
      homeserverUrl: "",
      accessToken: "",
      botUserId: "",
      allowedRoomIds: [],
      allowedUserIds: [],
    },
    mattermost: {
      enabled: false,
      serverUrl: "",
      botToken: "",
      botUserId: "",
      allowedChannelIds: [],
      allowedUserIds: [],
    },
    line: {
      enabled: false,
      channelSecret: "",
      channelAccessToken: "",
      allowedTargetIds: [],
      allowedUserIds: [],
    },
    whatsapp: {
      enabled: false,
      accessToken: "",
      appSecret: "",
      verifyToken: "",
      phoneNumberId: "",
      allowedPhoneNumbers: [],
    },
    teams: {
      enabled: false,
      appId: "",
      appPassword: "",
      appType: "MultiTenant",
      allowedConversationIds: [],
      allowedUserIds: [],
    },
    webhook: { host: "127.0.0.1", port: 8787, maxBodyBytes: 1048576 },
    runtime: {
      maxPending: 1000,
      maxConcurrent: 4,
      maxPerTarget: 1,
      maxMessagesPerUserPerMinute: 20,
    },
    notifications: {
      enabled: false,
      _help: "Optional proactive Desktop/tunnel event targets, keyed by channel.",
      targets: {},
    },
  };
}

export function loadGatewayConfig(opts: LoadGatewayConfigOptions = {}): GatewayConfig {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const configPath = resolve(
    opts.configPath ?? env.CODE_SHELL_IM_GATEWAY_CONFIG ?? defaultGatewayConfigPath(env),
  );
  const raw = readRawConfig(configPath);

  if (existsSync(configPath) && platform !== "win32") {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`IM gateway 配置权限必须为 0600：${configPath}`);
    }
  }

  const channels = loadChannels(raw, env);
  if (channels.length === 0) {
    throw new Error(
      "至少配置一个 IM channel；当前支持 Telegram、Discord、Slack、飞书、钉钉、个人微信、企业微信、Matrix、Mattermost、LINE、WhatsApp、Teams",
    );
  }

  const configuredCommand = readNonEmptyString(raw.desktop?.command);
  const configuredArgs = readStringList(raw.desktop?.args, false);
  const defaultLaunch = defaultDesktopLaunch(platform);
  const config: GatewayConfig = {
    channels,
    desktop: {
      descriptorPath:
        readNonEmptyString(raw.desktop?.descriptorPath) ?? defaultDesktopControlDescriptorPath(env),
      autoLaunch: raw.desktop?.autoLaunch !== false,
      command: configuredCommand ?? defaultLaunch.command,
      args: configuredArgs ?? (configuredCommand ? [] : defaultLaunch.args),
      startupTimeoutMs: readPositiveNumber(raw.desktop?.startupTimeoutMs) ?? 30_000,
    },
    webhook: {
      host: readNonEmptyString(raw.webhook?.host) ?? "127.0.0.1",
      port: readPort(raw.webhook?.port) ?? 8787,
      maxBodyBytes: readPositiveNumber(raw.webhook?.maxBodyBytes) ?? 1_048_576,
    },
    runtime: {
      lockPath:
        readNonEmptyString(raw.runtime?.lockPath) ??
        join(resolveHome(env), ".code-shell", "im-gateway", "gateway.lock"),
      inboxPath:
        readNonEmptyString(raw.runtime?.inboxPath) ??
        join(resolveHome(env), ".code-shell", "im-gateway", "inbox.json"),
      eventCursorPath:
        readNonEmptyString(raw.runtime?.eventCursorPath) ??
        join(resolveHome(env), ".code-shell", "im-gateway", "desktop-events.json"),
      maxPending: readPositiveInteger(raw.runtime?.maxPending) ?? 1_000,
      maxConcurrent: readPositiveInteger(raw.runtime?.maxConcurrent) ?? 4,
      maxPerTarget: readPositiveInteger(raw.runtime?.maxPerTarget) ?? 1,
      maxMessagesPerUserPerMinute:
        readPositiveInteger(raw.runtime?.maxMessagesPerUserPerMinute) ?? 20,
      adapterRestartBaseMs: readPositiveInteger(raw.runtime?.adapterRestartBaseMs) ?? 1_000,
      adapterRestartMaxMs: readPositiveInteger(raw.runtime?.adapterRestartMaxMs) ?? 30_000,
    },
    notifications: [],
  };
  config.notifications = loadNotificationTargets(raw.notifications, channels);
  return config;
}

function loadNotificationTargets(
  raw: RawSection | undefined,
  channels: ConfiguredChannel[],
): GatewayNotificationTarget[] {
  if (!raw || raw.enabled === false) return [];
  const targets = raw.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("notifications.targets 必须是 channel 到 target 数组的映射");
  }
  const result: GatewayNotificationTarget[] = [];
  for (const [channelName, values] of Object.entries(targets as RawSection)) {
    const channel = channels.find(({ channel }) => channel === channelName);
    if (!channel) throw new Error(`notifications 引用了未启用的 channel：${channelName}`);
    for (const target of readStringList(values)) {
      if (!channel.allowedTargetIds.includes(target)) {
        throw new Error(`notifications target 不在 ${channelName} 会话白名单中：${target}`);
      }
      result.push({ channel: channel.channel, target });
    }
  }
  if (result.length === 0) throw new Error("notifications.enabled=true 时至少配置一个 target");
  return result;
}

function loadChannels(raw: RawGatewayConfig, env: NodeJS.ProcessEnv): ConfiguredChannel[] {
  return [
    loadTelegram(raw.telegram, env),
    loadDiscord(raw.discord, env),
    loadSlack(raw.slack, env),
    loadLark(raw.lark, env),
    loadDingTalk(raw.dingtalk, env),
    loadWeCom(raw.wecom, env),
    loadWechat(raw.wechat, env),
    loadMatrix(raw.matrix, env),
    loadMattermost(raw.mattermost, env),
    loadLine(raw.line, env),
    loadWhatsApp(raw.whatsapp, env),
    loadTeams(raw.teams, env),
  ].filter((channel): channel is ConfiguredChannel => channel !== undefined);
}

function loadTelegram(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): TelegramGatewayConfig | undefined {
  const botToken =
    envString(env, "CODE_SHELL_TELEGRAM_BOT_TOKEN") ?? readNonEmptyString(raw?.botToken);
  if (!sectionEnabled(raw, botToken)) return undefined;
  return {
    channel: "telegram",
    botToken: requireValue("Telegram", "botToken", botToken),
    ...loadAllowlist(
      "Telegram",
      raw,
      env,
      "CODE_SHELL_TELEGRAM_ALLOWED_CHAT_IDS",
      "CODE_SHELL_TELEGRAM_ALLOWED_USER_IDS",
      "allowedChatIds",
    ),
    apiBaseUrl:
      readNonEmptyString(raw?.apiBaseUrl)?.replace(/\/$/, "") ?? "https://api.telegram.org",
  };
}

function loadDiscord(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): DiscordGatewayConfig | undefined {
  const botToken =
    envString(env, "CODE_SHELL_DISCORD_BOT_TOKEN") ?? readNonEmptyString(raw?.botToken);
  if (!sectionEnabled(raw, botToken)) return undefined;
  return {
    channel: "discord",
    botToken: requireValue("Discord", "botToken", botToken),
    ...loadAllowlist(
      "Discord",
      raw,
      env,
      "CODE_SHELL_DISCORD_ALLOWED_CHANNEL_IDS",
      "CODE_SHELL_DISCORD_ALLOWED_USER_IDS",
      "allowedChannelIds",
    ),
  };
}

function loadSlack(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): SlackGatewayConfig | undefined {
  const botToken =
    envString(env, "CODE_SHELL_SLACK_BOT_TOKEN") ?? readNonEmptyString(raw?.botToken);
  const appToken =
    envString(env, "CODE_SHELL_SLACK_APP_TOKEN") ?? readNonEmptyString(raw?.appToken);
  if (!sectionEnabled(raw, botToken, appToken)) return undefined;
  return {
    channel: "slack",
    botToken: requireValue("Slack", "botToken", botToken),
    appToken: requireValue("Slack", "appToken", appToken),
    ...loadAllowlist(
      "Slack",
      raw,
      env,
      "CODE_SHELL_SLACK_ALLOWED_CHANNEL_IDS",
      "CODE_SHELL_SLACK_ALLOWED_USER_IDS",
      "allowedChannelIds",
    ),
  };
}

function loadLark(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): LarkGatewayConfig | undefined {
  const appId = envString(env, "CODE_SHELL_LARK_APP_ID") ?? readNonEmptyString(raw?.appId);
  const appSecret =
    envString(env, "CODE_SHELL_LARK_APP_SECRET") ?? readNonEmptyString(raw?.appSecret);
  if (!sectionEnabled(raw, appId, appSecret)) return undefined;
  return {
    channel: "lark",
    appId: requireValue("飞书/Lark", "appId", appId),
    appSecret: requireValue("飞书/Lark", "appSecret", appSecret),
    domain: envString(env, "CODE_SHELL_LARK_DOMAIN") ?? readNonEmptyString(raw?.domain),
    ...loadAllowlist(
      "飞书/Lark",
      raw,
      env,
      "CODE_SHELL_LARK_ALLOWED_CHAT_IDS",
      "CODE_SHELL_LARK_ALLOWED_USER_IDS",
      "allowedChatIds",
    ),
  };
}

function loadDingTalk(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): DingTalkGatewayConfig | undefined {
  const clientId =
    envString(env, "CODE_SHELL_DINGTALK_CLIENT_ID") ?? readNonEmptyString(raw?.clientId);
  const clientSecret =
    envString(env, "CODE_SHELL_DINGTALK_CLIENT_SECRET") ?? readNonEmptyString(raw?.clientSecret);
  if (!sectionEnabled(raw, clientId, clientSecret)) return undefined;
  return {
    channel: "dingtalk",
    clientId: requireValue("钉钉", "clientId", clientId),
    clientSecret: requireValue("钉钉", "clientSecret", clientSecret),
    ...loadAllowlist(
      "钉钉",
      raw,
      env,
      "CODE_SHELL_DINGTALK_ALLOWED_CONVERSATION_IDS",
      "CODE_SHELL_DINGTALK_ALLOWED_USER_IDS",
      "allowedConversationIds",
    ),
  };
}

function loadWeCom(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): WeComGatewayConfig | undefined {
  const botId = envString(env, "CODE_SHELL_WECOM_BOT_ID") ?? readNonEmptyString(raw?.botId);
  const secret = envString(env, "CODE_SHELL_WECOM_SECRET") ?? readNonEmptyString(raw?.secret);
  if (!sectionEnabled(raw, botId, secret)) return undefined;
  return {
    channel: "wecom",
    botId: requireValue("企业微信", "botId", botId),
    secret: requireValue("企业微信", "secret", secret),
    ...loadAllowlist(
      "企业微信",
      raw,
      env,
      "CODE_SHELL_WECOM_ALLOWED_CHAT_IDS",
      "CODE_SHELL_WECOM_ALLOWED_USER_IDS",
      "allowedChatIds",
    ),
  };
}

function loadWechat(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): WechatGatewayConfig | undefined {
  const explicitAccountId =
    envString(env, "CODE_SHELL_WECHAT_ACCOUNT_ID") ?? readNonEmptyString(raw?.accountId);
  const explicitToken =
    envString(env, "CODE_SHELL_WECHAT_BOT_TOKEN") ?? readNonEmptyString(raw?.botToken);
  const configuredDirectory =
    envString(env, "CODE_SHELL_WECHAT_CREDENTIALS_DIR") ?? readNonEmptyString(raw?.credentialsDir);
  if (!sectionEnabled(raw, explicitAccountId, explicitToken, configuredDirectory)) return undefined;

  const credentialsDir = resolve(configuredDirectory ?? defaultWechatDataDirectory(env));
  const store = new FileWechatCredentialStore(credentialsDir);
  const stored = store.load(explicitAccountId);
  const accountId = explicitAccountId ?? stored?.accountId;
  const token = explicitToken ?? stored?.token;
  if (!accountId || !token) {
    throw new Error("个人微信未登录：请先执行 code-shell-chat wechat login");
  }

  const defaultOwner = stored?.userId ? [stored.userId] : [];
  const allowedTargetIds =
    readCsvOverride(env.CODE_SHELL_WECHAT_ALLOWED_USER_IDS) ??
    readStringList(raw?.allowedUserIds, false) ??
    defaultOwner;
  if (allowedTargetIds.length === 0) {
    throw new Error("个人微信至少配置 allowedUserIds，或重新扫码以记录管理员身份");
  }
  const allowedUserIds =
    readCsvOverride(env.CODE_SHELL_WECHAT_ALLOWED_USER_IDS) ??
    readStringList(raw?.allowedUserIds, false) ??
    defaultOwner;

  return {
    channel: "wechat",
    accountId,
    token,
    baseUrl:
      envString(env, "CODE_SHELL_WECHAT_BASE_URL") ??
      readNonEmptyString(raw?.baseUrl) ??
      stored?.baseUrl ??
      "https://ilinkai.weixin.qq.com",
    botAgent: envString(env, "CODE_SHELL_WECHAT_BOT_AGENT") ?? readNonEmptyString(raw?.botAgent),
    protocolVersion:
      envString(env, "CODE_SHELL_WECHAT_PROTOCOL_VERSION") ??
      readNonEmptyString(raw?.protocolVersion),
    allowUnsafeBaseUrl: raw?.allowUnsafeBaseUrl === true,
    credentialsDir,
    statePath: store.statePath(accountId),
    allowedTargetIds,
    allowedUserIds,
  };
}

function loadMatrix(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): MatrixGatewayConfig | undefined {
  const homeserverUrl =
    envString(env, "CODE_SHELL_MATRIX_HOMESERVER_URL") ?? readNonEmptyString(raw?.homeserverUrl);
  const accessToken =
    envString(env, "CODE_SHELL_MATRIX_ACCESS_TOKEN") ?? readNonEmptyString(raw?.accessToken);
  if (!sectionEnabled(raw, homeserverUrl, accessToken)) return undefined;
  return {
    channel: "matrix",
    homeserverUrl: requireValue("Matrix", "homeserverUrl", homeserverUrl).replace(/\/$/, ""),
    accessToken: requireValue("Matrix", "accessToken", accessToken),
    botUserId:
      envString(env, "CODE_SHELL_MATRIX_BOT_USER_ID") ?? readNonEmptyString(raw?.botUserId),
    ...loadAllowlist(
      "Matrix",
      raw,
      env,
      "CODE_SHELL_MATRIX_ALLOWED_ROOM_IDS",
      "CODE_SHELL_MATRIX_ALLOWED_USER_IDS",
      "allowedRoomIds",
    ),
  };
}

function loadMattermost(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): MattermostGatewayConfig | undefined {
  const serverUrl =
    envString(env, "CODE_SHELL_MATTERMOST_SERVER_URL") ?? readNonEmptyString(raw?.serverUrl);
  const botToken =
    envString(env, "CODE_SHELL_MATTERMOST_BOT_TOKEN") ?? readNonEmptyString(raw?.botToken);
  if (!sectionEnabled(raw, serverUrl, botToken)) return undefined;
  return {
    channel: "mattermost",
    serverUrl: requireValue("Mattermost", "serverUrl", serverUrl).replace(/\/$/, ""),
    botToken: requireValue("Mattermost", "botToken", botToken),
    botUserId:
      envString(env, "CODE_SHELL_MATTERMOST_BOT_USER_ID") ?? readNonEmptyString(raw?.botUserId),
    ...loadAllowlist(
      "Mattermost",
      raw,
      env,
      "CODE_SHELL_MATTERMOST_ALLOWED_CHANNEL_IDS",
      "CODE_SHELL_MATTERMOST_ALLOWED_USER_IDS",
      "allowedChannelIds",
    ),
  };
}

function loadLine(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): LineGatewayConfig | undefined {
  const channelSecret =
    envString(env, "CODE_SHELL_LINE_CHANNEL_SECRET") ?? readNonEmptyString(raw?.channelSecret);
  const channelAccessToken =
    envString(env, "CODE_SHELL_LINE_CHANNEL_ACCESS_TOKEN") ??
    readNonEmptyString(raw?.channelAccessToken);
  if (!sectionEnabled(raw, channelSecret, channelAccessToken)) return undefined;
  return {
    channel: "line",
    channelSecret: requireValue("LINE", "channelSecret", channelSecret),
    channelAccessToken: requireValue("LINE", "channelAccessToken", channelAccessToken),
    ...loadAllowlist(
      "LINE",
      raw,
      env,
      "CODE_SHELL_LINE_ALLOWED_TARGET_IDS",
      "CODE_SHELL_LINE_ALLOWED_USER_IDS",
      "allowedTargetIds",
    ),
  };
}

function loadWhatsApp(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): WhatsAppGatewayConfig | undefined {
  const accessToken =
    envString(env, "CODE_SHELL_WHATSAPP_ACCESS_TOKEN") ?? readNonEmptyString(raw?.accessToken);
  const appSecret =
    envString(env, "CODE_SHELL_WHATSAPP_APP_SECRET") ?? readNonEmptyString(raw?.appSecret);
  const verifyToken =
    envString(env, "CODE_SHELL_WHATSAPP_VERIFY_TOKEN") ?? readNonEmptyString(raw?.verifyToken);
  const phoneNumberId =
    envString(env, "CODE_SHELL_WHATSAPP_PHONE_NUMBER_ID") ?? readNonEmptyString(raw?.phoneNumberId);
  if (!sectionEnabled(raw, accessToken, appSecret, verifyToken, phoneNumberId)) return undefined;
  return {
    channel: "whatsapp",
    accessToken: requireValue("WhatsApp", "accessToken", accessToken),
    appSecret: requireValue("WhatsApp", "appSecret", appSecret),
    verifyToken: requireValue("WhatsApp", "verifyToken", verifyToken),
    phoneNumberId: requireValue("WhatsApp", "phoneNumberId", phoneNumberId),
    apiVersion:
      envString(env, "CODE_SHELL_WHATSAPP_API_VERSION") ??
      readNonEmptyString(raw?.apiVersion) ??
      "v25.0",
    ...loadAllowlist(
      "WhatsApp",
      raw,
      env,
      "CODE_SHELL_WHATSAPP_ALLOWED_PHONE_NUMBERS",
      "CODE_SHELL_WHATSAPP_ALLOWED_PHONE_NUMBERS",
      "allowedPhoneNumbers",
    ),
  };
}

function loadTeams(
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
): TeamsGatewayConfig | undefined {
  const appId = envString(env, "CODE_SHELL_TEAMS_APP_ID") ?? readNonEmptyString(raw?.appId);
  const appPassword =
    envString(env, "CODE_SHELL_TEAMS_APP_PASSWORD") ?? readNonEmptyString(raw?.appPassword);
  if (!sectionEnabled(raw, appId, appPassword)) return undefined;
  return {
    channel: "teams",
    appId: requireValue("Microsoft Teams", "appId", appId),
    appPassword: requireValue("Microsoft Teams", "appPassword", appPassword),
    appType:
      envString(env, "CODE_SHELL_TEAMS_APP_TYPE") ??
      readNonEmptyString(raw?.appType) ??
      "MultiTenant",
    tenantId: envString(env, "CODE_SHELL_TEAMS_TENANT_ID") ?? readNonEmptyString(raw?.tenantId),
    statePath:
      envString(env, "CODE_SHELL_TEAMS_STATE_PATH") ??
      readNonEmptyString(raw?.statePath) ??
      join(resolveHome(env), ".code-shell", "im-gateway", "teams-conversations.json"),
    ...loadAllowlist(
      "Microsoft Teams",
      raw,
      env,
      "CODE_SHELL_TEAMS_ALLOWED_CONVERSATION_IDS",
      "CODE_SHELL_TEAMS_ALLOWED_USER_IDS",
      "allowedConversationIds",
    ),
  };
}

function loadAllowlist(
  name: string,
  raw: RawSection | undefined,
  env: NodeJS.ProcessEnv,
  targetEnv: string,
  userEnv: string,
  rawTargetKey: string,
): AllowlistConfig {
  const allowedTargetIds = readCsvOverride(env[targetEnv]) ?? readStringList(raw?.[rawTargetKey]);
  const allowedUserIds = readCsvOverride(env[userEnv]) ?? readStringList(raw?.allowedUserIds);
  if (allowedTargetIds.length === 0) {
    throw new Error(`${name} 至少配置一个会话白名单：${rawTargetKey} 或 ${targetEnv}`);
  }
  return { allowedTargetIds, allowedUserIds };
}

function readRawConfig(configPath: string): RawGatewayConfig {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed as RawGatewayConfig;
  } catch (error) {
    throw new Error(
      `无法读取 IM gateway 配置 ${configPath}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function sectionEnabled(
  raw: RawSection | undefined,
  ...values: Array<string | undefined>
): boolean {
  if (raw?.enabled === false) return false;
  return raw !== undefined || values.some(Boolean);
}

function requireValue(channel: string, key: string, value: string | undefined): string {
  if (!value) throw new Error(`${channel} 配置不完整：缺少 ${key}`);
  return value;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return readNonEmptyString(env[key]);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[];
function readStringList(value: unknown, fallbackToEmpty: false): string[] | undefined;
function readStringList(value: unknown, fallbackToEmpty = true): string[] | undefined {
  if (value === undefined && !fallbackToEmpty) return undefined;
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map(readNonEmptyString).filter((item): item is string => Boolean(item))),
  ];
}

function readCsvOverride(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

function defaultDesktopLaunch(platform: NodeJS.Platform): { command?: string; args: string[] } {
  if (platform === "darwin") return { command: "/usr/bin/open", args: ["-a", "code-shell"] };
  if (platform === "win32") return { command: "code-shell.exe", args: [] };
  return { command: "code-shell", args: [] };
}
