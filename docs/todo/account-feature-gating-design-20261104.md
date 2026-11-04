# 账号功能统一开关设计

状态：2026-11-04 决策已确认，按下述顺序分批实施。服务端改动在 `codeshell-services/apps/account-server`，
客户端改动在本仓库 Desktop（main、preload、renderer）、TUI、`serve` 与 `packages/web`。本文是
[账号上下文机制设计](account-context-distribution-design.md) 中
`codeshell.account.capabilities` 模块的先行落地：先用现有 overview 接口交付，
以后迁入通用 context 传输，客户端 hook 的接口保持不变。

## 目标

1. 所有需要账号的功能都用同一种方式判断“这个入口要不要显示、能不能用”。
2. 服务端一处配置决定某个功能在这套部署里是否开放、对哪些账号开放，客户端入口
   跟着出现或消失，不再为每个功能改代码。
3. 本地使用永远不需要账号；退出账号或服务不可用只停止云上与远程部分，不删除、
   不阻断本地数据和本地任务。

不在本文范围：计费与套餐、团队、多用户云端 Runtime 的权限模型、管理员灰度与账号白名单。

## 已确认决策（2026-11-04）

1. Desktop、TUI 和 `serve` 都支持可选账号登录；本地能力继续免登录。
2. 暂不处理新功能试用人群，不实现管理员灰度、指定账号名单或
   `ACCOUNT_FEATURE_AUDIENCE`。首版已部署的功能对通过原有鉴权的账号开放；账号层接口
   保留，后续增加权益规则时不改客户端调用。
3. 各客户端的“注册账号”统一引导到所选账号服务对应的网页注册入口。客户端保留登录、
   状态和退出能力，不再各维护一套注册表单。

第 3 项是注册入口的产品决策；`sync.mimi`、`sync.history` 的加密方案仍待定，
在实现和验收前不开放这两个功能。套餐数据来源同样保留待定。

## 现状：判断分散在四处

| 功能                                  | 现在怎么判断                                                      | 问题                                       |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| 执行电脑 / 设备（电脑派任务给另一台） | #281 `useAccountDeviceEntry` 读中继状态 `ready + accountId`       | 只看本机中继，不知道服务端是否对该账号开放 |
| 手机经账号中继访问                    | `DeviceRelaySettings` 读 `/status` 的 `relay.enabled`             | 与上一行各读一次，规则不同                 |
| 远程 Link                             | main 在执行时 `requireLinkAccountAccess` 抛“请先登录”             | 入口始终可见，点了才报错                   |
| 云端项目                              | `NewProjectDialog` / `CloudProjectManager` 显示登录提示，地址手填 | 不知道服务端是否已部署云端，手填地址       |

服务端已有的能力字段也分在两处：

- 匿名 `GET /api/v1/account/status`：`registrationAllowed`、`githubEnabled`、
  `githubLinkEnabled`、`linkManagementEnabled`、`profileEnabled`、`relay{enabled,…}`。
- 登录后 `GET /api/v1/account/overview`：`capabilities{sessions,passwordChange,admin,links}`、
  `relay`；网页会话另带 `cloudTarget{enabled,cloudOrigin,…}`。

## 三层判断

一个功能能否使用由三层共同决定，缺一层就降级：

| 层             | 谁决定           | 例子                             | 来源                      |
| -------------- | ---------------- | -------------------------------- | ------------------------- |
| 部署是否提供   | 服务端配置       | 中继开了没有、云端部署了没有     | `/status` 的 `features`   |
| 该账号是否有权 | 服务端按账号计算 | 首版沿用现有鉴权，以后可扩展权益 | `/overview` 的 `features` |
| 本机是否就绪   | 各客户端 Host    | 本机中继已连上、安全凭据存储可用 | Host 本地状态             |

客户端把三层合成一个结果，界面只认这个结果：

| 结果      | 含义                                                                   | 入口表现                                     |
| --------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `hidden`  | 部署不提供、该账号无权、当前 Host 不支持、客户端不认识或协议版本不兼容 | 不渲染入口                                   |
| `sign-in` | 部署提供且当前 Host 支持，但没登录                                     | 显示“登录后可用”，引导到当前客户端的登录入口 |
| `pending` | 已登录且有权，本机未就绪或服务暂不可达（未登记、中继连接中、断线）     | 显示但禁用，带原因和独立的设置/重试操作      |
| `ready`   | 三层都满足                                                             | 正常使用                                     |

入口是否显示只是界面行为。服务端每个受保护的接口仍然独立鉴权，不能因为客户端
显示了入口就放行。

## 功能清单（feature id）

id 一经发布不改名；废弃时服务端停止下发，客户端视为 `hidden`。

