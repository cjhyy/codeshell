# Core 通用化与插件面板：技术设计与 PR 拆解

> 状态：设计稿；只描述方案，不包含代码改动。<br>
> 日期：2026-07-12。<br>
> 范围：内置工具元数据与 preset 派生、Desktop PanelRegistry 注册边界、plugin
> manifest `panels`、`csplugin://` 静态资源宿主和最小权限 bridge。<br>
> 非目标：本期不开放插件进程内 JavaScript 工具、不让插件直接 import renderer 代码、不改
> `CLAUDE_PLUGIN_ROOT → CODESHELL_PLUGIN_ROOT` 的安装期重写、不顺手拆 `engine.ts`。

## 0. 基线、证据口径与设计原则

本文以现有架构文档为基线，而不是重新发明一套架构：

- `docs/architecture/02-tool-system.md` 将工具路径定义为“preset 可见性 → executor 安全门 →
  registry/handler”；源码中的第二次执行期拦截仍位于
  `packages/core/src/tool-system/executor.ts:157-228`。
- `docs/architecture/05-presets-prompt-hooks-skills.md` 将 preset 定义为 prompt、工具可见性和默认权限的
  组合；当前 `AgentPreset` 的实际字段见 `packages/core/src/preset/index.ts:22-32`。
- `docs/architecture/07-plugins-capabilities-credentials-memory.md` 把插件运行面归纳为 hooks、MCP、skills、
  agents、commands；当前只读 inventory 也确实只有这五类，见
  `packages/core/src/plugins/pluginContent.ts:15-26`。
- `docs/architecture/10-desktop-and-mobile.md` 和
  `docs/core-deep-dive/v2-05-protocol-hosts-orchestration-deep-dive.md` 的宿主边界是“renderer 只经
  preload/IPC 调 main”；源码约束见 `packages/desktop/src/preload/index.ts:1-16`、
  `packages/desktop/src/preload/index.ts:365-386`。
- `docs/core-deep-dive/v2-01-core-as-agent-harness.md:3-5`、`:27` 与
  `docs/core-deep-dive/v2-03-tool-system-security-deep-dive.md:256-269` 已把“coding 是 preset”以及
  “工具总表 + preset 白名单双写”定为分析基线。
- 直接相关的既有路线图是 `docs/todo/core-harness-and-plugin-panels.md:29-39`、`:90-99`；本文对它做
  源码复核、接口细化和可独立合并的 PR 拆分。架构债的已完成/待办状态以
  `docs/todo/architecture-debt.md:11-18`、`:32-38`、`:55-61` 为准。

Core 边界遵守仓库已有契约：core 只放跨产品仍成立的机制，不放产品目录或 UI 实现
（`packages/core/CONTRIBUTING.md:3-21`）。因此 core 可以拥有“manifest 数据 schema/规范化读取”这一
安装机制，但 `PanelRegistry`、Electron scheme、React host 和 bridge 必须留在 desktop。

下文中“现状”均给出 `file:line` 或符号锚点；尚未由代码证明的未来行为以“设计”或“推测”标注。

## 1. 现状盘点

### 1.1 Preset/tool 清单仍是多份事实源

当前有 59 个 `BUILTIN_TOOLS` 条目（以 `BUILTIN_TOOLS` 当前运行时长度计）；它们由
`BUILTIN_IMPLEMENTATIONS` 映射而来，定义与 executor 的唯一汇总点在
`packages/core/src/tool-system/builtin/index.ts:228-236`、`:926-931`。每个条目已经携带工具执行所需的
`definition`、`execute`，而 `RegisteredTool` 已有 `permissionDefault`、读写/并发属性、path policy 和
timeout 元数据（`packages/core/src/types.ts:121-156`）。运行时 availability 却另存于
`BUILTIN_TOOL_GUARDS`（`packages/core/src/tool-system/builtin/index.ts:933-953`）。

Preset 又维护第二张名字清单：

- `GENERAL_BUILTIN_TOOLS` 占 `packages/core/src/preset/index.ts:36-138`，当前解析出 50 个名字；大段注释
  记录了 `BashOutput`、browser tools、`DriveAgent`、credentials、model catalog 和 goal tools 因漏抄而
  “已注册但不可见”的历史事故（同文件 `:44-69`、`:85-137`）。
- `TERMINAL_CODING_EXTRA_TOOLS` 在 `packages/core/src/preset/index.ts:140-147` 再加 6 个名字，
  `terminal-coding` 因而当前为 56 个工具。
- `GENERAL_PERMISSION_RULES` 又在 `packages/core/src/preset/index.ts:151-193` 维护第三份按工具名关联的
  默认权限；其中 `AgentStatus` 仍有 allow rule（`:159`），但它不在 general 工具白名单，说明权限表和
  可见性表可以独立漂移。
- browser prompt 的启用关系再存为 `BROWSER_SECTION_TOOLS` / `TOOL_GATED_SECTIONS`
  （`packages/core/src/preset/index.ts:271-280`），这是第四个工具名关联表。

`BUILTIN_AGENT_PRESETS` 只是把以上数组展开进两个对象
（`packages/core/src/preset/index.ts:197-221`）。`resolveBuiltinToolNames()` 再叠加 user enable/disable 和
desktop 的 worktree 替换（同文件 `:333-356`）；`ToolRegistry.registerBuiltins()` 最终按该名字集合过滤
`BUILTIN_TOOLS`（`packages/core/src/tool-system/registry.ts:37-59`）。因此“实现存在”并不等于“preset
可用”。回归测试也明确记录了该故障链（`packages/core/src/preset/preset-builtin-tools.test.ts:7-43`）。

