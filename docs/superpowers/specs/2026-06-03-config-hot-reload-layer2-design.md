# 配置热重载「第二层」— 设计文档

**日期:** 2026-06-03
**状态:** 设计待实现
**对应 TODO #4**

## 背景与既有事实(调研结论)

第一层已落地:**新 session 创建时**经 `agent-server-stdio.ts` 的 `freshSettings()`(L148-154)重读盘,
engineFactory 用 live 磁盘配置构造 Engine。**已运行的 session 不受影响**——这是第二层要补的。

调研(2026-06-03,见下「调研更正」)推翻了 TODO 的一个关键假设:**大部分"派生状态"其实早就是热的**,
因为:

- **PromptComposer 每 turn 重建**(`engine.ts:1215`),从 live `this.config` + 每 turn 重读盘的
  `readDisabledLists()`(`engine.ts:2235`)取值。→ 凡进 `this.config` 的提示侧字段,**改了 config 下一 turn 自动生效**,无需重建 composer。
- **disabledLists / disabledAgents / builtinOverride 已每 turn / 每次调用重读盘**(`engine.ts:2235/2168/2189`)→ 已经是热的。
- **MCPManager `connectAll()` 幂等**(`engine.ts:1240`,`if (connections.has(name)) return`)→ 改 `config.mcpServers` 后再调一次即可增量接新服务,不断已连的。
- **modelPool 共享、`switchModel`/`setPermissionMode`/`setPlanMode` 已能 mid-session 改**(`engine.ts:1816/2065`,`server.ts:478-546 handleConfigure`)。

**真正"冻"在构造期、需要主动重建的只有两类:**

1. **disk-default 配置字段**——`preset` / `customSystemPrompt` / `appendSystemPrompt` /
   `responseLanguage` / `userProfile` / `instructions`。这些写在 `this.config` 上,**新 session 才从盘读**;
   running session 的 `this.config` 不会自己更新。**但因 composer 每 turn 重建,只要把新值写进 `this.config`,下一 turn 即生效。** ← 这是第二层的主菜,且实现极轻(改 config 对象,不重建任何派生器)。
2. **settings hooks / plugin hooks**——构造期一次性注册(`engine.ts:410-430/470-477`),不每 turn 重读 → 真冻,需要一个 `reloadHooks()` 重注册。
3. **ToolRegistry 的 plugin 工具注册**——构造期 baked in,**确认无法热重载**(需重启)。但 builtin 工具的**可见性**已可每 turn 过滤(tool visibility guard,`engine.ts:1262`),所以"启用/停用某 builtin"对可见性是热的,只是注册集不变。

> `this.config` 是可变 param-property(`engine.ts:432`),既有 `switchModel` 等已用
> `this.config = { ...this.config, x }` 模式 mid-session 改它。第二层复用这个模式,不发明新机制。

## 五个开放问题 — 决议(本设计的拍板)

| # | 问题 | 决议 | 理由 |
|---|------|------|------|
| Q1 | in-flight turn 是否中断? | **不中断**(对标 Codex)。reload 只改 `this.config`;running turn 用的是它启动时已构造的 composer,**新值从下一 turn 生效**。 | 中断 in-flight 会丢用户正在进行的工作;且 composer 每 turn 重建,等下一 turn 是零成本的自然边界。 |
| Q2 | 子 agent appendSystemPrompt 传播边界? | **不向已在跑的子 agent 推**;reload 只作用于顶层 live session 的 `this.config`。子 agent 是短命的、spawn 时从父 config 取快照——**下一个 spawn 的子 agent 自然带上新值**(父 config 已更新)。 | 已在跑的子 agent 同样遵循"不中断 in-flight";新 spawn 自动继承,无需遍历子 agent 树。 |
| Q3 | MCP 热切换是否断 in-flight tool? | **只增量接新增 server,不主动断**任何已连的(connectAll 幂等)。**移除 server 的处理 defer**(运行中调用一个被移除的 MCP 工具的概率低,且断连有 in-flight 风险)——移除在下次 session 重建时生效。 | 增量接是安全的;主动断连可能打断正在用该 server 的 in-flight 工具调用。保守。 |
| Q4 | plugin 工具动态重载 vs 明确需重启? | **明确需重启**。ToolRegistry 的 plugin/builtin 工具注册集构造期固定;reload **不**改注册集。仅 builtin **可见性**(已有 per-turn guard)随 config 热生效。 | 重建 ToolRegistry 会牵动整个工具系统状态,风险/收益不划算;插件增删本就低频,重启可接受。reload 时若检测到 plugin 集变化,**日志提示"需重启生效"**(不静默)。 |
| Q5 | snapshot 是否要版本戳防乱序? | **要,轻量版**:reload payload 带一个单调 `configVersion`(由 main 进程每次 settings 写盘自增)。Engine 记录 `lastAppliedConfigVersion`,**只应用更新的版本**,丢弃迟到的旧版本。 | 多次快速保存可能乱序到达 worker;版本戳是廉价的防乱序,避免旧配置覆盖新配置。 |

## 范围