| id                    | 功能                                      | 优先级 | 部署条件                           | 本机条件         | 现状               |
| --------------------- | ----------------------------------------- | ------ | ---------------------------------- | ---------------- | ------------------ |
| `links.remote`        | 远程 Link（GitHub、Figma 等经 Link 服务） | 已有   | Link 管理或登录授权交接已配置      | 无               | 已上线，入口待迁移 |
| `cloud.projects`      | 云端项目                                  | 已有   | 云端控制已配置，下发 `cloudOrigin` | 无               | 未完整部署         |
| `relay.phone`         | 手机经账号中继访问本机                    | 已有   | 中继已开启                         | 本机已登记       | 生产未开中继       |
| `devices.dispatch`    | 电脑派任务给另一台                        | 已有   | 中继已开启                         | 本机中继 `ready` | 入口已隐藏（#281） |
| `devices.directory`   | 设置里的“我的电脑”：查看、改名、撤销      | P1     | 中继已开启                         | 无               | 服务端接口已有     |
| `devices.handoff`     | 对话连同 Git 状态转到另一台电脑           | P1     | 迁移能力已实现且中继已开启         | 两端中继 `ready` | 未开始             |
| `notify.push`         | 任务完成、等待批准时推送到手机            | P1     | 推送通道已配置                     | 手机已配对       | 未开始             |
| `sync.preferences`    | 主题、语言同步                            | P2     | context 偏好模块                   | 用户开启         | 有设计稿           |
| `sync.mimi`           | Mimi 记忆与角色设置同步                   | P2     | 加密方案定稿                       | 用户开启         | 未开始             |
| `sync.history`        | 对话历史备份与多端查看                    | P2     | 加密方案定稿                       | 用户开启         | 未开始             |
| `market.publish`      | 面板、插件、技能发布与评分                | P3     | 市场服务                           | 无               | 未开始             |
| `characters.licensed` | 需授权的角色包下载                        | P3     | 角色分发服务                       | 无               | 未开始             |
| `cloud.fallback`      | 电脑离线时转云端继续                      | P3     | 依赖 `cloud.projects`              | 无               | 未开始             |

明确不进清单（永远不要求账号）：本地聊天、自带密钥的模型、工具与 MCP、本地面板、
Mimi、电脑操作、TUI 的本地使用、`serve` 的本地/自托管功能，以及局域网或临时隧道的手机配对。
TUI 与 `serve` 仅在用户使用账号关联的远程/云端能力时要求登录。

## 服务端（codeshell-services）

### 下发格式

`/status` 与 `/overview` 各新增一个 `features` 对象，旧字段保留至少一个发布周期：

```json
{
  "features": {
    "devices.dispatch": { "version": 1, "enabled": true },
    "cloud.projects": {
      "version": 1,
      "enabled": true,
      "params": { "cloudOrigin": "https://cloud.example" }
    },
    "notify.push": { "version": 1, "enabled": false, "reason": "not_configured" }
  }
}
```

- `/status`（匿名）：只表达部署层，`enabled` 表示这套部署是否提供。
- `/overview`（登录后）：部署层与账号层合并后的结果。
- `version` 是该功能的客户端协议版本。客户端只接受自己支持的版本，否则视为 `hidden`，
  避免旧客户端打开不兼容的新流程。
- `params` 只放公开配置（地址、协议版本），不放任何凭据。字段由注册表白名单约束。
- `reason` 是固定枚举（`not_configured`、`not_entitled`、`disabled_by_operator`），
  给界面选文案用，不是给人读的句子。

### 注册表

新增 `apps/account-server/features.mjs`，每个功能一项：

```js
export const FEATURES = {
  "devices.dispatch": {
    version: 1,
    offered: (context) => context.relayCapability.enabled === true,
    params: () => ({}),
  },
  // …
};
```

- `offered(context)` 从成功初始化的服务和现有配置推导，不新增常规“开关”环境变量：
  中继看 `relayCapability.enabled`，Link 看 `linkManagement` 或 OAuth helper 的
  `linkEnabled`（兼容只配置登录后 Link 授权交接的旧部署），云端看 `cloudAuthority`；
  不能仅因环境变量或配置对象存在就认为服务可用。
- 账号层：首版不增加试用人群配置，保留原有会话、资源归属和操作权限检查。
  `not_entitled` 预留给后续账号权益；本轮不实现管理员灰度或指定账号名单。
- 运维紧急关闭：`ACCOUNT_FEATURE_DISABLED="devices.handoff"`，命中时 `enabled:false`、
  `reason:"disabled_by_operator"`。首版启动时读取配置，更新后需重启相应服务；
  在重新授权、兑换及后续受保护请求时拒绝，不宣称动态配置推送或即时撤销所有存量授权。

### 服务端强制