安全上不能把现有 `permissionDefault` 直接拿来派生 preset allow rule：它被声明为 UI/metadata hint，
不是执行策略输入（`packages/core/src/types.ts:127-133`）；执行规则由 `PermissionController` 从 preset、
mode 和 settings 按顺序组合（`packages/core/src/engine/permission-controller.ts:50-83`）。

### 1.2 PanelRegistry 已收敛渲染映射，但还不是可注册边界

`PanelRegistry.ts` 已把 7 个内置面板的 label/icon/enabled/render 收敛进 `PANEL_ENTRIES`
（`packages/desktop/src/renderer/panels/PanelRegistry.ts:67-155`），这是正确方向；但类型与生命周期仍被
固定枚举锁死：

- `PanelTab` 是 7 个字符串的闭合 union（`packages/desktop/src/renderer/view.ts:18-25`）。
- `PanelLabel<K>` 强制 label 只能是 ``panels.kinds.${K}``，`PanelEntry<K>` 的 key 也必须是
  `PanelTab`（`packages/desktop/src/renderer/panels/PanelRegistry.ts:52-60`）。
- `PanelEntryDefinitions = { [K in PanelTab]: PanelEntry<K> }` 要求编译期穷举固定映射
  （同文件 `:62`）；导出的 registry 是 `ReadonlyMap<PanelTab, PanelEntry>`，没有 register/unregister/
  subscribe（同文件 `:157-168`）。
- `getPanelEntry()` 使用非空断言（同文件 `:162-164`）。与此同时，持久化加载只验证 `kind` 是字符串，
  不验证 registry 中是否存在（`packages/desktop/src/renderer/transcripts.ts:258-275`）；卸载插件或旧版本
  留下未知 kind 时，现有调用会在 `PanelArea` 取 entry 后崩溃。调用点见
  `packages/desktop/src/renderer/panels/PanelArea.tsx:290-295`、`:492-511`。
- `OpenTab`、`requestKind`、`addTab`、landing 回调继续使用 `PanelTab`
  （`packages/desktop/src/renderer/panels/PanelArea.tsx:27-30`、`:63-70`、`:194-198`、`:417-435`），
  `App` 的 bucket state 与 `openPanel` 也同样闭合
  （`packages/desktop/src/renderer/App.tsx:231-250`、`:3457-3462`）。
- Command Palette 的内置快捷入口直接写死具体 kind
  （`packages/desktop/src/renderer/shell/CommandPalette.tsx:107-129`）。插件不必自动进入 palette，但该处
  说明 “所有面板” 与 “内置产品快捷入口” 应在设计上分开。

好消息是持久化格式本身已经泛型化为 `K extends string`，存储仍只是 `{ id, kind }`
（`packages/desktop/src/renderer/transcripts.ts:245-249`、`:297-307`），无需数据迁移即可承载 namespaced
plugin panel id。

### 1.3 Manifest 无 panels，且两条安装路径尚未形成统一 manifest 视图

`CodexPluginManifest` 目前只声明 `name/version/description/mcpServers/skills/agents`，没有 `panels`
（`packages/core/src/plugins/installer/types.ts:3-16`）。顶层 `.passthrough()` 会让旧版本“接受但忽略”未知
字段，这有利于向后兼容，但当前没有任何 loader 消费 `panels`。

安装链还存在格式差异：

- local CC 安装递归复制整个目录，只 best-effort 读 `.claude-plugin/plugin.json` 的 version
  （`packages/core/src/plugins/installer/install.ts:43-56`、`:100-113`）。
- local Codex 安装 parse `.codex-plugin/plugin.json`，但只转换 skills/agents/commands/MCP 到目标目录
  （同文件 `:57-77`）；若新增 panel entry/assets 而不增加显式复制/规范化步骤，Codex panel 会在转换时
  丢失。
- marketplace 安装 materialize 后执行变量重写并直接写 installed entry
  （`packages/core/src/plugins/pluginInstaller.ts:322-358`），没有统一的 panel manifest 规范化步骤。
- Desktop 的摘要读取只尝试 install root 下的 `plugin.json` / `claude-plugin.json`
  （`packages/desktop/src/main/plugins-service.ts:50-68`），与上述嵌套 manifest 位置并不一致。
- installed plugin 的权威索引只有 `installPath` 等安装信息
  （`packages/core/src/plugins/types.ts:53-65`）；这是 loader 定位插件根的可靠入口，但不能把其中路径当作
  已验证内容路径。

因此本功能不能只给 Zod object 加一行 `panels`；必须同时定义“各格式 manifest → 安装目录内 canonical
panel descriptor”的规范化步骤。

### 1.4 当前 Electron 边界可复用，但普通 browser webview 规则不能直接套用

主窗口已启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并因 BrowserPanel 开启
`webviewTag`（`packages/desktop/src/main/index.ts:1522-1530`）。现有 `hardenWebviewGuests()` 会覆盖所有
guest preload、强制 browser partition，并只允许 `http(s)/about` 导航
（同文件 `:1437-1468`、`:1483-1492`）。因此 plugin panel 要么拥有显式可区分的 guest 类型，要么会被
现有 browser guest hardening 改写；绝不能仅把 `src` 换成 `csplugin://...`。

Desktop 已有正确的外部内容原则：外部站点窗口不注入 preload，并关闭 Node、开启 isolation/sandbox/
webSecurity（`packages/desktop/src/main/browser-host/index.ts:45-77`）；renderer 自身也只拿
`window.codeshell` 的显式 API（`packages/desktop/src/preload/index.ts:365-386`）。Plugin panel 必须比主
renderer 获得更窄的 API，而不是继承整个 `window.codeshell`。

