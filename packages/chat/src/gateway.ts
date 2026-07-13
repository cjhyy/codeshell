import type { ChatMiddleware } from "./chat-gateway.js";
import { materializeChatAttachments } from "./attachments.js";
import {
  DesktopControlOperationError,
  DesktopControlUnavailableError,
  type DesktopControlClient,
} from "./desktop-control-client.js";

export interface CodeShellRemoteCommandsOptions {
  desktop: Pick<DesktopControlClient, "open" | "close" | "status">;
}

export interface MimiPetChatOptions {
  desktop: Pick<DesktopControlClient, "petChat">;
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
  return async ({ message, reply }, next) => {
    const command = parseGatewayIntent(message.text);
    if (command === "unsupported") {
      await next();
      return;
    }
    try {
      if (command === "open") {
        const opened = await options.desktop.open();
        await reply({
          text: [
            `公网隧道已开启：${opened.url}`,
            "配对入口 10 分钟内有效，请点击下方按钮。",
            "打开后仍需输入桌面端已设置的访问口令。",
          ].join("\n"),
          button: { text: "打开手机遥控", url: opened.pairingUrl },
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

/** Conservative natural-language aliases; ambiguous prompts continue to Mimi Pet. */
export function parseGatewayIntent(text: string): GatewayCommand {
  const command = parseGatewayCommand(text);
  if (command !== "unsupported") return command;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[，。！？!?、,.]/g, "")
    .replace(/\s+/g, " ");
  const prefix = "(?:请|麻烦|帮我)?";
  const suffix = "(?:一下|吧|好吗|可以吗)?";
  const remote = "(?:手机遥控|手机远程|远程控制|公网访问|公网入口|公网隧道|隧道)";
  if (new RegExp(`^${prefix}(?:打开|开启|启动|开)${suffix}${remote}${suffix}$`).test(normalized)) {
    return "open";
  }
  if (
    new RegExp(`^${prefix}(?:关闭|关掉|停止|停掉|关)${suffix}${remote}${suffix}$`).test(normalized)
  ) {
    return "close";
  }
  if (
    new RegExp(`^${prefix}(?:查看|看看|查询)?${remote}(?:的)?(?:状态|连接状态)${suffix}$`).test(
      normalized,
    ) ||
    /^(?:show |check )?(?:mobile remote|tunnel) status$/.test(normalized)
  ) {
    return "status";
  }
  if (/^(?:open|start) (?:the )?(?:mobile remote|public tunnel)$/.test(normalized)) return "open";
  if (/^(?:close|stop) (?:the )?(?:mobile remote|public tunnel)$/.test(normalized)) return "close";
  return "unsupported";
}

/** Final middleware: route ordinary text/media turns into the durable Mimi Pet session. */
export function createMimiPetChat(options: MimiPetChatOptions): ChatMiddleware {
  return async ({ message, reply }) => {
    try {
      const attachments = await materializeChatAttachments(message.attachments);
      if (!message.text.trim() && attachments.length === 0) return;
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
      await reply({ text: result.text || "Mimi Pet 已处理，但没有返回文字内容。" });
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
    }
  };
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
