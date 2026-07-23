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

配置驱动的 host 应使用异步工厂；它只会动态加载实际选择的平台模块：

```ts
import { createChannelAdapterAsync } from "@cjhyy/code-shell-chat/factory";

const telegram = await createChannelAdapterAsync({
  channel: "telegram",
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  apiBaseUrl: "https://api.telegram.org",
  allowedTargetIds: [process.env.TELEGRAM_CHAT_ID!],
  allowedUserIds: [],
});
```

旧的同步 `createChannelAdapter()` 继续兼容，但返回的是首次 `run`、`send` 或 webhook 请求时
才加载具体平台的轻量代理。内置 CLI 和 Desktop 已使用异步入口，因此启动阶段会直接报告所选
adapter 的模块加载或构造错误。

当前各平台 SDK 仍是默认依赖：动态加载减少的是未启用平台的模块求值、副作用和启动开销，
不是安装体积。暂不改成 peer/optional dependency，是为了保证标准 `bun add
@cjhyy/code-shell-chat` 和内置 CLI 安装后仍可直接启用任一支持渠道；后续若拆独立 adapter
包，需要同时提供安装检测和明确的按渠道安装指引。

## CodeShell integration

包内置了可选的 `@cjhyy/code-shell-chat/codeshell` integration 和 `code-shell-chat` CLI。
在 CodeShell Desktop 中可直接进入「凭证 → Link → CodeShell Chat Gateway」查看全部支持渠道、
逐渠道连接状态和接入说明，一键打开可用平台的官方配置后台，启动/停止 gateway、编辑配置，
或扫码连接个人微信；卡片还会显示本次桌面运行中最近的收发消息。无需再单独打开终端运行 CLI。
钉钉渠道提供独立的结构化向导：填写应用凭据后可建立临时 Stream 连接，通过向机器人发送
测试消息自动发现 `conversationId` 和 `senderStaffId`，勾选后保存白名单并启动。Desktop 会把
Client Secret 放入 CodeShell 安全凭据库（系统支持时使用系统加密），`config.json` 只保留
Client ID 和白名单；旧版配置中的
明文 Secret 会在首次使用新向导保存时迁移。独立 CLI 继续支持配置文件或
`CODE_SHELL_DINGTALK_CLIENT_SECRET` 环境变量。
CLI 会把普通文字和附件转到桌面端的 Mimi Pet 长期会话。Mimi 先通过只读 `Gateway` 工具发现
本进程已启用的渠道及某一渠道的精确能力，需要回复时再用 `GatewayReply` 把结果送回原 IM
会话。
不同渠道继续共享 Mimi 的长期上下文，但每条入站消息会标明来源渠道，当前消息来源也会进入
Mimi 的运行时上下文，避免多渠道同时使用时无法分辨入口。
`/open`、`/close`、`/status` 仍作为确定性快捷入口；“帮我打开手机遥控”“关闭公网入口”
和“看看手机遥控状态”等明确自然语言也会触发相同操作。mobile remote 继续复用 tunnel +
pairing + passcode，并把 10 分钟一次性配对入口作为按钮回到原会话。

富媒体纵向链路现在覆盖绝大多数内置渠道。附件在 sender/target 白名单通过后才按需下载，
受数量、单文件、总大小和超时限制；随后由 Electron main 校验并暂存到 Pet 会话的
`.code-shell/attachments` 目录。Mimi 仅在对应 IM 回合显式调用 `GatewayReply` 后，由宿主
校验并发送项目、no-repo 或用户 Downloads 目录中的本地图片、文件、音频或视频；任务
产物记录本身不会触发回传。

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

### Gateway 能力矩阵

下表描述的是 CodeShell 当前适配器已经实现并经过测试的能力，不代表上游平台 API 的全部潜在
功能。Gateway 通过 `ChannelAdapter.capabilities` 把同一份声明用于 QR、附件过滤、主动通知和
Pet 的两层工具；Pet 不再按渠道名猜测能力。