### 1.5 必须保持不变：plugin env 变量重写

`rewritePluginVars()` 在安装目录中把 `CLAUDE_PLUGIN_ROOT` 全量改为 `CODESHELL_PLUGIN_ROOT`
（`packages/core/src/plugins/varRewrite.ts:1-27`、`:96-140`）。其目的就是避免同时设置两个变量导致插件
误判宿主；该设计也被 `CODESHELL.md:58` 明确标为 deliberate。本方案只让 panel entry 通过
`csplugin://` 访问资源，不改变变量名、重写时机或 hook 的 runtime env。

## 2. 目标形态

### 2.1 工具元数据成为 builtin preset 派生的单一事实源

#### 2.1.1 数据形状草案

设计：把 preset 相关元数据放在 `BuiltinTool` 条目上，而不是塞进 `RegisteredTool`。后者同时用于 MCP
工具（`ToolRegistry.registerTool()` 接受任意 `RegisteredTool`，见
`packages/core/src/tool-system/registry.ts:62-69`），MCP 不应知道 builtin preset。

```ts
interface BuiltinToolExposure {
  /** 必填；空数组表示仅能被 enabledBuiltinTools 显式开启，禁止隐式 default-on。 */
  presetTags: readonly string[]; // "general" | "terminal-coding" | future tags

  /** 显式执行策略；不能从 RegisteredTool.permissionDefault 推导。 */
  defaultPermissionRules?: readonly PermissionRule[];

  /** 有任一选中工具时才启用的 prompt section。 */
  promptSections?: readonly string[];

  /** 完整能力依赖；例如 Bash 的后台 companions。仅用于校验，不自动放宽权限。 */
  requires?: readonly string[];

  /** 取代独立 BUILTIN_TOOL_GUARDS map。 */
  availability?: BuiltinToolGuard;
}

interface BuiltinTool {
  definition: RegisteredTool;
  execute: BuiltinToolFn;
  exposure: BuiltinToolExposure;
}
```

`presetTags` 使用普通字符串而不是 import `BuiltinPresetName`，避免 builtin 层反向依赖 preset。所有条目
必须显式填写该字段；新增工具若没有做产品归属判断就无法通过类型/测试。`general` 与
`terminal-coding` 的 label、description、基础 prompt section、`injectGitStatus` 仍由 preset 声明；仅
`builtinTools`、工具相关 permission rules 和 tool-gated section 关系由元数据稳定排序派生。这样保留
`AgentPreset` 是“行为组合”的职责，而消除名字多抄。

自定义 `registerPreset()` 的 `builtinTools` 明细保持兼容
（`packages/core/src/preset/index.ts:226-269`）：第一阶段只让内置 preset 使用派生器，外部 preset 不被
强迫迁移；未来可另加 `toolTags`，不能在本期隐式改变 SDK 语义。

#### 2.1.2 派生与不变量

设计派生顺序：按 `BUILTIN_TOOLS` 注册顺序过滤 `presetTags`，再应用
`enabledBuiltinTools`、desktop host replacement、`disabledBuiltinTools`；这保持
`ToolRegistry.registerBuiltins()` 当前按表顺序注册的行为（`packages/core/src/tool-system/registry.ts:50-59`）
和 `resolveBuiltinToolNames()` 当前 override 顺序（`packages/core/src/preset/index.ts:339-356`）。禁止用
字母排序替换该顺序，以免 tool definition 顺序和 prompt cache 输入无谓变化。

必须增加以下 fail-loud 校验：

1. 迁移前后 `general`/`terminal-coding` 的名字数组逐项相等，而不只是 set 相等。
2. 每个 `requires` 都存在且在包含 owner 的每个 built-in preset 中同时可见；现有 Bash companions
   事故证据见 `packages/core/src/preset/preset-builtin-tools.test.ts:75-88`。
3. 派生 permission rule 保持声明顺序；`browser_act` 的 specific ask 必须早于通用 allow
   （`packages/core/src/preset/index.ts:179-193`）。
4. availability 同时用于模型可见性和 executor 二次门；当前两处消费者分别是
   `packages/core/src/engine/engine.ts:1582-1609` 与
   `packages/core/src/tool-system/executor.ts:182-194`。
5. registry 构造期集合仍是 frozen；本期不借元数据化承诺 preset 热切换立即增加工具。现有约束见
   `packages/core/src/engine/engine.ts:251-257`、`:2556-2605`。

#### 2.1.3 与 core 通用化的关系

工具元数据化先解决“改两处/四处”的机制债，不自动宣称 core 已完全纯化。Arena 目前仍从 builtin 直接
import arena 实现（`packages/core/src/tool-system/builtin/arena.ts:13-16`），还有 protocol RPC
（`packages/core/src/protocol/server.ts:47`、`:1857-1859`）、settings
（`packages/core/src/settings/schema.ts:404` 附近）、onboarding
（`packages/core/src/onboarding.ts:402-415`）和 public exports
（`packages/core/src/index.ts:311-390`）。所以 metadata 中 Arena 必须显式属于 coding/optional tag，不能因
“从总表派生”误入 general；在对外宣称 core 通用化完成前，还要完成“arena 可选注册”这一独立 PR。

### 2.2 PanelRegistry 成为 desktop 内的动态注册边界

#### 2.2.1 API 草案

