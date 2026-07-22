import type { ChatMiddleware } from "./chat-gateway.js";
import type { ChannelMessage, OutgoingAttachment, OutgoingMessage } from "./channel.js";
import { materializeChatAttachments } from "./attachments.js";
import {
  DesktopControlOperationError,
  DesktopControlUnavailableError,
  type DesktopControlClient,
} from "./desktop-control-client.js";
import { materializeEventAttachments } from "./notification-relay.js";

export interface CodeShellRemoteCommandsOptions {
  desktop: Pick<DesktopControlClient, "open" | "close" | "status">;
}

export interface MimiPetChatOptions {
  desktop: Pick<DesktopControlClient, "petChat">;
}

const MIMI_REPLY_CACHE_MAX_ENTRIES = 2_048;

interface MimiCachedReply {
  outgoing: Promise<OutgoingMessage>;
  activeSends: number;
  sendFailed: boolean;
}

export const CODE_SHELL_REMOTE_COMMANDS = [
  { name: "open", description: "打开 CodeShell 手机遥控隧道" },
  { name: "close", description: "关闭 CodeShell 手机遥控隧道" },
  { name: "status", description: "查看 CodeShell 手机遥控状态" },
] as const;

/** Optional CodeShell integration. Unknown messages fall through to the next middleware. */
export function createCodeShellRemoteCommands(
  options: CodeShellRemoteCommandsOptions,
): ChatMiddleware {
  return async ({ message, adapter, reply }, next) => {
    const command = parseGatewayIntent(message.text);
    if (command === "unsupported") {
      await next();
      return;
    }
    try {
      if (command === "open") {
        const opened = await options.desktop.open();
        const qr = adapter.supportsOutgoingAttachments
          ? await renderPairingQrAttachment(opened.pairingUrl)
          : undefined;
        await reply({
          text: [
            `公网隧道已开启：${opened.url}`,
            qr
              ? "配对入口 10 分钟内有效，请点击下方按钮或扫描二维码。"
              : "配对入口 10 分钟内有效，请点击下方按钮。",
            "打开后仍需输入桌面端已设置的访问口令。",
          ].join("\n"),
          button: { text: "打开手机遥控", url: opened.pairingUrl },
          ...(qr ? { attachments: [qr] } : {}),
        });
        return;
      }

      if (command === "close") {
        await options.desktop.close();
        await reply({ text: "公网隧道已关闭。" });
        return;
      }

      const status = await options.desktop.status();
      await reply({ text: formatStatus(status) });
    } catch (error) {
      if (error instanceof DesktopControlUnavailableError) {
        await reply({ text: `桌面端未在线：${error.message}` });
        return;
      }
      if (error instanceof DesktopControlOperationError) {
        await reply({ text: `操作失败：${error.message}` });
        return;
      }
      await reply({
        text: `操作失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
}

export type GatewayCommand = "open" | "close" | "status" | "unsupported";

export function parseGatewayCommand(text: string): GatewayCommand {
  const first = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const command = first.replace(/@[a-z0-9_]+$/i, "");
  if (command === "/open") return "open";
  if (command === "/close") return "close";
  if (command === "/status") return "status";
  return "unsupported";
}

/**
 * Only explicit slash commands short-circuit here. Every natural-language
 * message — including "打开手机遥控" or "给我隧道地址" — flows to Mimi, whose
 * MobileRemote tool decides the intent; regex alias matching was removed on
 * purpose so intent understanding lives in one place (the model), not two.
 */
export function parseGatewayIntent(text: string): GatewayCommand {
  return parseGatewayCommand(text);
}

/** Final middleware: route ordinary text/media turns into the durable Mimi Pet session. */
export function createMimiPetChat(options: MimiPetChatOptions): ChatMiddleware {
  // DeliveryQueue retries the same platform message after adapter.send fails.
  // Cache the fully materialized reply (including attachment bytes) before the
  // first send so retrying cannot re-run Mimi or any already-executed host
  // action. Failed desktop/materialization work is evicted and remains retryable.
  const replies = new Map<string, MimiCachedReply>();
  return async ({ message, adapter, reply }) => {
    if (!message.text.trim() && !message.attachments?.length) return;
    const cacheKey = mimiReplyCacheKey(message);
    let cacheEntry: MimiCachedReply | undefined;
    let outgoing: OutgoingMessage;
    try {
      if (!cacheKey) {
        outgoing = await buildMimiOutgoingReply(
          options,
          message,
          Boolean(adapter.supportsOutgoingAttachments),
        );
      } else {
        const cached = replies.get(cacheKey);
        if (cached) {
          // Refresh insertion order so active retries are not the first evicted.
          replies.delete(cacheKey);
          replies.set(cacheKey, cached);
          cacheEntry = cached;
          outgoing = await cached.outgoing;
        } else {
          const pending = buildMimiOutgoingReply(
            options,
            message,
            Boolean(adapter.supportsOutgoingAttachments),
          );
          const entry: MimiCachedReply = {
            outgoing: pending,
            activeSends: 0,
            sendFailed: false,
          };
          replies.set(cacheKey, entry);
          cacheEntry = entry;
          while (replies.size > MIMI_REPLY_CACHE_MAX_ENTRIES) {
            const oldest = replies.keys().next().value;
            if (typeof oldest !== "string") break;
            replies.delete(oldest);
          }
          pending.catch(() => {
            if (replies.get(cacheKey) === entry) replies.delete(cacheKey);
          });
          outgoing = await pending;
        }
      }
    } catch (error) {
      if (error instanceof DesktopControlUnavailableError) {
        await reply({ text: `桌面端未在线：${error.message}` });
        return;
      }
      if (error instanceof DesktopControlOperationError) {
        await reply({ text: `Mimi Pet 处理失败：${error.message}` });
        return;
      }
      await reply({
        text: `Mimi Pet 处理失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    // Adapter failures must escape to DeliveryQueue. Catching them above would
    // turn a failed real reply into a successful generic error and lose it.
    if (cacheEntry) {
      if (cacheEntry.activeSends === 0) cacheEntry.sendFailed = false;
      cacheEntry.activeSends += 1;
    }
    try {
      await reply(outgoing);
    } catch (error) {
      if (cacheEntry) cacheEntry.sendFailed = true;
      throw error;
    } finally {
      if (cacheEntry) {
        cacheEntry.activeSends -= 1;
        // DeliveryQueue now owns a durable completed-message dedupe record.
        // Keep memory proportional to failed/in-flight sends, not successful chat.
        if (
          cacheKey &&
          cacheEntry.activeSends === 0 &&
          !cacheEntry.sendFailed &&
          replies.get(cacheKey) === cacheEntry
        ) {
          replies.delete(cacheKey);
        }
      }
    }
  };
}

async function buildMimiOutgoingReply(
  options: MimiPetChatOptions,
  message: ChannelMessage,
  supportsOutgoingAttachments: boolean,
): Promise<OutgoingMessage> {
  const attachments = await materializeChatAttachments(message.attachments);
  const result = await options.desktop.petChat({
    message: message.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    origin: {
      channel: message.channel,
      target: message.target,
      senderId: message.senderId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
    },
  });
  const outgoing: OutgoingMessage = {
    text: result.text || "Mimi Pet 已处理，但没有返回文字内容。",
  };
  if (result.attachments?.length && supportsOutgoingAttachments) {
    try {
      const materialized = await materializeEventAttachments(result.attachments);
      if (materialized.length > 0) outgoing.attachments = materialized;
    } catch {
      // A stale or invalid host file must not drop Mimi's text reply.
    }
  }
  return outgoing;
}

function mimiReplyCacheKey(message: ChannelMessage): string | undefined {
  if (!message.messageId) return undefined;
  return [message.channel, message.target, message.senderId, message.messageId].join("\0");
}

/** Render the one-time pairing URL as a PNG QR code; failures degrade to text+button. */
async function renderPairingQrAttachment(
  pairingUrl: string,
): Promise<OutgoingAttachment | undefined> {
  try {
    const { default: QRCode } = await import("qrcode");
    const data = await QRCode.toBuffer(pairingUrl, { type: "png", width: 512, margin: 2 });
    return { kind: "image", name: "pairing-qr.png", mimeType: "image/png", data };
  } catch {
    return undefined;
  }
}

function formatStatus(status: Awaited<ReturnType<DesktopControlClient["status"]>>): string {
  const tunnel = status.tunnelConnected
    ? "已连接"
    : status.tunnelRunning
      ? "连接中/异常"
      : "未运行";
  return [
    "桌面端：在线",
    `手机服务：${status.running ? "运行中" : "未运行"}`,
    `公网隧道：${tunnel}`,
    `访问口令：${status.passcodeSet ? "已设置" : "未设置"}`,
    `在线设备：${status.onlineDeviceCount}`,
    ...(status.url ? [`当前地址：${status.url}`] : []),
  ].join("\n");
}
