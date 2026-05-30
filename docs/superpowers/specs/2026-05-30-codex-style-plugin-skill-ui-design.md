# Codex 风格的插件 / Skill / MCP / 市场 桌面 UI 改造

**日期**：2026-05-30
**范围**：packages/desktop（Electron 渲染层 + 主进程 IPC），少量 packages/core 导出复用
**参照**：OpenAI Codex 桌面端的「发现首页 + 管理页（分类 tab + 单列开关列表）」样式

---

## 1. 背景与目标

桌面端对扩展能力的支持目前**散落在三处**，各自割裂：

- Settings → 「插件与 Skills」：一个三栏面板（左插件列表 / 中 skill 列表 / 右 SKILL.md 详情）
- Settings → 「MCP 服务器」：独立的 `McpSection`（增删改查 + 探测）
- 侧栏 `McpView`：MCP 实时状态列表
- 聊天 `@` mention：skill + 文件混合弹层

调研结论（已核实）：

- **插件**：列表 / 启用禁用 / GitHub 安装 / 本地安装 已具备；**卸载缺失**（后端 `uninstallPlugin` 已导出，仅缺 IPC + UI）。
- **Skill**：列表 / 启用禁用 / 安装 / 卸载 / SKILL.md 查看 / `@` 调用 已较完整。
- **MCP**：桌面端**已有完整 UI**（`McpSection.tsx` 增删改查+探测、`McpView.tsx` 列表），但与插件/skill 面板割裂。
- **市场**：core 后端 **100% 完备**（`listMarketplaces` / `loadMarketplace` / `installPlugin` / `uninstallPlugin` / `addMarketplace` / `removeMarketplace` 均已从 `@core` 导出），但**前端零 IPC、零 UI**。

**目标**：把这些能力收敛成 Codex 那种两层结构——

1. **发现首页**（极简）：大标题 + 搜索 + 「已安装概览」。
2. **管理页**：顶部分类 tab `插件 / 技能 / MCP / 市场` + 单列开关列表；skill 详情点开弹出。

不引入 codeshell 没有的概念（Codex 的「应用」tab 不做）。

---

## 2. 设计决策（brainstorm 已确认）

| 决策点 | 结论 |
|---|---|
| 顶层结构 | 发现首页 + 管理页两屏，首页可切到管理页（贴近 Codex） |
| 分类 tab | `插件` / `技能` / `MCP` / `市场` 四个（不做「应用」） |
| skill 详情 | 列表保持干净单列，**点行弹出** SKILL.md（模态/抽屉），不保留常驻右栏 |
| 插件操作 | 行内开关启用/禁用 + `⋯` 菜单卸载（**新补 `plugins:uninstall` IPC**） |
| MCP tab | **完整**并入：列表 + 开关 + 实时状态 + 添加/编辑/删除（整套复用 `McpSection`） |
| 市场结构 | **两层**：市场列表 → 点进某市场看其插件 → 逐个安装；带「添加市场」入口 |
| 发现首页 | **极简（解读②）**：标题 + 搜索 + 已安装概览；**不做 Featured 卡片网格**、不做 banner。内置精选清单 `featured.json` 仅作为「市场」tab 的推荐源 |

---

## 3. 架构

### 3.1 组件树（渲染层）

```
ExtensionsPage  (新的统一容器，替代原 plugins-skills + mcp 两个 settings 模块的入口)
├── DiscoverHome            发现首页：标题 + 搜索框 + InstalledOverview
│   └── InstalledOverview   "插件 6 · 技能 18 · MCP 1" 概览，点击跳到对应管理 tab
└── ManagePage             管理页容器：顶部分类 tab + 当前 tab 内容
    ├── TabBar              插件N / 技能N / MCP N / 市场N + 搜索框
    ├── PluginsTab          单列：图标+名称+来源+开关+⋯卸载
    ├── SkillsTab           单列：图标+名称+描述+来源+开关；点行 → SkillDetailModal
    │   └── SkillDetailModal   弹出 SKILL.md（复用现有 readSkillBody + Markdown）
    ├── McpTab              复用 McpSection 既有逻辑（增删改查+探测）
    └── MarketTab           两层：MarketList → MarketDetail（插件列表+安装）
        ├── MarketList      已添加市场 + 「添加市场」按钮
        └── MarketDetail    某市场内插件列表 + 安装/已安装状态
```

**复用策略**：

- `SkillsTab` / `PluginsTab` 抽取自现有 `PluginsAndSkillsSection.tsx` 的左/中栏逻辑，去掉常驻右栏，详情改 modal。
- `McpTab` 直接挂载现有 `McpSection`（或抽其核心 hook），不重写探测逻辑。
- `SkillDetailModal` 复用现有 `readSkillBody` IPC + `Markdown.tsx`。

