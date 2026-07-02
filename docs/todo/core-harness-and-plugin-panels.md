# core 通用化 + 插件面板路线图

> 来源:2026-07-02 全仓架构 review(5 路并行扫描 core/desktop/插件系统/宿主/内部耦合)。
> 目标两个:
> ① **core = 通用 agent harness**——无 coding/git 预设,拿去做其他领域项目(客服 agent、数据管线、视频流水线…)可以直接用;
> ② **插件 = {desktop UI 面板 + core 能力} 一体交付**——第三方插件带一个面板 + 自己的能力,装上就能 work。
>
> 与 `architecture-debt.md` 互补:那边是「解耦债」(P0 已合 main),本文是「目标架构」;P1-⑤⑥ 与本文 Phase B/C 重叠,排期时合并执行,别做两遍。

---

## 现状结论(review 证据,动手前可复核)

**已经对的(别动)**:
- core 依赖面干净:package.json 无 electron/CDP 依赖;BrowserBridge 接口注入(`engine.ts:812` setBrowserBridge,desktop 实现);无循环 import(P0-① 已断最后一环)。
- preset 机制本来就是 domain-agnostic 设计(`preset/index.ts:4` 原文 "keep the core engine domain-agnostic"):coding 文案是独立 section(`prompt/sections/coding.md`,35 行)只进 `terminal-coding`;`general` preset `injectGitStatus:false`;EnterWorktree/ExitWorktree/NotebookEdit/LSP/Brief/Arena 只在 `TERMINAL_CODING_EXTRA_TOOLS`;`registerPreset()` 已开放外部。
- 指令文件扫描是通用机制:主文件 CODESHELL.md,CLAUDE.md/AGENTS.md 是可配置兼容名(settings schema `instructions.fileName/compatFileNames`)。
- desktop renderer 纯瘦客户端(只 type-import core),单管道 `"agent:msg"` JSON-RPC;面板 dock 已通用(tab 管理/持久化都在 dock);mobile-remote 已示范「第三方 tap 同一条 RPC 管道」——插件面板宿主可完全复用。
- `src/git` 模块在 core 内只有两个消费者:`index.ts:595`(re-export)+ `tool-system/builtin/worktree.ts`。git 没缠进 engine/session/settings。

**差距**:
- 插件今天只有五个扩展点(skills/commands/agents/hooks/MCP servers),**无工具注册路径**(唯一途径 MCP)、**无 UI 贡献点**。
- 工具注册是静态数组 + preset 白名单**双份手维护**(「加工具改三处」已复发 4 次)。
- 内核残存 4 个 git 触点(见 B①);「general」preset 混入 coding 生态工具(见 B②)。
- coding/宿主载荷模块还住在 core 包里(见 B④⑤)。

---

## Phase A — 注册元数据合一(小,先做,均为行为保持重构)

### A① 工具元数据合一,preset 白名单派生
**现状**:`BUILTIN_TOOLS`(`tool-system/builtin/index.ts:102` 起,52–60 个)携带 def/permissionDefault/pathPolicy/timeout,但 preset 可见性在另一张手抄名单(`preset/index.ts:34–127` `GENERAL_BUILTIN_TOOLS`);Engine 用后者过滤前者(`engine/engine.ts:606` resolveBuiltinToolNames)。漏抄 = 注册了但不可见 = 运行时 "Tool not found"。BashOutput/UseCredential/EditModelCatalog/goal 工具全踩过(preset/index.ts 内注释就是事故记录)。
**修法**:`BuiltinToolEntry` 加 `presets?: string[]`(或 `defaultEnabled`);`GENERAL_BUILTIN_TOOLS` 从 `BUILTIN_TOOLS.filter(...)` 派生;preset 文件只留例外声明。
**验证**:快照测试断言「派生名单 == 现名单」(diff 为空才合);`bun test`。

### A② PanelRegistry 收敛内置面板(desktop)
**现状**:`PanelTab` 编译期 union(`renderer/view.ts:18`)+ KINDS/META(`panels/PanelArea.tsx:100–116`)+ 渲染 switch(`:458–472`)+ i18n(`i18n/ns/panels.ts:19–26`)四处手加。dock 本身(tab 管理/宽度/持久化)已通用,不用动。
**修法**:kind 改 string + `PanelDescriptor{kind, Icon, title, render}` 注册表;6 个内置面板收敛成一张表。panelState 持久化格式 `{id, kind}` 天然兼容;未知 kind 渲染占位卡(为插件面板铺路)。

