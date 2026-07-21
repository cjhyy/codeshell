#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";
import { createChannelAdapterAsync } from "./adapter-factory.js";
import {
  ChatGateway,
  createAllowlistMiddleware,
  createRateLimitMiddleware,
} from "./chat-gateway.js";
import { defaultGatewayConfigPath, loadGatewayConfig } from "./config.js";
import { DesktopControlClient } from "./desktop-control-client.js";
import {
  CODE_SHELL_REMOTE_COMMANDS,
  createCodeShellRemoteCommands,
  createMimiPetChat,
} from "./gateway.js";
import { loginCodeShellWechat } from "./wechat-login.js";
import { defaultWechatDataDirectory } from "./wechat-storage.js";
import { acquireGatewayInstanceLock } from "./instance-lock.js";
import { renderWebhookIngress, type IngressFormat } from "./ingress.js";
import { GatewayServiceManager } from "./service-manager.js";
import { runPlatformCanary } from "./platform-canary.js";
import { createDesktopNotificationHandler } from "./notification-relay.js";

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "wechat" && args[1] === "login") {
    await loginWechat(readWechatLoginOptions(args.slice(2)));
    return;
  }
  if (args[0] === "service") {
    await manageService(args.slice(1));
    return;
  }
  if (args[0] === "ingress" && args[1] === "print") {
    printIngress(args.slice(2));
    return;
  }
  if (args[0] === "canary") {
    await runCanary(args.slice(1));
    return;
  }

  const configPath = readConfigPath(args);
  const config = loadGatewayConfig({ configPath });
  const lease = acquireGatewayInstanceLock(config.runtime.lockPath, "code-shell-chat CLI");
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const desktop = new DesktopControlClient(config.desktop);
    const adapters = await Promise.all(
      config.channels.map((channel) =>
        createChannelAdapterAsync(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
      ),
    );
    const gateway = new ChatGateway({
      adapters,
      webhook: config.webhook,
      delivery: {
        path: config.runtime.inboxPath,
        maxPending: config.runtime.maxPending,
        maxConcurrent: config.runtime.maxConcurrent,
        maxPerTarget: config.runtime.maxPerTarget,
      },
      adapterRestart: {
        baseMs: config.runtime.adapterRestartBaseMs,
        maxMs: config.runtime.adapterRestartMaxMs,
      },
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
    gateway.use(createRateLimitMiddleware(config.runtime.maxMessagesPerUserPerMinute));
    gateway.use(createCodeShellRemoteCommands({ desktop }));
    gateway.use(createMimiPetChat({ desktop }));

    console.log(
      `[code-shell-chat] gateway 已启动：${config.channels.map(({ channel }) => channel).join(", ")}`,
    );
    const gatewayTask = gateway.run(shutdown.signal);
    const notificationTask = desktop.watchEvents(
      shutdown.signal,
      createDesktopNotificationHandler(adapters, config.notifications),
      {
        checkpointPath: config.runtime.eventCursorPath,
        onError: (error) =>
          console.error(
            `[code-shell-chat] Desktop 通知等待重试：${error instanceof Error ? error.message : String(error)}`,
          ),
      },
    );
    await Promise.all([gatewayTask, notificationTask]);
  } finally {
    shutdown.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    lease.release();
  }
}

async function runCanary(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let timeoutMs = 10 * 60_000;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error("canary 参数缺少值");
    if (flag === "--config") configPath = value;
    else if (flag === "--timeout-ms" && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
      timeoutMs = Number(value);
    } else throw new Error(`未知 canary 参数：${flag}`);
  }
  const config = loadGatewayConfig({ configPath });
  const lease = acquireGatewayInstanceLock(config.runtime.lockPath, "code-shell-chat canary");
  try {
    const result = await runPlatformCanary({
      adapters: await Promise.all(
        config.channels.map((channel) =>
          createChannelAdapterAsync(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
        ),
      ),
      allowlists: Object.fromEntries(
        config.channels.map((channel) => [
          channel.channel,
          { targetIds: channel.allowedTargetIds, userIds: channel.allowedUserIds },
        ]),
      ),
      webhook: config.webhook,
      delivery: {
        path: config.runtime.inboxPath,
        maxPending: config.runtime.maxPending,
        maxConcurrent: config.runtime.maxConcurrent,
        maxPerTarget: config.runtime.maxPerTarget,
      },
      timeoutMs,
      onReady: (instruction) => console.log(`[code-shell-chat] ${instruction}`),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    lease.release();
  }
}

async function manageService(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    throw new Error(
      "用法：code-shell-chat service install|uninstall|status [--config /path/config.json]",
    );
  }
  const configPath = resolve(readOptionalConfigFlag(args.slice(1)) ?? defaultGatewayConfigPath());
  if (action === "install") loadGatewayConfig({ configPath });
  const manager = new GatewayServiceManager({ configPath });
  const status = await manager[action]();
  console.log(
    JSON.stringify(
      {
        action,
        ...status,
      },
      null,
      2,
    ),
  );
}

function printIngress(args: string[]): void {
  let publicHost: string | undefined;
  let upstream: string | undefined;
  let format: IngressFormat = "caddy";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error("ingress 参数缺少值");
    if (flag === "--host") publicHost = value;
    else if (flag === "--upstream") upstream = value;
    else if (flag === "--format" && (value === "caddy" || value === "nginx")) format = value;
    else throw new Error(`未知 ingress 参数：${flag}`);
  }
  if (!publicHost) {
    throw new Error(
      "用法：code-shell-chat ingress print --host chat.example.com [--format caddy|nginx] [--upstream 127.0.0.1:8787]",
    );
  }
  stdout.write(renderWebhookIngress({ format, publicHost, ...(upstream ? { upstream } : {}) }));
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
    "用法：code-shell-chat [--config /path/config.json] | code-shell-chat wechat login | code-shell-chat service install|uninstall|status | code-shell-chat ingress print | code-shell-chat canary",
  );
}

function readOptionalConfigFlag(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args[0] === "--config" && args[1] && args.length === 2) return args[1];
  throw new Error("仅支持 --config /path/config.json");
}

main().catch((error) => {
  console.error(`[code-shell-chat] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
