# @cjhyy/code-shell-chat

可独立安装的 Node.js/Bun 多渠道 Chat Gateway。包本身不依赖 CodeShell runtime：第三方应用可以
直接组合 channel adapter、middleware、白名单和 webhook ingress，并使用自己的业务处理器。

## 独立使用

```bash
bun add @cjhyy/code-shell-chat
```

```ts
import { ChatGateway, createAllowlistMiddleware } from "@cjhyy/code-shell-chat";
import { TelegramAdapter } from "@cjhyy/code-shell-chat/telegram";

const telegram = new TelegramAdapter({ botToken: process.env.TELEGRAM_BOT_TOKEN! });
const chat = new ChatGateway({ adapters: [telegram] });

chat.use(
  createAllowlistMiddleware({
    telegram: { targetIds: [process.env.TELEGRAM_CHAT_ID!] },
  }),
);
chat.use(async ({ message, reply }) => {
  await reply({ text: `echo: ${message.text}` });
});

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
await chat.run(shutdown.signal);
```

第三方也可以实现 `ChannelAdapter` 接入新平台，或用 middleware 接自己的 Agent、Webhook、工单系统与自动化服务。

## CodeShell integration

包内置了可选的 `@cjhyy/code-shell-chat/codeshell` integration 和 `code-shell-chat` CLI。
在 CodeShell Desktop 中可直接进入「凭证 → Link → CodeShell Chat Gateway」查看全部支持渠道、
逐渠道连接状态和接入说明，一键打开可用平台的官方配置后台，启动/停止 gateway、编辑配置，
或扫码连接个人微信；卡片还会显示本次桌面运行中最近的收发消息。无需再单独打开终端运行 CLI。
CLI 会把普通文字和附件转到桌面端的 Mimi Pet 长期会话，并把最终文字回复送回原 IM 会话。
不同渠道继续共享 Mimi 的长期上下文，但每条入站消息会标明来源渠道，当前消息来源也会进入
Mimi 的运行时上下文，避免多渠道同时使用时无法分辨入口。
`/open`、`/close`、`/status` 仍作为确定性快捷入口；“帮我打开手机遥控”“关闭公网入口”
和“看看手机遥控状态”等明确自然语言也会触发相同操作。mobile remote 继续复用 tunnel +
pairing + passcode，并把 10 分钟一次性配对入口作为按钮回到原会话。

当前富媒体纵向链路覆盖个人微信和 Telegram 的入站图片、文件、语音、视频。附件在 sender/
target 白名单通过后才按需下载，受数量、单文件、总大小和超时限制；随后由 Electron main 校验并
暂存到 Pet 会话的 `.code-shell/attachments` 目录。文字回复、按钮和桌面隧道状态通知可主动回发；
尚无统一上传协议的平台继续以文字/链接表达结果。

CLI 不直接拥有 `cloudflared` 或 mobile WebSocket host。Electron main 仍是生命周期唯一
owner，并通过 `~/.code-shell/im-gateway/desktop-control.json`（`0600`）提供随机 bearer token
保护的 loopback control API。CLI 与 Desktop 使用同一个原子进程锁，不能同时消费平台更新。

## 支持的渠道

所有渠道可以在同一 gateway 进程中同时启用，每个渠道有独立的会话和用户白名单。

| 渠道              | 官方接入方式                     | 公网 webhook               |
| ----------------- | -------------------------------- | -------------------------- |
| Telegram          | Bot API `getUpdates` 长轮询      | 不需要                     |
| Discord           | Gateway + REST                   | 不需要                     |
| Slack             | Socket Mode + Web API            | 不需要                     |
| 飞书 / Lark       | 官方 SDK WebSocket 长连接        | 不需要                     |
| 钉钉              | Stream Mode                      | 不需要                     |
| 个人微信          | 腾讯 ClawBot iLink + 扫码登录    | 不需要                     |
| 企业微信          | 智能机器人 WebSocket 长连接      | 不需要                     |
| Matrix            | Client-Server API `/sync`        | 不需要                     |
| Mattermost        | WebSocket events + REST          | 不需要                     |
| LINE              | Messaging API webhook            | 需要，`/webhooks/line`     |
| WhatsApp Business | Meta Cloud API webhook           | 需要，`/webhooks/whatsapp` |
| Microsoft Teams   | Bot Framework messaging endpoint | 需要，`/webhooks/teams`    |