```ts
type PanelId = string;

type PanelTitle =
  | { kind: "i18n"; key: string }       // 内置面板
  | { kind: "literal"; value: string }; // 已按 locale 解析的插件标题

type PanelIcon =
  | { kind: "component"; value: LucideIcon } // 仅 desktop 内置注册可用
  | { kind: "host-icon"; name: PluginPanelIconName };

interface PanelEntry {
  readonly id: PanelId;
  readonly owner: { kind: "builtin" } | { kind: "plugin"; installKey: string; panelId: string };
  readonly title: PanelTitle;
  readonly icon: PanelIcon;
  readonly order: number;
  readonly singleton: boolean;
  readonly enabled: (context: PanelAvailabilityContext) => boolean;
  readonly render: (context: PanelRenderContext) => ReactNode;
}

interface PanelRegistry {
  register(entry: PanelEntry): () => void; // 返回幂等 disposer
  unregisterOwner(owner: PanelEntry["owner"]): void;
  get(id: PanelId): PanelEntry | undefined;
  list(context: PanelAvailabilityContext): PanelEntry[];
  subscribe(listener: () => void): () => void;
}
```

规则：

- 内置 id 第一阶段继续使用 `files/browser/...`，保证现有 `{id, kind}` 持久化无需迁移；插件 id 一律由
  host 生成 `plugin:<installKey>:<panelId>`，manifest 不能直接指定全局 id。
- duplicate id fail-loud；同 owner 重载先整体 unregister 再原子注册新快照，避免半新半旧。
- `get()` 返回 `undefined`，`PanelArea` 渲染“面板不可用/插件已卸载”占位并允许关闭 tab，替代当前非空
  断言（`packages/desktop/src/renderer/panels/PanelRegistry.ts:162-164`）。
- `PanelArea`、`App` 和 `CommandPalette` 的通用参数改用 `PanelId`；Command Palette 的固定快捷项仍只列
  内置面板，plugin panels 由 registry landing/“+”菜单列出。这保留
  `packages/desktop/src/renderer/shell/CommandPalette.tsx:123-129` 的产品级快捷语义。
- registry 只接受 desktop 自己构造的 `render`。插件 manifest 永远不会注册一个 React component 或被
  `import()` 到主 renderer；所有插件条目都渲染同一个受控 `PluginPanelHost`。
- plugin 总开关沿用 `disabledPlugins`；它已经是插件级总开关
  （`packages/core/src/settings/schema.ts:343-349`），hooks 也按相同 bare plugin name 整体过滤
  （`packages/core/src/plugins/loadPluginHooks.ts:159-184`）。本期不新增 panel-only toggle。

### 2.3 Manifest `panels` schema 与规范化安装产物

#### 2.3.1 Author-facing schema 草案

设计为版本化 object，避免未来给数组元素加破坏性字段：

```json
{
  "name": "acme-observer",
  "version": "1.2.0",
  "panels": {
    "version": 1,
    "entries": [
      {
        "id": "dashboard",
        "title": {
          "default": "Observer",
          "en": "Observer",
          "zh-CN": "观测面板"
        },
        "entry": "panels/dashboard/index.html",
        "icon": "chart",
        "placement": "right-dock",
        "singleton": true,
        "permissions": ["context.session", "context.workspace", "storage", "external.open"]
      }
    ]
  }
}
```

对应 Zod 草案：

```ts
const PluginPanelManifestEntry = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  title: z.object({
    default: z.string().min(1).max(80),
    en: z.string().min(1).max(80).optional(),
    "zh-CN": z.string().min(1).max(80).optional(),
  }).strict(),
  entry: SafeRelativePanelPath, // POSIX relative；无 ..、反斜杠、NUL、query/hash；必须 .html
  icon: z.enum(["panel", "chart", "table", "activity", "plug"]).default("panel"),
  placement: z.literal("right-dock").default("right-dock"),
  singleton: z.boolean().default(true),
  permissions: z.array(z.enum([
    "context.session",
    "context.workspace",
    "storage",
    "external.open",
    "agent.submitPrompt",
  ])).max(8).default([]),
}).strict();

const PluginPanelsManifest = z.object({
  version: z.literal(1),
  entries: z.array(PluginPanelManifestEntry).max(16),
}).strict();
```

`permissions` 缺省为空。`title` 由 host 选 locale 后变成 literal；插件不修改 desktop i18n 文件。
`icon` 首版只允许 host-owned glyph，避免 SVG/HTML icon 成为第二个主动内容入口。

#### 2.3.2 安装规范化

设计：新增纯数据 `normalizePluginManifest(sourceRoot, format)`，由 local CC、local Codex 和 marketplace
三条安装路径共同调用，并在激活 installed entry 前写入安装目录内的 canonical
`.cs-plugin-manifest.json`。canonical 文件只保留经过 schema 校验的 name/version/description/panels 和
相对 entry，不保存任意作者字段；runtime panel loader 只读 canonical 文件，不再猜多个 manifest 位置。

Codex 转换必须复制每个 panel entry 所在的 `panels/` 静态目录；当前只复制四类已知贡献
（`packages/core/src/plugins/installer/install.ts:61-76`），所以这是 schema PR 的必要验收项。CC 和
marketplace 虽会复制/materialize 原树，也仍写同一 canonical 文件，避免 Desktop 继续依赖
`plugins-service.ts:55-67` 的 root 猜测。

显式提供 `panels` 但 schema/path 校验失败时，安装或更新整体失败；local installer 已用 temp + rename
保证失败不留下半安装目录（`packages/core/src/plugins/installer/install.ts:16-21`、`:37-42`、`:80-97`）。
Marketplace 激活也必须先规范化再改 `installed_plugins.json`；当前写索引发生在
`packages/core/src/plugins/pluginInstaller.ts:344-358`，新校验必须排在其前。

