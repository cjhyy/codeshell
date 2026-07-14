#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";
import { createChannelAdapter } from "./adapter-factory.js";
import { ChatGateway, createAllowlistMiddleware } from "./chat-gateway.js";
import { defaultGatewayConfigPath, loadGatewayConfig } from "./config.js";
import { DesktopControlClient } from "./desktop-control-client.js";
import {
  CODE_SHELL_REMOTE_COMMANDS,
  createCodeShellRemoteCommands,
  createMimiPetChat,
} from "./gateway.js";
import { loginCodeShellWechat } from "./wechat-login.js";
import { defaultWechatDataDirectory } from "./wechat-storage.js";

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "wechat" && args[1] === "login") {
    await loginWechat(readWechatLoginOptions(args.slice(2)));
    return;
  }

  const configPath = readConfigPath(args);
  const config = loadGatewayConfig({ configPath });
  const desktop = new DesktopControlClient(config.desktop);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const gateway = new ChatGateway({
    adapters: config.channels.map((channel) =>
      createChannelAdapter(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
    ),
    webhook: config.webhook,
  });
  gateway.use(
    createAllowlistMiddleware(
      Object.fromEntries(
        config.channels.map((channel) => [
          channel.channel,
          { targetIds: channel.allowedTargetIds, userIds: channel.allowedUserIds },
        ]),
      ),
    ),
  );
  gateway.use(createCodeShellRemoteCommands({ desktop }));
  gateway.use(createMimiPetChat({ desktop }));

  console.log(
    `[code-shell-chat] gateway 已启动：${config.channels.map(({ channel }) => channel).join(", ")}`,
  );
  try {
    await gateway.run(shutdown.signal);
  } finally {
    shutdown.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

interface WechatLoginCliOptions {
  configPath: string;
  credentialsDir: string;
  customCredentialsDir: boolean;
}

async function loginWechat(options: WechatLoginCliOptions): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let scanned = false;
  console.log("[code-shell-chat] 正在生成个人微信 ClawBot 登录二维码…");
  try {
    const result = await loginCodeShellWechat({
      configPath: options.configPath,
      ...(options.customCredentialsDir ? { credentialsDir: options.credentialsDir } : {}),
      signal: shutdown.signal,
      onQrCode: (url) => {
        qrcode.generate(url, { small: true });
        console.log(`如果二维码无法扫描，请打开：${url}`);
      },
      onStatus: (status) => {
        if (status === "scaned" && !scanned) {
          scanned = true;
          console.log("已扫码，请在手机微信上确认…");
        }
      },
      requestVerificationCode: async () => {
        const readline = createInterface({ input: stdin, output: stdout });
        try {
          return await readline.question("请输入手机微信显示的验证数字：");
        } finally {
          readline.close();
        }
      },
    });

    console.log(`✅ 个人微信已连接：${result.accountId}`);
    console.log(`配置已更新：${result.configPath}`);
    console.log("现在可以启动：code-shell-chat");
  } finally {
    shutdown.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function readWechatLoginOptions(args: string[]): WechatLoginCliOptions {
  let configPath: string | undefined;
  let credentialsDir: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== "--config" && flag !== "--credentials-dir")) {
      throw new Error(
        "用法：code-shell-chat wechat login [--config /path/config.json] [--credentials-dir /path]",
      );
    }
    if (flag === "--config") configPath = value;
    else credentialsDir = value;
  }
  return {
    configPath: resolve(configPath ?? defaultGatewayConfigPath()),
    credentialsDir: resolve(credentialsDir ?? defaultWechatDataDirectory()),
    customCredentialsDir: credentialsDir !== undefined,
  };
}

function readConfigPath(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args[0] === "--config" && args[1] && args.length === 2) return args[1];
  throw new Error(
    "用法：code-shell-chat [--config /path/config.json] | code-shell-chat wechat login",
  );
}

main().catch((error) => {
  console.error(`[code-shell-chat] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