新增 `requireFeature(principal, id)`，受保护接口入口处调用，失败返回
已配置但被关闭时返回 `403 feature_not_entitled`；未登录仍沿用认证层的 `401`，
未配置服务保留现有 `503` 兼容行为。第一批接到：设备访问 handoff
签发、设备目录管理、Link 管理、云端授权签发。设备访问 handoff 属于现有远程访问流程，
不能误用尚未实现的“对话连同 Git 状态转移”功能 `devices.handoff`。中继建立设备会话时
按用途检查 `devices.dispatch` / `relay.phone`。紧急关闭必须在对应服务端授权路径生效，
不只改变入口显示；退出、撤销和清理权限不因功能关闭而丢失。

本批 `links.remote` 约束 Account 的 Link 管理读取和新的登录授权交接；独立 Link 服务
已经签发的 OAuth grant 仍按自己的授权规则执行，需用既有撤销接口回收。这个开关不等同
于独立 Link 服务的运行时全局切断。云端控制面和中继仍保留原有认证、归属和会话校验。

未实现的功能即使列在注册表中也返回 `enabled:false`、`reason:"not_configured"`；
例如中继已部署不代表 `devices.handoff` 已可用。

## 各客户端的登录与网页注册

- Desktop、TUI、`serve` 复用纯 Node 的账号客户端与功能合成逻辑；从现有 Desktop
  账号管理器提取到 `packages/server` 的专用 account 子入口，Electron 的安全存储、
  打开浏览器和窗口事件作为适配器注入。Core 不依赖账号服务。
- Desktop 保留账号登录入口；TUI 提供账号登录、状态和退出命令；`serve` 支持由运行
  服务的本机用户管理账号会话。命令命名和交互在客户端 PR 中落实。
- 无浏览器的终端或服务主机显示可复制的网址。网页注册成功不等于本机已登录；仍通过
  受验证的原生登录流程取得本机会话，不把账号 token 放进 URL、终端日志或浏览器存储。
- 注册入口绑定用户选择的 `accountOrigin`，不从错误信息或任意远程字符串跳转。
  网站需提供固定的注册路由或受控页面参数；现有网站只有登录页内的注册模式，不假设
  已存在 `/register`。`registrationAllowed:false` 时明确显示注册关闭。
- Desktop 的注册表单迁移为打开网页；旧注册 API 在兼容期保留，供旧客户端使用。
  本轮不改变已有 GitHub 登录/首次建号的服务端语义。
- TUI/`serve` 的凭据由 Host 保管，持久化必须使用安全存储；无安全存储时可提供仅当前
  进程有效的会话，不回退到明文文件。账号登录与本机 Hub owner、访问口令、手机配对和
  项目权限独立，不能用云账号直接替代这些授权。
- Desktop 保持现有登录/恢复后的中继激活流程，在激活前加入功能检查；新增 TUI/`serve`
  登录不默认开启中继或上传数据。未接入的单项功能按 Host 能力返回 `hidden`，不能因为
  客户端类型将所有账号功能一律隐藏。
- 功能 `pending` 只禁用业务操作；“登记此电脑”、连接设置与重试保留独立可操作入口，
  不要求该功能先达到 `ready`，避免用户无法完成准备步骤。

## Desktop（本仓库）

### Host 共享服务与 Desktop main 适配：`AccountFeatureService`

- 纯合成逻辑和账号生命周期位于共享的 `packages/server` account 子入口；Desktop
  适配位于 `packages/desktop/src/main/account-features.ts`，由账号管理器和中继控制器组合。
- 输入：账号状态（`onStatus`）、`/status` 的部署层、登录后 `/overview` 的账号层、
  本机条件（中继状态等）。
- 刷新时机：登录、恢复会话、token 刷新成功、账号状态变化、窗口重新获得焦点（节流
  60 秒）、本机条件变化；其余时间 10 分钟一次。
- 离线或请求失败时保留上一次的账号层结果用于显示，同时把依赖服务端的功能降为
  `pending`。退出账号立即清空账号层。
- 按 `(accountOrigin, accountId)` 区分缓存，切换账号后旧结果不能用于新账号。
- 请求绑定账号/会话 generation；退出、切换 origin/账号时失效并取消旧请求，晚到的
  响应不得重新填充旧缓存或覆盖当前视图。读取本地 snapshot 不隐式发起网络请求。
- 输出合成后的视图，不含 token：

```ts
export type AccountFeatureState = "hidden" | "sign-in" | "pending" | "ready";
export interface AccountFeatureView {
  id: AccountFeatureId;
  state: AccountFeatureState;
  reason?:
    | "device_not_registered"
    | "relay_connecting"
    | "relay_disconnected"
    | "service_unreachable"
    | "storage_error";
  params?: Record<string, string>;
}
```