兼容策略：无 `panels` 的现有插件 canonical 中省略该字段，行为不变；旧 CodeShell 因 top-level schema
`.passthrough()` 会忽略新字段（`packages/core/src/plugins/installer/types.ts:3-14`）；新 CodeShell 不执行
任何 panel author code，只把 descriptor 交给 desktop host。

### 2.4 `csplugin://` 沙箱 host

#### 2.4.1 URL 与静态文件映射

设计 URL：`csplugin://<opaque-install-id>/<relative-entry-or-asset>`。host 是 main 根据 install key 生成的
稳定 opaque id，不直接使用绝对路径，也不信任请求携带的 plugin name。main 维护
`opaque-install-id -> { installKey, canonicalRoot, declaredPanelEntries }` 快照。

Electron 生命周期上，`csplugin` 必须在 `app.ready` 前通过
`protocol.registerSchemesAsPrivileged()` 声明为 `standard + secure` scheme；不授予 CORS bypass、service
worker 或任意外部请求特权。guest 使用独立 session partition，因此在创建该 partition 后，还要对
`session.fromPartition(partition).protocol` 安装同一个只读 handler，不能只在 `defaultSession` 注册后假设
所有 guest 都能继承。当前 main 入口在模块顶层配置 app name（`packages/desktop/src/main/index.ts:300-309`），
主窗口和 webview partition 则在 ready 后创建（同文件 `:1501-1537`）；scheme privilege 声明与 handler
装配应分别放在这两个既有生命周期阶段。

scheme handler 的拒绝顺序：

1. host 必须存在于已安装且启用的快照；panel entry 必须在 canonical manifest 中声明。
2. URL path 只允许规范 UTF-8、GET/HEAD、无 credentials/query/hash/NUL/反斜杠/`.`/`..` 段。
3. 对 plugin root 与目标文件做 realpath，要求目标严格位于 root 下；现有卸载保护已经使用“双方
   realpath + root separator + 拒绝 root 本身”的模式
   （`packages/core/src/plugins/pluginInstaller.ts:67-105`），静态 host 复用同一安全谓词思想但以“只读文件”
   为目标。
4. 只服务普通文件，拒绝 symlink escape、目录 listing、dotfiles、manifest/meta、可执行文件和未知 MIME；
   HTML/JS/CSS/JSON/PNG/WebP/font 使用显式 MIME 与 `nosniff`。
5. 每个响应附加固定 CSP：
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`。
   首版不允许 remote script、fetch/WebSocket、iframe、form submit 或 `eval`。

#### 2.4.2 Guest 隔离

设计采用独立 sandboxed `<webview>` guest，而不是把插件 HTML 当主 renderer 的 component/同源 iframe：

- `PluginPanelHost` 只创建 `src=csplugin://...`、非持久 `partition=csplugin:<opaque-id>` 的 guest。
- `will-attach-webview` 先验证 scheme/host/entry，再由 main 覆盖为专用 `plugin-panel.cjs` preload，强制
  `nodeIntegration=false`、`nodeIntegrationInSubFrames=false`、`contextIsolation=true`、`sandbox=true`、
  `webSecurity=true`，禁止 plugins/popups。
- 同源内导航只允许该 opaque host；跨 plugin、`file:`、`http(s):`、`javascript:` 等顶层导航全部阻断。
  `setWindowOpenHandler` 永远 deny；外链只能走声明了权限的 bridge。
- plugin guest 与 browser guest 必须在 `hardenWebviewGuests()` 分支上显式区分。现有代码会统一覆写
  preload/partition（`packages/desktop/src/main/index.ts:1439-1468`）并仅放行 web URL（`:1483-1492`），
  所以“先识别、再分别 harden”是安全前置，不是 UI 细节。
- 对该非持久 partition 安装 permission handler，摄像头、麦克风、通知、剪贴板、下载、USB、serial 等
  一律 deny。主 renderer 当前只对自身 origin 有条件放行 media/clipboard
  （`packages/desktop/src/main/index.ts:1609-1627`）；plugin partition 不复用该例外。

### 2.5 Scoped bridge：最小可用能力与明确禁区

专用 preload 只暴露一个冻结对象，不暴露 `ipcRenderer`、channel 名或 `window.codeshell`：

```ts
window.codeshellPanel = Object.freeze({
  getContext(): Promise<PanelContext>,
  call(method: PanelBridgeMethod, params?: unknown): Promise<unknown>,
  on(event: PanelBridgeEvent, listener: (payload: unknown) => void): () => void,
});
```

main 在 guest attach 时记录 `webContents.id -> { installKey, panelId, permissions, ownerWindowId, bucket }`。
每次 invoke 都从 `event.sender.id` 取 scope，绝不接受 payload 自报 plugin/session/cwd；detach、disable、
uninstall 或 owner window 销毁立即撤销。参数/result 使用 schema、大小上限、超时和每 guest rate limit。

首版方法矩阵：

