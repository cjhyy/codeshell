# IM Gateway — IM 遥控开隧道 + 手机操作(对标 openclaw)

> 状态:**Phase 1 + 主流 channel adapters 已实现**。设计稿 2026-07-02；实现 2026-07-13。
> 已落地：`packages/chat` / `@cjhyy/code-shell-chat`（可独立使用的通用 runtime、12 个 channel、白名单）+
> Electron main 鉴权 loopback 控制面；真实平台凭据 E2E 与 launchd/systemd 仍属后续阶段。
> 定位:前瞻方向,和「统一 assistant 主体」那份整体产品形态 design 强绑;本稿只定
> **IM gateway 这条通道**,编排大脑显式委托给未来的 assistant 主体(见 §6 衔接口)。
> 关联现状记忆:`project_mobile_remote_tunnel`、`project_mobile_ui_react_rebuild`、
> `project_schedule_decouple_from_cc_room`。

## 一、背景与目标

第一个测试版已发。当前手机遥控链路要**人先到桌面手动开隧道**(设置里切 tunnel 模式)。
目标:做一个 **gateway**(对标 openclaw),让你**不在电脑旁**时也能:

1. 在 **IM**(Telegram / 飞书-Lark / …)里发一条指令 → gateway **远程拉起隧道**;
2. gateway 把**手机配对入口(链接/QR)发回 IM** → 你手机点开就能操作 codeshell;
3. 反向:隧道状态、关键通知回推到 IM。

**一句话边界**:gateway 是**通道 + 生命周期编排**,不是大脑。IM 里的高阶指令(指挥
所有 session、聊 AI)由**未来的 assistant 主体**处理,gateway 只负责把 IM 消息路由过去
并把结果回推(见 §6)。

## 二、关键前提:下游全已存在(已核实)

本设计**几乎不碰下游**,只在前面挂一个 IM 控制入口。已有(均在 Electron main
`packages/desktop/src/main/mobile-remote/`):

| 已有能力                | 位置                                             | 说明                                                                                       |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Cloudflare 隧道生命周期 | `tunnel-manager.ts`                              | `cloudflared` 临时隧道,start/stop/crash 事件、`/ready` 探活、域名提取;不自动重启(设计决策) |
| cloudflared 二进制管理  | `cloudflared-binary.ts`                          | 缺则下载 + SHA-256 校验 + chmod                                                            |
| 手机 WebSocket host     | `remote-host-manager.ts`                         | HTTP+WS server;tunnel 模式绑 `127.0.0.1` + passcode gate                                   |
| 配对/设备鉴权           | `trusted-device-store.ts` / `access-passcode.ts` | pairing token(10min 一次性)+ 设备 secretHash + passcode scrypt+锁定                        |
| 房间/会话驱动           | `room-manager.ts`                                | room.create/open/close/send;session.list/select/chat.send;approval.respond                 |
| 启停 IPC                | `index.ts` `mobileRemote:start/stop`             | 已有 in-flight mutex 防并发启停                                                            |

已新增独立 gateway 包与多 adapter runtime：Telegram、Discord、Slack、飞书/Lark、钉钉、
企业微信、Matrix、Mattermost 使用长轮询/长连接；LINE、WhatsApp Business、Teams 共用带验签/
官方认证的 webhook ingress。个人微信已通过腾讯 ClawBot 公开 iLink Bot 协议实现扫码登录、长轮询与回复，不接逆向 Web 协议。

## 三、形态:独立常驻进程

`@cjhyy/code-shell-chat` 首先是可被任意 Node.js/Bun 应用单独安装的库；CodeShell 只是一个可选 integration。
`code-shell-chat` CLI 则是**独立的轻量常驻进程**(可 headless),不是 Electron main 里的一个模块。理由:
要在 app 没开、你不在电脑旁时也能收 IM 指令并拉起隧道。这更接近 openclaw 真形态。

代价与正解(需在实现计划里落实):

- **谁真正拥有 tunnel/host**:目前它们在 Electron main。两条路子——
  - (A) gateway 通过**受控 IPC/本地 RPC** 唤起 main 里现有的 `mobileRemote:start`(需 app 能被
    gateway 拉起或已在跑);
  - (B) 把 tunnel/host 从 main **抽成可被 gateway 直接复用的进程内/子进程能力**。
  - **MVP 倾向 (A)**:零重构复用现有接线,gateway 只做「唤起 + 路由 + 回推」。(B) 留给
    「assistant 主体」整体形态时再决定,避免和那份 design 抢架构决策。
- **进程守护**:gateway 需能被系统级拉起(launchd/systemd/开机自启),否则「不在电脑旁」的前提不成立。此项列入未决。

## 四、组件边界