---

## Phase B — core 通用化(harness 纯度)

### B① 内核 4 个 git 触点参数化

| 位置 | 现状 | 修法 |
|---|---|---|
| `prompt/instruction-scanner.ts:178` | `findGitRoot` 直接 `execSync("git rev-parse")` 定扫描上界(已有 `ignoreGitBoundary` 逃生门) | 纯 fs 向上找 marker(`.git`/可配置)或注入 boundary finder |
| `prompt/composer.ts:106–139` | gitStatus 注入已被 `preset.injectGitStatus` 门控,但实现(3 个 execSync)长在 composer | 反转为通用 `systemContextProviders` 注册点,git provider 由 coding pack 注册 |
| `engine/engine.ts:3122` | `readWorktreeSetupScripts`——EnterWorktree 专用逻辑挂在引擎门面 | 随 worktree 工具走(ToolRuntimeHost 通用扩展口) |
| `run/ArtifactTracker.ts:151` | 硬编码嗅探 Bash 输出里的 `git commit` 当 artifact | artifact detector 注册制,git detector 归 coding pack |

### B② harness-min preset + 纯度 smoke(CI 守卫)
**现状**:`GENERAL_BUILTIN_TOOLS` 名不副实,混入 coding 生态工具:**ApplyPatch / DriveAgent / DriveClaudeCode / CheckQuota**(驱动 CC/Codex、查订阅额度是编程助手产品概念);严格说 GenerateImage/GenerateVideo/browser_* 也是「codeshell 产品默认」而非 harness 默认。
**修法**:新增 `harness-min` preset(Read/Write/Edit/Bash/Glob/Grep/AskUserQuestion/Agent/TodoWrite/Skill/MCP*/Memory*/Sleep/Config 一类最小集)作为 core 真默认;现 `general` 语义归产品/宿主层定义。
**验收(做成 CI 测试,防边界再漂移)**:`harness-min` 在**非 git 目录**起 Engine 跑一轮,断言:① system prompt 零 git/coding 字样;② 工具表零 coding 工具;③ 全程零 `execSync git`。

### B③ CapabilityModule 装配点
```ts
interface CapabilityModule {
  name: string;                         // "browser" | "media" | "coding" | "arena" ...
  tools?: BuiltinToolEntry[];           // 同 A① 格式,带 presets/guard
  hooks?: EngineHookConfig[];
  rpcMethods?: RpcMethodContribution[]; // 如 arena_status
  settingsSchema?: ZodFragment;         // 命名空间化
}
// EngineConfig 增加 capabilities?: CapabilityModule[]
```
browser/media/credentials/stt 逐个改挂载;**arena 改挂载 = P1-⑥ 完成**。宿主决定装哪些:desktop 全装、cron/headless 少装、SDK 用户自选。第三方插件的进程内能力**不开放**(信任模型未设计),继续走 MCP。

### B④ coding pack 外移(CapabilityModule 第一个真实用例)
`git`(472 LOC)/ `lsp`(473)/ `review`(110)/ worktree 工具 / `cc-orchestrator`(1113,**拆两半**:CLI 适配器=能力,房间/会话发现桥→desktop)/ `external-agents`(59)/ `quota`(333)/ ApplyPatch/NotebookEdit/Brief 工具 / `coding.md` section / `terminal-coding` preset → 收成一个 **coding pack**。先做「注册与默认值反转」(kernel 默认不含,codeshell 三宿主装配时加),目录搬 `packages/coding` 可后走。`index.ts:595` 的 git utils re-export 收回。

### B⑤ 宿主载荷搬家
`updater`(441)/ `services` 里的 notifier·analytics·diagnostics / `remote`(148,疑死代码,先 grep)→ desktop。
⚠️ `services/` 是**混装层**:`memory-orchestrator` + `dream-consolidation` 是被 engine import 的内核记忆管线,**别整目录搬**。

---

## Phase C — 边界可执行化