| 能力 | 是否默认 | 面板能拿到/做什么 | 拿不到/不能做什么 |
|---|---:|---|---|
| 基础 context | 是 | `panelId`、visibility、theme、locale、host API version | 绝对安装路径、环境变量、任意 window 信息 |
| `context.session` | 否 | 当前 bucket 的 opaque session id 与 busy 状态 | transcript 全文、其他 session、approval token |
| `context.workspace` | 否 | 当前 workspace 的 `cwd` 与 trusted boolean | 任意文件内容、目录遍历、credential 路径 |
| `storage` | 否 | `get/set/delete` 自己 namespace，JSON-only、配额限制 | local filesystem、其他 plugin/panel namespace |
| `external.open` | 否 | 用户手势触发的 `https:` URL，经 main 再确认/打开 | `file:`/custom scheme、静默 popup、任意命令 |
| `agent.submitPrompt` | 否 | 向当前 session 提交用户可见 prompt；复用 host 的 run/steer 冲突检查 | 直接调用 Engine、越过 approval、伪造 tool result |

首版明确不提供：Node/DOM 主页面访问、任意 IPC、shell/PTY、任意 fs、credentials/cookies、模型 API key、
raw MCP transport、`ToolRegistry.executeTool()`、approval 自动同意、其他插件数据、网络直连。

插件已有 MCP server 会通过现有 plugin MCP loader 进入同一 ToolRegistry；MCP 工具仍受 session server
allowlist 和 executor 二次门约束（`packages/core/src/tool-system/executor.ts:195-228`）。Panel 若要使用插件
能力，首版只能通过 `agent.submitPrompt` 让 agent 在正常 turn 内调用；禁止 main 直接 spawn MCP 或调用
handler，因为那会绕过 `ToolExecutor` 的 visibility/path/permission/hooks 管线。若未来需要 direct tool API，
必须先在 core 增加“外部调用也走 ToolExecutor + approval router”的显式协议，不能在 desktop bridge 私设
旁路。

## 3. 架构债依赖与实施顺序

### 3.1 `core → tool-system → engine` 环与 `engine.ts` 拆分

`CODESHELL.md:69` 的规则是“先断环，再拆 engine”。当前 checkout 已完成关键前置：

- `EngineConfig/EngineHookConfig/EngineResult` 已在 `engine/types.ts`，`engine.ts` 只做兼容 re-export
  （`packages/core/src/engine/engine.ts:141-147`；类型文件的目的见
  `packages/core/src/engine/types.ts:1-12`）。
- 既有债务记录也把 tool runtime 窄接口、JSON helper 和 Engine types 标为 P0 已完成
  （`docs/todo/architecture-debt.md:11-18`）。
- 当前 `engine.ts` 仍有 3207 行，且直接装配 ToolRegistry/Executor/guards/preset
  （`packages/core/src/engine/engine.ts:13-17`、`:36`、`:100`），所以物理拆分仍是独立债务，而不是本
  功能应顺带完成的工作。

结论：已经完成的断环/类型抽取是 engine split 的前置；**engine split 不是工具元数据化、PanelRegistry、
manifest 或 `csplugin://` 的前置**。本功能不得重新让 builtin metadata import `Engine`/`EngineConfig`；用
普通 tag 和窄 guard 类型即可。Engine split 可在本序列之后或并行的独立 worktree 进行。

### 3.2 Arena 纠缠

Arena 移到 `packages/arena` 不是插件面板前置；Panel 轨道完全在 desktop + manifest loader。工具元数据 PR
也可先通过显式 optional/coding tag 保持当前可见集合不变。可是“core 通用化完成”的验收至少要求
Arena 从默认 builtin catalog 改为可选贡献，因为其当前仍横跨 builtin/protocol/settings/onboarding/index，
代码锚点见 2.1.3。

顺序应为：工具 exposure 元数据与派生 parity → Arena 可选注册 → 再讨论 `packages/arena` 移包。真正移包
还依赖 `arena_status`、settings ownership、public API、TUI 命令的产品语义，已有债务也把它放在
“可选注册”之后（`docs/todo/architecture-debt.md:32-38`、`:55-61`）。`extractJSON` 已移到
`utils/json.ts` 的前置也已经完成（`docs/todo/architecture-debt.md:15-17`），不要重复做。

### 3.3 两条可并行轨道与硬依赖

```text
Core 轨：PR1 元数据契约/快照 → PR2 preset 派生 → PR3 Arena 可选注册

UI 轨： PR4 PanelRegistry 注册边界 ───────────────┐
       PR5 manifest 规范化/descriptor ────────────┼→ PR6 csplugin 静态 host
                                                  └→ PR7 scoped bridge → PR8 集成收口
```

硬依赖只有：PR2 依赖 PR1；PR3 依赖 PR2；plugin UI 注册依赖 PR4+PR5；bridge 依赖经过安全测试的 scheme/
guest host。Core 轨和 UI 轨可并行，engine split 与两轨都无硬依赖。

## 4. 有序 PR 序列与体量估计

估计单位是 1 名熟悉仓库的工程师工作日，含定向测试/构建，不含 review 等待；行数为“推测”，仅用于
排期。