**做(第二层最小集):**
- `ChatSessionManager.forEachSession(fn)` 公有遍历(替掉 `server.ts:577` 的 `as any` 私有访问 smell)。
- `Engine.refreshRuntimeConfig(patch, version)` —— 把 disk-default 字段合并进 `this.config`、调 `reloadHooks()`、对新增 MCP server 调幂等 `connectAll()`;带 `configVersion` 防乱序。
- `Engine.reloadHooks()` —— 重新注册 settings hooks(清掉旧的 settings-source hooks,重注册;plugin hooks 同理或保守只补不删——见 plan)。
- `server.ts` 复用既有 `handleConfigure`(`configure` 协议方法)新增一个 `reloadSettings?: boolean` 分支(无 sessionId → 遍历所有 live session 应用;有 sessionId → 单个),**与既有 `reloadModels` 完全平行**——不另起新协议方法,降低接线面。
- **触发方式(复用既有 settingsBus 模式)**:renderer 写完 settings 后,经既有 `settingsBus` 派发 `window.codeshell.configure({ reloadSettings: true })`(对标 App.tsx:330 已有的 `configure({ reloadModels: true })`),由 agent-bridge 转发到 worker。**不引入 main→worker 新通道、不引入 worker 内 fs.watch**——renderer 是设置变更的源头,它最知道何时该 reload。
  - `configVersion`:由 worker 侧 `freshSettings()` 读盘后基于 settings 内容/读盘序自增即可(renderer 无需传版本;reload 是"重读当前盘"语义,版本只为多次快速 reload 防乱序——可用 worker 内单调计数器)。

**不做(明确):**
- 不中断 in-flight turn / in-flight 工具 / 在跑的子 agent(Q1/Q2/Q3)。
- 不热重载 plugin 工具**注册集**(Q4,需重启;reload 时日志提示)。
- 不主动断已连 MCP server(Q3,移除 defer 到 session 重建)。
- 不动 request-override 字段(permissionMode/goal/maxTurns/maxContextTokens/cwd)——那些是 per-request,已由 handleConfigure / run() options 处理,不属"磁盘配置热推"。

## 字段分类(reload 只推 disk-default)

| 字段 | 类别 | reload 是否推 |
|---|---|---|
| `preset` | disk-default | ✅ 推(下一 turn 经 composer 生效) |
| `customSystemPrompt` / `appendSystemPrompt` | disk-default | ✅ 推 |
| `responseLanguage` / `userProfile` / `instructions` | disk-default | ✅ 推 |
| `mcpServers` | disk-default | ✅ 推(增量接新,不断旧) |
| settings `hooks` | disk-default | ✅ 推(reloadHooks 重注册) |
| `permissionMode` / `goal` / `maxTurns` / `maxContextTokens` / `cwd` | request-override | ❌ 不推(per-request) |
| `enabledBuiltinTools` / `disabledBuiltinTools` | disk-default,但牵动 ToolRegistry | ⚠️ 可见性热(guard),注册集需重启;reload 写进 config 影响 guard,日志提示注册集变化需重启 |
| plugin 工具注册集 | 构造期固定 | ❌ 需重启(日志提示) |

## 接线链路(端到端)

```
用户改设置 → renderer 写 settings.json(settings:set IPC)
  → renderer 经 settingsBus 派发 window.codeshell.configure({ reloadSettings: true })
  → agent-bridge 转发到 worker
  → server.ts handleConfigure 的 reloadSettings 分支:
       const settings = freshSettings()         // 重读盘(engineFactory 已有的同一函数,需提到可复用处)
       const version = ++this.configVersion     // worker 内单调计数器,防乱序
       chatManager.forEachSession(s => s.engine.refreshRuntimeConfig(diskDefaultsFrom(settings), version))
  → Engine.refreshRuntimeConfig(patch, version):
       if (version <= this.lastAppliedConfigVersion) return   // 防乱序
       this.config = { ...this.config, ...patch }
       this.reloadHooks()
       if (mcpServers 有新增) void this.mcpManager?.connectAll(newServers)  // 幂等,不断旧
       this.lastAppliedConfigVersion = version
  → 下一 turn:PromptComposer 重建,自动用上新 config(零额外重建)
```

> `freshSettings()` 现在是 `agent-server-stdio.ts` 内的闭包(L148)。reload 分支在 `server.ts` 里,
> 拿不到那个闭包——实现时把"读盘 + 算 diskDefaults"做成 server 可调的形式:要么把读盘函数注入
> AgentServer(构造时传入,与 engineFactory 同源),要么 `handleConfigure` 通过一个已注入的
> `settingsReader` 回调读盘。**关键:reload 用的 settings 必须和 engineFactory 新建 session 用的是同一读盘逻辑**,
> 否则新旧 session 配置会分叉。Plan 里据此定接口。

## 测试策略(TDD)

- **core 单测:**
  - `forEachSession` 遍历所有 live session(建 2 个 session,断言回调被各调一次)。
  - `refreshRuntimeConfig`:给定 patch → `this.config` 合入新值;`buildSystemPrompt` 反映新 appendSystemPrompt;旧 version → 不应用(防乱序);MCP 新增 → 调 connectAll(用 spy)。
  - `reloadHooks`:改 settings.hooks → 重注册后旧 hook 不再触发、新 hook 触发(或保守语义按 plan)。
  - `diskDefaultsFrom(settings)` 纯函数:只挑 disk-default 字段,排除 request-override。
- **协议层:** `settings/reload`(无 sessionId)→ 遍历应用;(有 sessionId)→ 单个;非法/缺 version 的处理。
- **不回归:** request-override 路径(handleConfigure 的 permissionMode/model)行为不变。

## 非目标

- in-flight 中断、子 agent 树推送、plugin 工具注册集热重载、MCP 主动断连——见 Q1-Q4。
- fs.watch 式的 worker 内自动监听(用 main 触发 RPC,更可控)。
- 把 request-override 字段纳入热推。