### C① index.ts 拆分 + subpath exports(= debt P1-⑤ 的执行)
`index.ts`(稳定 SDK)/ `index.internal.ts`(in-repo TUI/desktop),package.json exports map 加 `"."` / `"./internal"`——把 `@internal` 从注释约定变成编译期事实。纪律照 debt P1-⑤(只机械分层,Arena 先统一标 `@internal`)。

### C② HostProfile / createHost 收口
7 个 Engine 构造点(desktop agent-bridge worker / tui repl / tui run / automation-host / tcp / dream-service / seed)各自手拼 26 字段 EngineConfig,只有 `personalizationFrom` 一个共享 helper 防漂移(个性化接线漂移吃过亏)。抽 `HostProfile`/`createHost()`,配合 `check-no-engine-bypass.sh` 白名单。

---

## Phase D — 插件面板 v1(几乎全 desktop 侧,仅依赖 A②,不被 B/C 阻塞)

1. **manifest**:`.claude-plugin/plugin.json` 加 `panels: [{ id, title:{zh,en}, icon, entry, permissions[] }]`(title 用 manifest 内嵌 zh/en map,插件面板不碰 desktop i18n 文件)。
2. **plugins-service `listPanels()`**:main 扫 manifest 提供面板 descriptor,kind = `plugin:<installKey>:<panelId>`,进 A② 的同一张 PanelRegistry;插件禁用→registry 移除,旧 tab 占位。
3. **`csplugin://<installKey>/` 自定义协议**:只读映射插件 cache 目录。**必须 realpath 双侧比对做 containment**(插件缓存路径穿越有前科,复用 assertSafePluginName/三段校验思路)。
4. **PluginPanelHost**:sandbox iframe(无 nodeIntegration、独立 partition、CSP 限 self)加载 entry。
5. **scoped bridge**:面板内注入 preload-lite,`codeshellPanel = { call(method, params), on(event, cb), context:{sessionId, cwd, theme, locale} }`;main 按 manifest `permissions` 白名单过滤 method,**默认零权限**;事件按 session 范围过滤;高危操作走现有 approval 通道。镜像 mobile-remote 的既有模式(tap 同一条 `"agent:msg"` JSON-RPC 管道),不发明新通道。
6. **权限展示**:PluginDetailView 加第六类 "panels",安装/详情页列权限声明。
7. **能力配套 v1**:插件自带 MCP server(已支持,keyed `plugin:server`,stdio env allowlist 已有)+ hooks(优先级 80,热卸载 `removeByNamePrefix` 已实现)+ skills;面板经 scoped bridge 调自己的 MCP 工具,权限审批与 agent 用工具同一套。

---

## Phase E — 后置(记录方向)

- 进程内一等插件工具(需要先设计插件信任模型)。
- `@codeshell/arena` 独立包(= debt P2-⑨,先定产品语义)。
- 双 LLM SDK(anthropic+openai ~700KB)按 provider 懒加载。
- `SessionOrigin` 去枚举化(`types.ts` 硬编码 "desktop"|"tui"|"automation"|"subagent" → 可扩展 string)。

---

## 落地顺序与纪律

```
A①(工具元数据合一) ┐ 并行,均小
A②(PanelRegistry)  ┘
B①B②(内核 git 触点 + harness-min + 纯度 smoke)→ 此时「core 拿去做别的项目直接用」行为层面成立
B③(CapabilityModule)→ B④(coding pack,含 P1-⑥ arena)→ B⑤(宿主载荷)
C①(index 拆分+subpath,= P1-⑤)/ C②(HostProfile)     —— 与 B 后半并行
D(插件面板 v1)     —— 仅依赖 A②,想先看到面板插件可提前直通
E                   —— 后置
```

- 改 core 必走 worktree + rebuild;subagent 不碰 git(同 architecture-debt.md 原则)。
- **搬家/删除前先 grep 全仓消费者**——本次 review 的 subagent 就误报过一处(声称 hook 热卸载缺失,实际 `hooks/registry.ts:67` 已实现);`remote`、`quota` 等每个「→ desktop」动手前都要先验接线。
- 验证:`bun run typecheck`(无新增相关错误,非 clean gate)+ `bun test` + `bun run lint:engine-bypass` + `bun run build`。