| PR | 一句话目标 | 主要影响文件 | 可独立合并 | 估计 | 主要风险 |
|---|---|---|---|---:|---|
| 1 | 为每个 builtin 增加必填 exposure 元数据并用测试锁定现有工具/权限/guard 快照，暂不切换生产派生路径。 | `packages/core/src/tool-system/builtin/index.ts`、新增 builtin metadata 类型/validator、`packages/core/src/preset/*test.ts` | 是，纯行为保持 | 2–3 日，约 250–400 LOC | 59 个条目机械迁移漏项；用逐项 snapshot 和 required field fail-loud 控制。 |
| 2 | 让内置 preset 的 `builtinTools`、工具权限规则和 tool-gated sections 从 exposure 元数据派生，删除重复清单。 | `packages/core/src/preset/index.ts`、`tool-system/builtin/index.ts`、`capability-control/project.ts`、preset/engine tests | 是；对外 API 不变 | 2–4 日，约 250–450 LOC | 工具顺序、browser rule specificity、desktop replacement、frozen registry 热重载语义漂移。 |
| 3 | 把 Arena 从默认 builtin catalog 改成显式可选贡献，保持 `terminal-coding`/现有宿主装配结果不变。 | `tool-system/builtin/index.ts`、`tool-system/builtin/arena.ts`、`engine/types.ts` 或 capability 装配点、`protocol/server.ts`、settings/onboarding/index、tests | 是；是“core 通用化完成”门槛 | 3–5 日，约 350–650 LOC | protocol/settings/public API 兼容；不得在本 PR 物理移包。 |
| 4 | 将 PanelRegistry 改成 string id 的动态注册服务，并为未知/卸载面板提供可关闭占位。 | `renderer/view.ts`、`panels/PanelRegistry.ts`、`PanelArea.tsx`、`App.tsx`、`shell/CommandPalette.tsx`、panel/transcript tests | 是，纯 Desktop 行为保持 | 3–4 日，约 300–500 LOC | bucket 多实例、StrictMode、tab 持久化和保活竞态；保持现有 7 个 id/顺序。 |
| 5 | 增加 versioned `panels` schema、三安装路径 canonical 规范化、panel assets 复制和只读 descriptor API。 | `plugins/installer/types.ts`、`install.ts`、`update.ts`、`pluginInstaller.ts`、`pluginContent.ts`、core exports/tests、desktop `plugins-service.ts`/preload types | 是；只产生 descriptor，不执行 UI | 3–5 日，约 450–750 LOC | CC/Codex/marketplace 三路径漂移；恶意 entry/path；更新失败必须保留旧安装。 |
| 6 | 注册 `csplugin://` 只读协议并交付无 bridge 的 sandbox PluginPanelHost，先证明静态 UI 隔离成立。 | 新增 desktop `plugin-panel-protocol.ts`、`plugin-panel-guest.ts`、renderer `PluginPanelHost.tsx`，修改 main index、PanelRegistry hydration、build scripts/tests | 是，feature flag 默认关或仅测试插件可见 | 4–6 日，约 600–900 LOC | scheme path traversal、symlink、MIME/CSP、browser/plugin guest 分类错误、renderer crash。 |
| 7 | 增加 sender-scoped preload bridge 和 context/storage/external/prompt 的最小权限矩阵。 | 新增 `preload/plugin-panel.ts`、main bridge service、IPC schema、renderer host/types/tests、build script | 是，依赖 PR6 | 5–7 日，约 700–1100 LOC | confused deputy、scope 伪造、disable 后仍可调用、消息洪泛、prompt 与在飞 turn 冲突。 |
| 8 | 完成插件启停/更新/卸载热刷新、详情权限展示、stale tab 恢复和端到端安全回归。 | `plugins-service.ts`、Extensions plugin detail、PanelRegistry hydration、App/PanelArea、preload types、E2E/fixture tests、docs | 是，发布候选 | 3–5 日，约 450–750 LOC | 多窗口 registry 同步、更新时 guest 仍持旧代码、卸载后 sender 残留、locale/theme 更新。 |

总量推测：25–39 工程日，约 3.3k–5.5k 新增/修改 LOC。PR3 可与 PR4–PR5 并行；若只计算“插件面板
v1”而不把 Arena 可选化算入发布门槛，则 PR4–PR8 约 18–27 工程日。

每个 PR 的最低验证遵守仓库现状：定向 `bun test`、`bun run typecheck` 只要求无新增相关错误（它不是
clean gate，`CODESHELL.md:40`）、`bun run lint:engine-bypass`（触及 Engine 装配时）和相应 core/desktop
build。PR6–PR8 必须另有恶意 URL、symlink escape、跨 plugin host、无权限 bridge、disable/uninstall
撤销和 renderer-process-gone 测试。

## 5. 风险、回滚点与兼容影响

### 5.1 工具/preset 风险

| 风险 | 代码依据 | 控制与回滚点 |
|---|---|---|
| 派生名单漏工具导致模型 “Tool not found” | registry 会跳过未选工具（`tool-system/registry.ts:50-53`）；历史回归见 `preset-builtin-tools.test.ts:7-12` | PR1 先锁逐项 parity，PR2 才切读路径；保留一个 release 的 legacy snapshot 可一键切回。 |
| permission 被误放宽 | `permissionDefault` 不是执行策略（`types.ts:127-133`）；settings rules 还会前置（`permission-controller.ts:75-83`） | 使用独立 `defaultPermissionRules`；PR2 比较规则数组顺序/内容；不从 UI hint 推导。 |
| guard 只在 prompt 生效，记忆中的工具仍执行 | 当前已有 engine 隐藏 + executor 拒绝两层（`engine.ts:1587-1589`；`executor.ts:182-194`） | metadata 迁移必须让两处调用同一个派生 guard map；任一层 parity 不通过不删除旧 map。 |
| preset 热切换期望被错误提升 | registry 集合构造期冻结（`engine.ts:251-257`） | 文档/API 保持“新增工具需新 session”；动态 rebuild 另立设计。 |
| Arena 意外进入 general | Arena 在总表且是产品特性（`builtin/index.ts:759-769`） | exposure 必填并显式 optional/coding；PR3 作为 core 通用化发布门槛。 |

### 5.2 Desktop/plugin 安全风险

