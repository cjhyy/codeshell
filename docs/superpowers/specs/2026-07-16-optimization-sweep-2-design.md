# 优化冲刺 2:配置 IA 统一 / Mimi 会话归档 / core 债务 / 插件贡献点 — 设计文档

日期:2026-07-16
状态:用户已拍板三项关键决策(统一设置中心、Mimi 自动按话题归档、插件平台渐进演进),core 债务清理无需决策。
实施顺序:**A 配置 IA → B Mimi → C core 债务 → D 贡献点**。四个工作流相互独立,各自出实施计划、各自验收。

---

## 背景(调研结论摘要)

2026-07-16 四路并行调研(面板/插件、Mimi 会话、配置入口、core 可嵌入性)确认:

- **配置入口分裂**:数字人功能散于三处(`digital-humans/` 一级页编辑、项目配置页 `ProfileSection` 激活、设置页被 `DigitalHumansView.contract.test.ts:16` 禁止出现);数据源散于三页(凭证页 LinkTab、设置→Connections、项目配置页);「扩展」有两扇门(`CustomizeView` 与设置→扩展能力组同源);设置页硬编码 user scope(`SettingsPage.tsx:202-205`);项目配置页仅右键可达;`SidebarNav.tsx` 是无调用方的死代码。
- **Mimi 会话**:pet 主会话单例永不切换(`pet-metadata-store.ts:24` ensure 后永远复用),单条无限累积仅靠通用 compaction 兜底;工作台列表靠正则匹配 title/summary 分类(`petWorkMap.ts:52-56`),未匹配会话直接隐身;Work Session 只增不减,无归档/搜索/项目过滤;dismiss 仅存 localStorage。
- **core**:公共 SDK 入口自洽、npm 已发布(`@cjhyy/code-shell-core@0.7.1`),外部 ~15 行可跑 agent;但 `engine.ts` 4127 行,`runExclusive` 单方法约 1768 行(L1255-3023);公共入口 630 行把 updater/onboarding/marketplace 全列为稳定 API;无 examples;`check-no-engine-bypass.sh` 引用不存在的 `docs/architecture/14-engine-call-paths.md`;`dist/` 残留 4 个 `__lint_boundary_*_probe__` 编译产物。
- **面板/插件**:右侧 dock 已有 `PanelRegistry`(builtin/code/plugin 三类 owner),受信内部插件通道已存在(`PluginLifecycleRuntime` + `registerDesktopPanelPlugin`,QuickChat 已示范),沙箱插件面板已闭环(webview + csplugin:// + 受限 RPC);缺口是全屏页/侧边栏为封闭 union、capability 包无 UI 贡献点、沙箱面板 API 面窄。

---

## 工作流 A:配置信息架构统一(设置中心)

### 目标形态

一个**设置中心**成为所有配置的单一信息架构;「项目配置」不再是另一套页面,而是同一套页面预选了项目 scope。

- **入口**:设置中心升为侧边栏一级入口(常驻可见);左下角 SettingsMenu 保留但指向同一页面。项目行右键「项目配置」保留,跳转到设置中心并预选该项目 scope。
- **领域分区**(左侧导航):
  1. 通用 / 外观 / 快捷键(纯全局)
  2. 模型与连接(纯全局;含现凭证页的 Cookie/Token)
  3. 数字人(双 scope:全局=库管理+编辑+市场入口;项目=激活/关闭)
  4. 数据源(双 scope:全局=目录与连接创建;项目=绑定/上传)
  5. 扩展(插件/技能/MCP/子代理/hooks;能力开关双 scope)
  6. 环境与沙箱(Git/环境/沙箱/会话/上下文/移动端)
  7. 数据(记忆/归档)
  8. 项目指令(仅项目 scope:CODESHELL/CLAUDE/AGENTS.md 打开/创建;全局兼容开关并入此节)
- **scope 模型**:设置中心顶部有 scope 切换器(「全局」+ 项目选择器)。领域声明自己支持的 scope;切到项目 scope 时只显示支持项目覆盖的领域与字段。写入路径不变:全局走 user settings,项目走 `.code-shell/settings.json`(复用现 `saveProjectSetting`)。
- **保留/收编**:
  - `digital-humans/` 一级页**保留**(市场/我的/团队是产品页不是配置页),编辑对话框 `DigitalHumanEditorDialog` 抽为共享组件,设置中心「数字人」全局 scope 复用之。
  - `CredentialsPage` 的 LinkTab 全局数据源目录与设置中心「数据源」共享同一组件;凭证页保留作为快捷入口(后续可评估降级)。
  - `CustomizeView` 侧边栏项移除,路由重定向到设置中心「扩展」。
  - `ProjectConfigPage` 改为薄壳:进入即打开设置中心并锁定项目 scope(概览节保留为项目 scope 首屏)。
- **清理**:删除死代码 `SidebarNav.tsx`;修订 `DigitalHumansView.contract.test.ts` 的「设置页禁止 ProfileSection」契约为新 IA 契约(设置中心数字人节必须存在、编辑组件必须与数字人页共享)。

### 错误处理与兼容

- scope 切换时未保存字段给离开确认;项目 scope 下项目被删除/移除时回退全局 scope。
- 所有现有设置键的读写路径不动,只动 UI 组织;契约测试随 IA 更新。

### 测试

- 契约测试:设置中心领域清单、scope 切换器行为、数字人编辑组件共享、CustomizeView 重定向。
- 现有 settings/project-config 组件测试迁移后全绿。

---

## 工作流 B:Mimi 会话自动归档与工作台结构化

### B1 pet 主会话:自动按话题归档

pet 主会话保持**单一持久 sessionId**(不破坏现有 metadata/dispatch 链),在其内部引入**话题段(topic segment)**:

- **段边界(自动,用户无感)**:
  1. **任务闭环归档**:一次委派(DelegateWork → Work Session 完成/pending 决议)闭环后,该话题相关轮次沉淀为一条结构化「工作记忆」(任务、结论、涉及 workspace/session 引用),写入 pet 专属记忆存储;活跃上下文中对应轮次被裁剪为一条简短纪要。
  2. **长空闲切段**:距上次交互超过阈值(默认 12h,可配)后的首条消息开启新段;新段开头注入上一段的携带纪要(未完成任务 + 最近结论)。
- **实现位置**:段状态与归档逻辑放 `packages/pet`(经 `/extension` 的 engineHooks/dynamicContextProviders 缝),不向 core 加 pet 字面量;上下文裁剪复用 core 通用 compaction 缝(定向 summarize 指定轮次区间的能力若缺,则在 core 加**通用**的「区间归档」原语,pet 是首个消费者)。
- **UI**:Mimi 聊天流内话题段之间显示分隔线 + 归档纪要卡片(可点开查看沉淀的工作记忆);不新增任何用户必须操作的按钮。

### B2 工作台列表:结构化分类替代正则

- 分类依据改为投影状态机的**结构化状态**(SessionIndex/PendingDecisionIndex 已有):`进行中(running/queued)` / `待决策(pending)` / `待跟进(idle 有未读结论)` / `已完成` / `其他(未分类)`——**未分类不再隐身**,进「其他」分组。
- 正则启发式(`petWorkMap.ts` 关键词匹配)整体移除;title/summary 只作展示不作分类。
- **dismiss 状态**迁到 main 侧 pet metadata store(`userData/pet/` 下),经现有 snapshot/delta 通道同步,localStorage 仅作缓存,跨端一致。
- 列表支持按 workspace 过滤;展示上限保留但「其他」提供展开。

### B3 历史 Work Session:归档与减量

- Work Session 支持**归档**标记(存 session metadata),`listDiskSessions` 默认过滤归档,可显式包含;已完成且 N 天(默认 7)无活动的 Work Session 自动归档。
- Mimi 复用候选放宽:已完成但未归档的会话进入复用候选(现状排除过窄导致只增不减)。
- `refreshCatalog` 的每次全量翻页改为增量(按 mtime 游标,只翻新于上次刷新的页)。

### 测试

- pet 包:段边界判定、闭环归档产物、携带纪要注入的单测;工作台分类纯函数单测(结构化状态→分组)。
- desktop:dismiss 同步、归档过滤集成测试。

---

## 工作流 C:core 债务清理

1. **拆 `runExclusive`**:按既有拆分风格(turn-loop/subagent-spawner/model-facade 先例)把 L1255-3023 拆为阶段模块:`run-input.ts`(图片/prompt 输入准备)、`run-workspace.ts`(workspace resume/cwd 解析)、`run-tooling.ts`(工具注册/MCP 装配)、`run-goal.ts`(goal 生命周期编排),engine.ts 保留 facade 与编排骨架(目标 runExclusive 本体 < 300 行)。守住:`check-no-engine-bypass.sh` 白名单不变、`engine-import-boundary.test.ts` 全绿、protocol 构造守卫不动、行为零变化(现有 engine 测试群全绿即验收)。
2. **公共 API 收敛(不破坏 semver)**:`index.ts` 中 updater/onboarding/marketplace/插件安装器导出加 `@deprecated`(注明 0.8 迁往 `/internal`),`/internal` 同步补齐导出;README 的稳定面章节更新。
3. **examples**:根新增 `examples/`(不入 workspaces 构建链):`01-minimal-agent.ts`、`02-approval-flow.ts`、`03-in-process-transport.ts`,每个可 `bun run` 直跑,README 链接。
4. **卫生**:`check-no-engine-bypass.sh` 死链改指向实际存在的 architecture 文档;修复 `tests/eslint-boundary-guard.test.ts` 探针写入 src 导致编译进 dist 的问题(探针改写入临时目录或测试后清理 + build 前 prune),并清掉现存 4 个 dist 残留。

---

## 工作流 D:插件贡献点渐进扩展(pet UI 本轮不迁移)

1. **全屏页面注册表**:新增 `renderer/pages/PageRegistry.ts`,对齐 `PanelRegistry` 模式(`key/owner/title/icon/order/enabled/render`,lazy);`ViewMode` 的封闭 union 收敛为「内置枚举 + 注册表 key」;侧边栏一级导航从注册表读取(内置项以 order 固定现有顺序,视觉零变化)。迁移 2-3 个低流量内置页(`logs`、`customize` 壳、`runs`)为内部注册以验证缝。
2. **沙箱面板 API 扩容**:图标从 5 个枚举放宽为受验证的 lucide 图标名白名单;权限枚举按现有需求扩展(上限仍 8);`plugin-panels.ts` 契约与文档同步。
3. **明确不做**:capability 包(/extension)的 UI 贡献字段、插件进一级导航、pet UI 插件化——等注册表在内部消费者上稳定后再评估。

---

## 全局约束

- 遵守两条 ESLint 硬边界(core 不 import tui;renderer 不运行时 import codeshell 包)。
- 每个工作流独立分支/独立提交序列,conventional commits;完成后跑 `bun test` + `bun run lint` + 受影响包构建;typecheck 按仓库惯例不作干净门禁但不得新增错误。
- pet 相关改动不向 core/engine 回加 pet 字面量(CODESHELL.md 架构债条目红线)。