个人微信使用腾讯 ClawBot 公开的 iLink Bot 协议，不接逆向 Web 协议。首次使用先执行：

```bash
code-shell-chat wechat login
```

终端会显示二维码，用手机微信扫码并确认。token 保存在 owner-only 凭据文件中，不写入
gateway 配置。登录命令会自动增加 `wechat.accountId`，扫码者默认成为唯一允许的用户。
`@cjhyy/code-shell-chat/wechat` 同时导出 `loginWechatWithQr`、`WechatAdapter` 和
`FileWechatCredentialStore`，第三方应用可以完全不使用 CodeShell CLI。协议实现对齐
[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 2.4.x 的公开文档。

## CodeShell CLI 配置

创建 `~/.code-shell/im-gateway/config.json` 并设置为 `0600`。只需保留实际启用的平台：
Desktop 的「编辑配置」会生成包含所有渠道的模板；在模板里把要使用的渠道设为
`"enabled": true` 并填写凭据和白名单即可，未启用的占位配置不会加载。

```json
{
  "telegram": {
    "botToken": "123456:replace-me",
    "allowedChatIds": ["123456789"],
    "allowedUserIds": ["123456789"]
  },
  "discord": {
    "botToken": "replace-me",
    "allowedChannelIds": ["channel-id"],
    "allowedUserIds": ["user-id"]
  },
  "slack": {
    "botToken": "xoxb-replace-me",
    "appToken": "xapp-replace-me",
    "allowedChannelIds": ["C0123456789"],
    "allowedUserIds": ["U0123456789"]
  },
  "lark": {
    "appId": "cli_replace_me",
    "appSecret": "replace-me",
    "allowedChatIds": ["oc_chat_id"],
    "allowedUserIds": ["ou_open_id"]
  },
  "dingtalk": {
    "clientId": "replace-me",
    "clientSecret": "replace-me",
    "allowedConversationIds": ["cid_replace_me"],
    "allowedUserIds": ["staff-id"]
  },
  "wecom": {
    "botId": "replace-me",
    "secret": "replace-me",
    "allowedChatIds": ["chat-id-or-user-id"],
    "allowedUserIds": ["user-id"]
  },
  "wechat": {
    "accountId": "generated-by-wechat-login"
  },
  "matrix": {
    "homeserverUrl": "https://matrix.example.com",
    "accessToken": "replace-me",
    "botUserId": "@codeshell:example.com",
    "allowedRoomIds": ["!room:example.com"],
    "allowedUserIds": ["@owner:example.com"]
  },
  "mattermost": {
    "serverUrl": "https://mattermost.example.com",
    "botToken": "replace-me",
    "botUserId": "bot-user-id",
    "allowedChannelIds": ["channel-id"],
    "allowedUserIds": ["owner-user-id"]
  },
  "line": {
    "channelSecret": "replace-me",
    "channelAccessToken": "replace-me",
    "allowedTargetIds": ["group-room-or-user-id"],
    "allowedUserIds": ["owner-user-id"]
  },
  "whatsapp": {
    "accessToken": "replace-me",
    "appSecret": "replace-me",
    "verifyToken": "choose-a-random-value",
    "phoneNumberId": "replace-me",
    "apiVersion": "v25.0",
    "allowedPhoneNumbers": ["8613800000000"]
  },
  "teams": {
    "appId": "replace-me",
    "appPassword": "replace-me",
    "appType": "MultiTenant",
    "allowedConversationIds": ["conversation-id"],
    "allowedUserIds": ["aad-or-channel-user-id"]
  },
  "webhook": {
    "host": "127.0.0.1",
    "port": 8787,
    "maxBodyBytes": 1048576
  },
  "runtime": {
    "maxPending": 1000,
    "maxConcurrent": 4,
    "maxPerTarget": 1,
    "maxMessagesPerUserPerMinute": 20
  },
  "notifications": {
    "enabled": true,
    "targets": {
      "telegram": ["123456789"]
    }
  }
}
```

每个已启用渠道都必须配置 target 白名单；`allowedUserIds` 可选，但群聊强烈建议配置。
未知会话和用户会被静默忽略。配置文件包含 bot secret、允许远程拉起桌面端的命令，非 Windows
系统只接受 `0600` 权限。

可序列化的文字入站会先原子写入 `~/.code-shell/im-gateway/inbox.json`，webhook 平台随后才会
收到确认；相同平台 message ID 会持久去重。处理采用有界队列、全局并发和 per-target 串行，
暂时失败按指数退避重试。含惰性媒体 loader 的消息保留在内存队列，媒体仍受平台重投策略约束。
`notifications.targets` 只能引用已启用渠道且必须同时位于该渠道 target 白名单。Desktop 主动
通知游标会按事件流实例原子写入 `~/.code-shell/im-gateway/desktop-events.json`（可用
`runtime.eventCursorPath` 覆盖）；Gateway 重启后续传，Desktop 重启时会识别新事件流并重置游标。

所有字段都有 `CODE_SHELL_<CHANNEL>_*` 环境变量对应项；数组使用逗号分隔。例如：

```bash
export CODE_SHELL_DISCORD_BOT_TOKEN='replace-me'
export CODE_SHELL_DISCORD_ALLOWED_CHANNEL_IDS='channel-1,channel-2'
export CODE_SHELL_DISCORD_ALLOWED_USER_IDS='owner-user-id'
```

也可用 `CODE_SHELL_IM_GATEWAY_CONFIG` 指定配置路径。完整环境变量名以
[`src/config.ts`](./src/config.ts) 为准。

### Webhook 渠道

LINE、WhatsApp、Teams 要求一个固定公网 HTTPS origin。gateway 默认仅监听
`127.0.0.1:8787`，应由同机的反向代理或固定隧道暴露上表中的 path。手机遥控使用的
Cloudflare quick tunnel 指向 mobile host、URL 也会变化，不能当作这些平台的 webhook origin。

- LINE POST 请求校验 `x-line-signature`；
- WhatsApp 支持 GET challenge，并用 app secret 校验 `x-hub-signature-256`；
- Teams 使用官方 Bot Framework SDK 校验 bearer JWT 和 channel identity；
- request body 默认最多 1 MiB，且 webhook server 有请求超时。

本地探针为 `GET /healthz` 与 `GET /readyz`；探针不会由生成的公网 ingress 暴露。生成固定
HTTPS 反向代理配置：

```bash
code-shell-chat ingress print --host chat.example.com --format caddy
# 或 --format nginx；upstream 只允许 loopback host:port
```

## 平台侧最低要求

- Discord 需启用 Message Content intent；gateway 启动时会补注册 `/open`、`/close`、`/status`
  application commands；
- Slack app 需启用 Socket Mode、订阅 message events、注册三个同名 slash commands，并给 bot
  `chat:write`；
- 飞书需开启机器人能力、订阅 `im.message.receive_v1`，选择长连接接收事件；
- 钉钉应用机器人选择 Stream 模式；
- 企业微信使用智能机器人长连接的 bot ID + secret；
- 个人微信需先运行 `code-shell-chat wechat login`，支持二维码确认和手机数字验证；
- Telegram 不得同时配置 webhook，因为 webhook 与 `getUpdates` 互斥；
- WhatsApp 自由格式回复受 Cloud API 的 customer-care window 约束。

## 运行

桌面端需要先设置 mobile remote 访问口令。macOS 默认用 `open -a code-shell` 拉起离线桌面端；
其他安装方式可覆盖 `desktop.command` 和 `desktop.args`。

```bash
bun run --filter '@cjhyy/code-shell-chat' build
node packages/chat/dist/cli.js
```

也可以直接开发运行：

```bash
bun run --filter '@cjhyy/code-shell-chat' dev
```

安装为当前用户的常驻服务（macOS launchd、Linux systemd user、Windows Task Scheduler）：

```bash
code-shell-chat service install
code-shell-chat service status
code-shell-chat service uninstall
```

服务定义不写入 secret，只引用 owner-only 配置；运行时单实例锁会阻止 Desktop 与 daemon 双开。

真实平台发布前运行凭据 canary。命令会生成随机 nonce；在每个启用 channel 的白名单会话中发送
提示的 `/canary <nonce>`，只有真实入站、验签/鉴权、allowlist 和真实回发全部成功才会通过：

```bash
code-shell-chat canary --timeout-ms 600000
```