- IPC：`accountFeatures:snapshot` 与推送 `accountFeatures:changed`，只对主窗口开放
  （沿用 `account-device-ipc.ts` 的窗口校验）。

### 本机条件

| id                                    | 本机条件                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `devices.dispatch`、`devices.handoff` | 中继状态 `ready`，且 `(relayOrigin, accountId)` 与当前 `(accountOrigin, accountId)` 一致 |
| `relay.phone`                         | 本机登记的 origin、accountId 均与当前账号一致                                            |
| 其它                                  | 无                                                                                       |

本机条件在相应 Host 中计算；Desktop 由 main 负责。renderer 不再自行读取中继状态
来决定入口。TUI/`serve` 通过自己的适配器提供本机条件，复用同一套合成规则。
`useAccountFeature(id)` 只表示通用入口是否可用；未来 `devices.handoff` 选中目标电脑后，
仍需在执行前校验目标在线状态、账号归属和项目/Git 条件，不能从本机 `ready` 推断目标可用。

### renderer：`useAccountFeature`

- 位置 `packages/desktop/src/renderer/account/useAccountFeature.ts`，替代 #281 的
  `runtime/useAccountDeviceEntry.ts`。
- 签名：`useAccountFeature(id): AccountFeatureView`，初始值 `hidden`，订阅变化。
- 配套 `AccountFeatureEntry` 组件，统一处理 `sign-in`（跳账号设置）与 `pending`
  （禁用并显示原因）两种状态的文案和交互，各入口不再各写一套。

### 迁移

| 入口                    | 现在                         | 迁移后                                                              |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------- |
| 侧边栏“执行电脑 / 设备” | `useAccountDeviceEntry`      | `useAccountFeature("devices.dispatch")`，以后移入设置“连接”         |
| 设置里手机二维码        | `/status` 的 `relay.enabled` | `relay.phone`                                                       |
| 远程 Link               | 执行时报错                   | `links.remote`；`hidden` 时不显示远程选项                           |
| 新建项目里的“云端”      | 登录提示 + 手填地址          | `cloud.projects`；地址来自 `params.cloudOrigin`，手填保留为高级选项 |

## 网站（packages/web）

`AccountSessionProvider` 匿名时读取 `/status.features`，登录后合成 `overview.features`，
复用版本和字段校验规则，提供同名 `useAccountFeature(id)`。网站没有本机条件，
`pending` 只来自服务不可达。网站上的
`relay.phone` 对应“用手机打开我的电脑列表”。

## 兼容

- 新客户端连旧服务（没有 `features`）：按旧字段推导 `links.remote`、`relay.phone`、
  `devices.dispatch`、`cloud.projects`，其余为 `hidden`。推导函数单独放、带测试，
  旧字段下线时一起删。
- 旧客户端连新服务：旧字段结构保留；未紧急关闭时沿用原有行为。关闭后旧客户端同样
  受服务端检查约束，入口可能仍可见，但相关操作被拒绝。
- TUI、`serve`：加入可选账号登录；匿名时，当前 Host 支持且部署提供的功能为 `sign-in`。
  Host 尚未接入的单项能力为 `hidden`，本地和原有自托管授权流程不依赖账号。

## 实施顺序

1. **services PR**：`features.mjs` 注册表、`/status` 与 `/overview` 下发、
   `ACCOUNT_FEATURE_DISABLED`、`requireFeature` 接到现有四类接口。测试：每个功能的
   部署推导、未实现功能保持关闭、紧急关闭、未登录、账号/资源隔离、旧字段保持不变。
2. **codeshell PR（共享 Host、Desktop、TUI、serve）**：共享账号客户端与
   `AccountFeatureService`、TUI/`serve` 登录/状态/退出入口、Desktop IPC、`useAccountFeature`、
   `AccountFeatureEntry`，迁移上表四个入口，删除 `useAccountDeviceEntry`。测试：合成
   规则表驱动测试、切换账号不串缓存、离线降级、旧服务推导；浏览器夹具覆盖四种入口
   状态；覆盖 TUI/`serve` 的可选登录、安全存储/进程内会话，以及本地能力不受影响。
3. **codeshell PR（Web 与注册入口）**：网站侧 hook 与入口迁移、固定网页注册入口，
   各客户端注册统一引导网页。原生客户端入口与网页路由需兼容交付后再启用跳转。
4. 之后每个新功能：服务端注册一项，客户端用一次 hook，再写功能本身。

## 待定

- 管理员灰度、指定账号名单均暂缓，后续有实际需求再定义。
- `sync.mimi`、`sync.history` 的加密方案。账号中继目前在云端解开 TLS、能看到明文，
  对聊天转发可以接受，但存储记忆和历史需要单独定方案。
- 按套餐限制功能时，账号层的数据从哪里来（本文只预留 `not_entitled`）。