### 3.2 主进程 IPC

**已有、直接复用**：`skills:list/read/uninstall/installLocal/inspectGithub/installFromGithub`、`plugins:list`、`mcp:probe`、`mcp:invalidate`、`getSettings`、`updateSettings`、`capabilities:*`。

**新增 IPC**（薄包装，逻辑全在 core，已导出）：

| IPC channel | 包装的 core 函数 | 用途 |
|---|---|---|
| `plugins:uninstall` | `uninstallPlugin(plugin, marketplace)` | 插件卸载（P1 缺口） |
| `marketplace:list` | `listMarketplaces()` | 市场列表 + 插件计数 |
| `marketplace:load` | `loadMarketplace(name)` | 某市场内的可安装插件 |
| `marketplace:add` | `addMarketplace(name, source)` | 添加市场 |
| `marketplace:remove` | `removeMarketplace(name)` | 删除市场 |
| `plugins:install` | `installPlugin(plugin, marketplace)` | 从市场安装插件 |

对应 `preload/index.ts` + `preload/types.d.ts` 各加上述方法签名。

### 3.3 数据流

- **列表**：各 tab 挂载时调对应 `list` IPC → 渲染；启用/禁用走 `updateSettings`（disabled* 集合）或 capabilities，与现状一致。
- **MCP 状态**：沿用 `mcp:probe`（8s 超时 / 60s 缓存）；编辑后 `mcp:invalidate`。
- **市场**：`marketplace:list` → 选中 → `marketplace:load` → 列插件；安装走 `plugins:install`，完成后刷新插件 tab 计数。
- **跨屏同步**：沿用现有 `codeshell:settings-changed` 广播，管理页各 tab 监听刷新。

---

## 4. 各 tab 行规格

统一行：`[图标] 名称 / 描述（单行截断）  ……右侧操作`。

- **插件**：右侧 = 来源标签（marketplace 名 / "本地"）+ 开关 + `⋯`（卸载，确认弹窗；plugin 贡献的 skill 不可单独卸载，维持现有提示）。
- **技能**：右侧 = 来源标签（项目 / 个人 / 插件）+ 开关。点行打开 `SkillDetailModal`。
- **MCP**：左侧状态色点（绿=已连接 / 灰=未探测 / 红=错误）；右侧 = "transport · N 工具" + 状态文字 + 开关；顶部有「添加 MCP」按钮，行内可编辑/删除。
- **市场**：右侧 = 来源（github/git）+ `›`；点进 `MarketDetail`；列表顶部「添加市场」。

---

## 5. 发现首页规格

- 居中大标题：「让 codeshell 按你的方式工作」。
- 搜索框：输入后跳到管理页并按关键词过滤当前/全部 tab（搜索为纯前端 includes 过滤，跨 tab）。
- 「已安装概览」：`插件 N · 技能 N · MCP N` 三个计数，点击各自跳到对应 tab。
- **不做** banner、不做 Featured 卡片网格。

---

## 6. 错误处理与空态（本次一并优化的体验缺口）

- 各 tab 加载中显示 spinner / 骨架，避免假死（现状缺失）。
- 列表加载失败显示错误 + 「重试」按钮。
- 市场 / GitHub 安装失败显示错误 + 重试；安装中按钮 disabled + "安装中…"。
- 各 tab 空态给明确引导文案 + 行动按钮（如市场空态 →「添加市场」）。
- 卸载/删除前确认弹窗。

---

## 7. 分期

- **P1 — 管理页骨架**：统一容器 + 分类 tab；接入插件/技能/MCP 三 tab（MCP 挂现有 McpSection）；skill 详情改 modal；补 `plugins:uninstall` IPC + 卸载 UI；加载/空/错态优化。
- **P2 — 市场 tab**：6 个新 IPC（除 plugins:uninstall 已在 P1）→ MarketList / MarketDetail / 添加市场 / 安装流程。
- **P3 — 发现首页**：DiscoverHome（标题 + 搜索 + 已安装概览），与管理页打通切换。`featured.json` 作为市场推荐源（轻量，可后置）。

旧的两个 settings 模块入口（`mcp`、`plugins-skills`）在 P1 收敛为单一「扩展」入口；过渡期可保留旧入口直到新页验证通过。

---

## 8. 非目标（YAGNI）

- 不做 Codex 的「应用」tab、banner 轮播、Featured 网格。
- 不做插件评分/下载量/截图（marketplace.json 无此字段）。
- 不做插件间依赖解析（core 明确 out of scope）。
- 不做 MCP 批量开关、市场服务端搜索（前端 includes 足够）。
- 不改动 core 的市场/安装逻辑，仅做 IPC 薄包装。