| 渠道              | 入站附件               | 出站文字/链接       | 出站附件               | 路由/实现限制                                                |
| ----------------- | ---------------------- | ------------------- | ---------------------- | ------------------------------------------------------------ |
| Telegram          | 图片、文件、音频、视频 | 文字、原生按钮      | 图片、文件、音频、视频 | 已知 chat 可回复或主动推送                                   |
| Discord           | 图片、文件、音频、视频 | 文字、原生按钮      | 图片、文件、音频、视频 | 需 `Attach Files`；已知 channel                              |
| Slack             | 图片、文件、音频、视频 | 文字、原生按钮      | 图片、文件、音频、视频 | 需 `files:read/files:write`；已知 channel                    |
| 飞书 / Lark       | 图片、文件、音频、视频 | 文字、原生按钮      | 图片、文件、音频、视频 | 需消息资源读取和图片/文件上传权限                            |
| 钉钉              | —                      | 文字、ActionCard    | —                      | Stream 临时 session webhook 不承载本地媒体                   |
| 企业微信          | 图片、文件、视频       | 文字、Markdown 链接 | 图片、文件、音频、视频 | 入站语音当前协议只提供转写；出站音频按文件发送               |
| 个人微信          | 图片、文件、音频、视频 | 文字、普通链接      | 图片、文件、音频、视频 | 音频按可播放文件发送；依赖 `context_token`                   |
| Matrix            | 图片、文件、音频、视频 | 文字、HTML 链接     | 图片、文件、音频、视频 | 当前媒体管线不解密 E2EE 附件                                 |
| Mattermost        | 图片、文件、音频、视频 | 文字、Markdown 链接 | 图片、文件、音频、视频 | 需 bot 文件上传权限                                          |
| LINE              | 图片、文件、音频、视频 | 文字、按钮模板      | —                      | 出站媒体需另配公网 HTTPS 媒体存储，未虚报为已支持            |
| WhatsApp Business | 图片、文件、音频、视频 | 文字、CTA 按钮      | 图片、文件、音频、视频 | 受 customer-care window 约束                                 |
| Microsoft Teams   | 图片、文件、音频、视频 | 文字、Markdown 链接 | 图片                   | Bot Framework 内联图片；其他文件需另接 Graph/SharePoint 流程 |

出站附件统一限制为每次最多 4 个、通常单个最多 10 MiB；Teams 内联图片遵循平台的 1 MiB
上限。适配器遇到未声明的附件类型会明确报错，Gateway 在调用适配器前会按能力过滤
Desktop/Pet 产物。

Pet 使用两层渐进式工具：

1. 只读 `Gateway`：`search` 只在本回合实际授予的渠道中查询，不带 query 时返回全部渠道名，
   也可用 `outbound:image`、`inbound:file`、`button:native` 等条件过滤；`describe` 再返回一个
   匹配渠道的精确入站/出站契约。能力目录每回合从当前适配器集合重建，只含渠道名和能力，
   不传递 token、白名单或会话 target。
2. 有副作用的 `GatewayReply`：只绑定当前入站消息的原会话，一次声明完整文字、可选 URL 按钮
   和可选本地附件。它不能借第一层目录向其他渠道或其他 target 任意发送。

普通纯文字回复可以直接进入第二层；富媒体能力不确定、或用户询问另一个已启用渠道时，Mimi
先查询第一层。Gateway 按当前路由动态移除 `GatewayReply` 不支持的附件参数，并在真正调用
适配器前再次校验。
工具文字最多 8000 字，Gateway 使用 1800 字的跨渠道安全分片发送，按钮和附件只跟随最后一片；
中途失败时从未发送的分片续传，不会重新运行 Pet 或重复已经送达的前半段。需要多次
平台 API 调用的文字+媒体组合也会记录已完成子步骤，同一进程内重试时从失败子项继续。

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

也可用 `CODE_SHELL_IM_GATEWAY_CONFIG` 指定配置路径。完整环境变量名以仓库中的
[`packages/chat/src/config.ts`](https://github.com/cjhyy/codeshell/blob/main/packages/chat/src/config.ts)
为准。

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