| 风险 | 代码依据 | 控制与回滚点 |
|---|---|---|
| 任意文件读取 / symlink escape | installed manifest 路径可被篡改；已有删除保护必须 realpath containment（`pluginInstaller.ts:67-105`） | scheme 使用独立只读 containment + extension/MIME allowlist；总开关可停止注册 scheme descriptors。 |
| 插件拿到完整 desktop API | 主 renderer 的 `window.codeshell` 很宽（`preload/index.ts:365` 起） | 独立 guest preload，仅暴露 `codeshellPanel`；main 用 sender id 定 scope。PR6 先无 bridge，PR7 再逐项开。 |
| plugin guest 被 browser hardening 错配 | 当前所有 webview 都被同一 handler 覆写 preload/partition（`main/index.ts:1439-1468`） | attach 时先验证 scheme 并分支；未知 guest fail closed。可回滚为不创建 plugin guest，内置 browser 不变。 |
| CSP/网络成为数据外传通道 | 主 renderer CSP 允许 localhost connect（`main/index.ts:1571-1583`），不能复用于插件 | `csplugin` response 自带更严 CSP、独立 partition，permission handler 全拒；外链只经 bridge。 |
| bridge confused deputy | 多窗口共享 process-global services（`main/index.ts:311-318`） | 不信 payload scope；绑定 sender/ownerWindow/bucket；窗口/guest 销毁立即 revoke。 |
| 直接 MCP 调用绕过 executor | MCP generic 调用在 executor 有 session allowlist gate（`executor.ts:195-228`） | v1 不给 raw MCP/direct tool；只允许 agent 正常 turn。未来 direct API 必须先进入 core executor。 |
| 插件更新/卸载后旧 guest 继续运行 | 当前 panel state 会长期保存任意字符串 kind（`transcripts.ts:258-275`） | unregister owner 时关闭/revoke guest，tab 改占位；更新使用新 opaque version id，旧 sender 失效。 |

紧急回滚分三层，不需要回退整个版本：

1. 设置/环境级 kill switch 让 `listPluginPanels()` 返回空，只保留内置 registry；未知 tab 占位可清理。
2. 保留 manifest 安装支持但停止挂载 `PluginPanelHost`/scheme；现有 plugins 的 skills/hooks/MCP 等仍工作。
3. Core preset 若发现 parity 回归，切回 PR1 保存的 legacy exposure snapshot；不需要回滚 manifest/Desktop PR。

### 5.3 兼容影响

- **现有插件**：没有 `panels` 时不新增行为；skills、commands、agents、hooks、MCP 的路径保持现状，inventory
  只是在新版本增加第六类 panels。插件总开关继续同时控制所有贡献。
- **旧版 CodeShell 安装新版插件**：顶层 manifest unknown field 会被 passthrough 接受但不显示 panel；作者仍应
  在 README 标注最低 desktop 版本。若插件把核心能力只放在 panel 中，旧客户端不会获得该 UI（设计上的
  渐进增强）。
- **新版 CodeShell 安装旧插件**：canonical manifest 无 panels，panel loader 返回空，不影响安装。
- **Codex 插件**：新版本会额外复制声明的 panel assets；这是新增兼容能力。未声明的任意网页目录不暴露。
- **Desktop 持久化**：内置 kind/id 不变，无 migration；plugin 卸载、禁用或降级后保存的 tab 显示可关闭占位，
  不再因 `getPanelEntry(...)!` 崩溃。
- **多窗口/多 session**：PanelRegistry descriptor 可以 process-wide 同步，但 PanelContext 必须按
  owner window + bucket 绑定，不能因为 main bridge 是 process-global 就共享 session 数据；当前 main bridge
  的多窗口语义见 `packages/desktop/src/main/index.ts:311-318`。
- **TUI/mobile/SDK**：只看到新增 manifest 数据类型，不加载 React/Electron host；不会显示 panels。
- **变量重写**：继续保持安装期单向 `CLAUDE_PLUGIN_ROOT → CODESHELL_PLUGIN_ROOT`，没有 dual env 或 runtime
  行为变化（`packages/core/src/plugins/varRewrite.ts:4-13`）。

## 6. 完成定义

功能可发布必须同时满足：

1. `general`/`terminal-coding` 派生工具与权限逐项等价，现有 preset、capability override 和 plan-mode tests
   无行为漂移。
2. 新增 builtin 只需在一个 `BuiltinTool` contribution 中声明 definition/execute/exposure；validator 能拒绝
   缺 preset 归属、缺依赖和未知 prompt section。
3. 7 个内置 panel 的 id、顺序、保活、bucket 持久化完全不变；未知 panel 永不抛异常。
4. 三种 plugin 安装路径产出同一 canonical panel manifest；恶意 path/symlink/schema 在激活前失败。
5. `csplugin://` 只能读自己已声明的静态文件，默认无网络、无 Node、无 desktop API、无浏览器权限。
6. bridge 的每个方法都有 manifest permission、sender scope、schema/size/rate/timeout 和 revoke 测试；默认零
   权限。
7. 直接 tool/MCP 执行不存在 desktop 旁路；所有 agent 工具副作用继续经过现有 ToolExecutor。
8. disable/update/uninstall、多窗口、session 切换、app restart 后 stale tab 均有确定行为和回滚开关。
9. Arena 至少已可选注册后，才对外使用“core 通用化完成”；物理移到 `packages/arena` 可后置。

**一句话结论：建议的第一个可落地 PR 是“为 `BuiltinTool` 增加必填 exposure 元数据并用逐项 parity 测试锁住现有 general/terminal-coding 工具、权限与 guard 结果”，先建立单一事实源而不改变任何运行行为。**