```
IM 平台 ──webhook/长连接──▶ [IM Adapter] ──▶ [Gateway Core] ──▶ [唤起 tunnel + host(复用现有)]
   ▲                            (收/发)          (命令面/鉴权)              │
   └────────── 回推(QR/状态/通知)◀──────────────────────────────────────┘
                                                     │
                                                     ▼
                                        [assistant 主体(未来·§6)] ◀── 高阶指令委托
```

1. **IM Adapter(抽象层)** — 定义统一接口:`receive(msg) → GatewayCommand` / `send(target, payload)`。
   **先做抽象,再接具体**:
   - 长连接：Telegram、Discord、Slack、飞书/Lark、钉钉、企业微信、Matrix、Mattermost；
   - webhook：LINE、WhatsApp Business、Teams；
   - 个人微信使用腾讯 ClawBot iLink Bot 公开协议，支持扫码/数字验证；企业微信继续使用官方长连接。
     adapter 只做**协议转码 + 鉴权**,不含业务。
2. **Gateway Core** — 命令面(见 §5)、发起方鉴权(IM 用户白名单)、隧道/手机入口编排、
   把非「开关类」指令**委托给 assistant 主体**、状态回推。
3. **复用层** — 现有 tunnel-manager / remote-host-manager / pairing / passcode,原样复用。

## 五、命令面(MVP 收窄)

gateway **自己只处理开关与入口**类指令;其余转发。MVP:

- `/open`(或自然语言等价)→ 拉起隧道 → 生成 pairing 链接/QR → 发回 IM;
- `/close` → 关隧道;
- `/status` → 回隧道 + 已连设备状态;
- 其他消息 → **路由给 assistant 主体**(§6);主体不在时回「暂不支持,请在手机端操作」。

**明确不做**(MVP):在 IM 里碎碎地直接聊 AI、逐条审批回流——这些要么走手机端,要么等
assistant 主体接管。

## 六、与「assistant 主体」的衔接口(本稿不定义,只留口)

你后续会新增一个 **assistant 主体**:一个能**指挥所有 session** 的中枢(有整体产品形态
design)。gateway 与它的关系:

- gateway 是 assistant 主体的**入口通道之一**(IM),隧道+手机是另一条操作路径;
- gateway **不做编排大脑**,把高阶指令(跨 session 指挥、对话)透传给主体,拿回结果回推 IM;
- 衔接口预留为一个抽象:`dispatchToAssistant(command, context) → stream/result`。具体协议、
  主体如何管理 session,**由那份整体 design 定义**,本稿不锁死,避免两份 design 打架。

> ⚠️ 实现顺序建议:先落 gateway 的**开关+入口** MVP(不依赖主体),主体 ready 后再接 §6。

## 七、安全

- **发起方鉴权**:IM 侧限定用户/群白名单(chat_id / open_id 白名单),非白名单指令直接丢弃。
- **复用现有隧道安全**:passcode gate + pairing 一次性 + 设备 secretHash + `127.0.0.1` 绑定,
  全部沿用,不降级。
- **secret 落盘**:IM token / bot secret 按现有凭证约定落盘(`userHome()`、0o600、不入日志;
  参照 `redactSecrets`/`test_pollutes_real_settings`)。
- **回推内容脱敏**:发回 IM 的状态/QR 不含敏感 token 明文。

## 八、错误处理

- 隧道拉起失败(二进制缺/端口占/edge 未就绪)→ 回 IM 明确错误 + 不留孤儿进程。
- IM adapter 收发失败 → 重试有上限,失败落日志,不阻塞其他指令。
- gateway ↔ main 通道(方案 A)断开 → 回 IM「桌面端未在线」,不静默吞。

## 九、不做 / 未决(YAGNI + 待整体 design 拍板)

- **不做**:IM 内富交互审批 UI、多租户、gateway 自带编排大脑(归 assistant 主体)。
- **未决(等整体产品形态 design)**:
  - tunnel/host 是否从 main 抽出(§三 A vs B);
  - gateway 进程守护方式(launchd/systemd/开机自启);
  - assistant 主体的 §6 协议细节;
  - 是否上云中继(openclaw 云模式)—— 当前默认纯本地 gateway。

## 十、分阶段

- **Phase 1(MVP，已实现)**:IM Adapter 抽象 + Telegram + `/open /close /status` + 复用现有隧道/配对,
  方案 A 唤起 main。交付「IM 发指令→拉隧道→手机入口回 IM→手机操作」闭环。
- **Phase 2(adapters 已实现)**:补齐 11 个主流 channel；剩余真实平台凭据 E2E 与 gateway
  进程守护(开机自启)。
- **Phase 3**:接 §6 assistant 主体,IM 里可下高阶跨 session 指令。
