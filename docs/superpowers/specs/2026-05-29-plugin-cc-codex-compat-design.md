# Plugin Loader: CC + Codex Compatibility — Design Spec

> **Date:** 2026-05-29
> **Status:** Draft — fact-checked against codebase 2026-05-29 (扫描路径 / agent schema / mcp 注入点三处已校准)
> **Audience:** Engineers (and AI agents) who will implement the plugin loader changes.
> **Goal:** v1 plugin loader that installs both CC plugins and Codex plugins, surfacing their MCP servers, skills, agents, hooks, and commands as codeshell capabilities.
> **Sister docs:**
> - [Plugin marketplace design](./2026-05-19-plugin-marketplace-design.md) — earlier spec; this one supersedes its plugin-loader sections.
> - [Plugin→MCP provenance design](./2026-05-29-plugin-mcp-provenance-design.md) — **superseded by this doc** (it proposed a derived-view-only, no-connect approach; this doc's install-time conversion + connect supersedes it).

---

## 1. TL;DR

让 codeshell 的 plugin loader 同时吃 **CC plugin** 和 **Codex plugin** 两种格式。

**核心架构**:
- 运行时基线 = **CC 格式**(loader 只懂一种布局)
- Codex plugin 在**安装时**转换为 CC 等价布局,写到 `~/.code-shell/plugins/<name>/`
- 用 Codex `plugin.json` 的 `version` 字段做 cache key,`plugin update` 时对比 version 决定是否重转
- 命令面:`install` / `update` / `list` / `uninstall` 四个子命令

**v1 部件覆盖**:Codex 转换覆盖 MCP + skills + agents 三大部件；Codex hooks / commands v1 跳过(打 warning,不阻塞整装)。CC plugin 的 hooks / commands 保持按 CC 布局加载。

**v1 不做**:远程 install / marketplace / 多源 / 原子写盘 / dry-run。

---

## 2. Goals / Non-Goals

### Goals

1. 用 `codeshell plugin install <local-path>` 能装 CC plugin,部件(skills/agents/hooks/commands/MCP)接入 codeshell。
2. 同一命令能装 Codex plugin(检测 `.codex-plugin/plugin.json`),把 MCP / skills / agents 三大部件转换为 CC 布局并接入。
3. 装入产物落到 codeshell 专属目录 `~/.code-shell/plugins/`,与 CC 原生 `~/.claude/plugins/` 隔离(隔离=不写、不读 `~/.claude`;v1 不消费 CC 原生 plugin,见 §5.3)。
4. Codex plugin 的 `version` 字段驱动 `plugin update` 重转。
5. 失败模式可预测——整装失败优于半装成功,日志带源路径和原因。

### Non-Goals(v1)

1. **codeshell 专属 marketplace**——不做,用户从 CC/Codex 生态拿 plugin。
2. **远程拉取 install**——v1 仅本地路径,留 v2。
3. **Codex hooks 与 commands 转换**——前者 schema 差异大、后者 Codex 已 deprecated;v1 跳过 + warning。注意:这不等于禁用 CC plugin 自带的 hooks / commands。
4. **运行时虚拟转换 / 原子写盘 / dry-run / 部件失败隔离**——"基础能用"优先,留 v2。
5. **plugin 沙箱加固**——遵循 doc 17 的信任模型,plugin 是"安装即信任"的用户代码,不在本 spec 范围。

---

## 3. 现状速览 — CC plugin / Codex plugin / codeshell

| | **CC plugin** | **Codex plugin** | **codeshell 现状** |
|---|---|---|---|
| 入口 | 无顶层清单,**目录约定**扫描 | `.codex-plugin/plugin.json` **清单优先** | 扫 `~/.code-shell/plugins/installed_plugins.json` 清单 → 每条 `entry.installPath`(`loadPluginHooks.ts:156` 走 `readInstalledPlugins()`) |
| MCP server | `mcp-servers.json` 或散落 | `plugin.json` 引用 `./.mcp.json` | **未读 plugin 内 MCP**(`loadPluginHooks.ts` 只读各 `installPath/hooks/hooks.json`) |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md`(**同 Markdown**) | 未消费 plugin 内 skill |
| Agents | `agents/<name>.md`(Markdown frontmatter) | `agents/<name>.toml`(TOML,字段重合 ~90%) | 未消费 plugin 内 agent |
| Hooks | `hooks/hooks.json`(CC schema) | `hooks.json`(差异 schema) | ✅ 已支持 CC 风格 |
| Commands | `commands/<name>.md` | **已 deprecated**,推荐 skills 替代 | 未消费 |
| 自动更新 | 2.0.70+ 有 marketplace auto-update | `version` 字段 cache key + `marketplace startup-sync` | 无 |

**关键事实**:Skills 完全同构(零转换),MCP 配置同构(透传),agents 字段重合 90%(逐字段映射可解决);Codex hooks/commands 差异大或 deprecated,v1 不转换。CC hooks/commands 仍按 CC 布局加载。

---

## 4. 设计概览

### 4.1 三条核心路径

```
┌─────────────────────────────────────────────────────────────┐
│  codeshell plugin install <local-path>                       │
│                                                              │
│      detect format                                           │
│      │                                                       │
│      ├─ has .codex-plugin/plugin.json? ─── yes ─► Codex path │
│      │                                            (§6)      │
│      │                                              │       │
│      └─ no  ──────────► CC path (§5)               │       │
│                              │                      │       │
│                              ▼                      ▼       │
│                     ~/.code-shell/plugins/<name>/           │
│                     (统一 CC 布局,运行时不区分来源)        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Engine 启动                                                 │
│      └─► loadPlugins(已登记 plugin via installed_plugins.json)│
│             ├─ hooks/      → HookRegistry                   │
│             ├─ skills/     → Skills 注册表                  │
│             ├─ agents/     → AgentDefinitionRegistry        │
│             ├─ mcp-servers.json → settings.mcpServers       │
│             │      (合并发生在 EngineConfig 构造前,见 §6.4) │
│             └─ commands/   → Commands 注册表(CC 布局 only)   │
│          (v2 延后:额外只读扫 ~/.claude/plugins/*/)          │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 关键设计决策

1. **"以 CC 为运行时基线"**:loader 只懂一种布局,装入侧吸收所有格式差异。把复杂度从"每次加载多算一遍格式"压到"装入时一次转换"。
2. **专属目录隔离**:`~/.code-shell/plugins/` 不污染 `~/.claude/plugins/`,卸载干净、反向兼容 CC 原生 plugin。
3. **`version` 是上游约定的 cache key**:跟上 Codex 自己的 reinstall 语义,而不是自己造一套(如 hash 比对)。本地开发场景用 `--force` 绕过。
4. **整装失败优于半装成功**:v1 不做部件失败隔离,降低实现复杂度,也避免"装上了但部分没生效"的盲坑。
5. **拒绝自动合并 / 自动覆盖**:同名冲突强制让用户做决定,plugin name 是用户记忆入口,不能悄悄变化。

## 5. CC plugin 加载路径

> CC plugin 是 codeshell 的运行时基线——loader 只懂这一种布局。

### 5.1 安装

`codeshell plugin install <source>` 检测到源目录**没有** `.codex-plugin/plugin.json` → 走 CC 分支:

1. 读取 `<source>/.claude-plugin/plugin.json`(如有)或按目录约定扫描
2. 验证必需子目录至少存在一个(`hooks/` / `skills/` / `agents/` / `commands/` / `mcp-servers.json`)
3. 把整个 plugin 目录 `cp -r` 到 `~/.code-shell/plugins/<name>/`(**与 Codex 转换产物同一根目录**,运行时只扫一处)
4. 写 `.cs-meta.json`(name + version 若有 + source path + installedAt + `format: "cc"`)

### 5.2 运行时加载

> **布局校准(对照代码 2026-05-29):** codeshell 现有的 plugin 发现**不是**"扫 `~/.code-shell/plugins/*/`"这种扁平布局。`loadPluginHooks.ts:156` 走 `readInstalledPlugins()` 读 `~/.code-shell/plugins/installed_plugins.json` 清单,再对每条用 `entry.installPath`(实际落在 `~/.code-shell/plugins/cache/<market>/<plugin>/<version>/`)。
>
> 本 spec 的 `codeshell plugin install` 改写到**扁平的** `~/.code-shell/plugins/<name>/`。**这与现有 cache 布局是两套**。v1 必须二选一(plan 阶段定):
> (a) 复用现有清单机制——install 时往 `installed_plugins.json` 追一条 `entry`(`installPath` 指向扁平目录),加载侧零改动即可发现;或
> (b) 新增独立的"扁平目录直扫"加载源,与清单机制并存。
> **推荐 (a)**:install 产物登记进 `installed_plugins.json`,这样 `loadPluginHooks` 现有逻辑直接吃到,新增 loader 也复用同一发现入口。下表的"加载到"沿用此前提。

每个 plugin 目录(经 `installed_plugins.json` 登记后)按子目录加载:

| 目录 | 加载到 | 现状 |
|---|---|---|
| `<plugin>/hooks/hooks.json` | HookRegistry | ✅ 现有 `loadPluginHooks` |
| `<plugin>/skills/<name>/SKILL.md` | Skills(`scanInstalledPlugins`,scanner.ts) | ✅ 现有,plugin skill 已被消费 |
| `<plugin>/agents/<name>.md` | AgentDefinitionRegistry(`agent/agent-definition-registry.ts`) | 🆕 net-new:现无 plugin→agent 加载 |
| `<plugin>/mcp-servers.json` → settings.mcpServers | 见 §6.4(注入点在 EngineConfig 构造前) | 🆕 net-new:`mcp-servers.json` 当前零处理 |
| `<plugin>/commands/<name>.md` | Commands 注册表 | 🆕 net-new(若做;仅 CC 布局) |

**关键不变量**:从一个已登记 plugin 目录往下看,**CC 装的和 Codex 转换来的长得完全一样**——加载侧无需关心来源。

### 5.3 与 CC 原生 `~/.claude/plugins/` 的关系

> **事实校准:** codeshell **当前并不扫 `~/.claude/plugins/`**。plugin 发现一律经 `readInstalledPlugins()` → `~/.code-shell/plugins/...`(`installedPlugins.ts:15-17`、`loadPluginHooks.ts:156`)。早稿里"保留现有 `~/.claude/plugins/` 扫描"是**误述**。

因此"读 CC 原生 `~/.claude/plugins/` 目录作只读兼容"若要做,是**纯 net-new 功能**,不是"保留现有"。鉴于 v1 求"基础能用",**本 spec 把它移出 v1 范围**(见 §11 延后):

- **v1**:`codeshell plugin install <source>` 把 CC/Codex plugin 装进 codeshell 自己的目录并登记 `installed_plugins.json`,只认这一条加载源。
- **v2(延后)**:可选地额外扫 `~/.claude/plugins/` 做 CC 原生只读兼容 + 同名优先级。v1 不碰,`plugin list` 也不再宣称列 `[native]`(见 §8.3 修正)。

### 5.4 与现有 `installed_plugins.json` / cache installer 的关系

codeshell 现有 plugin installer 已有一套 marketplace/cache 模型:

- 元数据:`~/.code-shell/plugins/installed_plugins.json`
- 安装缓存:`~/.code-shell/plugins/cache/<...>`
- commands loader 当前基于 `installed_plugins.json` 的 `installPath` 发现 `commands/*.md`

本 spec 的 v1 local install 新增的是**本地路径安装模型**:

- 安装目录:`~/.code-shell/plugins/<name>/`
- 元数据:`~/.code-shell/plugins/<name>/.cs-meta.json`

二者 v1 **并存**,不互相覆盖:

1. `plugin list` 同时读取 `.cs-meta.json` local installs 与 `installed_plugins.json` marketplace/cache installs(v1 不含 `~/.claude/plugins/*/` native,见 §5.3 / §8.3)。
2. runtime loaders 必须同时支持两类 install roots:local direct children 与 `installed_plugins.json` 里的 `installPath`。
3. 新的 `codeshell plugin install <local-path>` 不写 `installed_plugins.json`,避免把 local path 语义塞进 marketplace manifest。
4. 后续若统一安装模型,另开迁移 spec;本 v1 只要求 loader 能看见两边。

## 6. Codex plugin 装入转换路径

> **运行时基线是 CC 格式**——loader 只懂 CC 布局。Codex plugin 在**安装时**被转换为 CC 等价布局,写到 codeshell 专属目录,之后和原生 CC plugin 走同一条加载路径。

### 6.1 总流程

```
codeshell plugin install <source>
  │
  ├─→ 检测格式
  │     ├─ <source>/.codex-plugin/plugin.json 存在?
  │     │     ├─ 是 → Codex 分支(本节)
  │     │     └─ 否 → CC 分支(见 §5)
  │
  ├─→ Codex 分支
  │     ├─ 1. 解析 plugin.json
  │     ├─ 2. 跑三个转换器:
  │     │     ├─ MCP    (§6.4)
  │     │     ├─ Skills (§6.5,几乎零转换)
  │     │     └─ Agents (§6.6,详见 §7.1)
  │     ├─ 3. 写 .cs-meta.json(name + format + version + source + installedAt)
  │     └─ 4. 跳过 hooks/commands + 打印 warning(§6.7)
  │
  └─→ 输出: ~/.code-shell/plugins/<name>/
         ├─ skills/<...>/SKILL.md       (cp)
         ├─ agents/<...>.md             (TOML → Markdown)
         ├─ mcp-servers.json            (从 plugin.json 抽出)
         └─ .cs-meta.json               (来源 + version,update 用)
```

### 6.2 格式检测

二分判定,无歧义:

```ts
function detectPluginFormat(sourceDir: string): "codex" | "cc" {
  return existsSync(join(sourceDir, ".codex-plugin", "plugin.json"))
    ? "codex"
    : "cc";
}
```

**双布局混杂**(一个目录里既有 `.codex-plugin/plugin.json` 又有 CC 风格 `agents/*.md`):走 Codex 分支,CC 风格的散点子目录**忽略**,并打 warning。不要只打 info,因为用户可能误以为这些 sibling 也会被安装。

### 6.3 plugin.json 解析

最简 schema(v1 只读必需字段,其余 unknown 字段保留不报错):

```ts
const CodexPluginManifest = z.object({
  name: z.string(),
  version: z.string(),                              // §6.7 用作重转 key
  description: z.string().optional(),
  mcpServers: z.union([
    z.string(),                                     // 指向 .mcp.json 的相对路径
    z.record(z.any()),                              // 内联 mcpServers map
  ]).optional(),
  skills: z.string().optional(),                    // 指向 skills/ 目录
  agents: z.string().optional(),                    // 指向 agents/ 目录
}).passthrough();                                   // 未识别字段不报错
```

`name` 决定写盘目录:`~/.code-shell/plugins/<name>/`。同名已存在 → 拒装并提示用户改名(参考 §9 冲突策略)。

### 6.4 MCP 转换

Codex plugin.json 引用一个 `.mcp.json` 文件(或内联 mcpServers 块)。codeshell 不直接消费——把它注册到 codeshell 的 MCP 配置层。

**v1 做法**:如果 `plugin.json.mcpServers` 是字符串,从源 plugin 读对应 `.mcp.json` 内容;如果是对象,把它当作内联 mcpServers map。最终都写一份到 `~/.code-shell/plugins/<name>/mcp-servers.json`。codeshell 启动时扫 `~/.code-shell/plugins/*/mcp-servers.json` 并合并到 settings.mcpServers(实现细节见后续 plan)。

**字段透传**:Codex MCP 配置使用标准 MCP schema(`command` / `args` / `env`),与 codeshell settings.mcpServers 同构,**字段层面零转换**。

**合并到 settings.mcpServers**:

> **注入点校准(对照代码 2026-05-29):** `engine.ts` 内部**没有**"加载 settings 后、构造 mcpManager 前"的钩子点。实际是 `engine.ts:1122-1130` 直接 `const mcpServers = this.config.mcpServers ?? {}` 喂给 `connectAll`——mcpServers 从 `EngineConfig` 直达,中间无注入位。
>
> 因此 plugin MCP 的合并必须发生在 **`EngineConfig` 被构造之前**,即 CLI 侧把 `settings.mcpServers` 读出来、组装进 `EngineConfig.mcpServers` 的那一步(`packages/tui/src/cli/commands/repl.ts` / `run.ts`,以及 desktop worker 的等价装配处)。新增的 `loadPluginMcp()` 在那里把各 plugin 的 `mcp-servers.json` 并进这张 map,再交给 engine。engine 内部零改动。

合并逻辑:扫已登记 plugin(local direct children + `installed_plugins.json` installPath)下的 `mcp-servers.json`,把每个 server 加到 `settings.mcpServers` 这张 map 上,**key 用 `<pluginName>:<serverName>`** 避免不同 plugin 同名 server 冲突,且 `MCPServerConfig.name` 字段也要同步设为该带前缀的 key(否则 `connectAll` 生成的 `mcp_<name>_<tool>` 工具名会与 key 不一致)。settings.json 里用户自配的 server 仍优先(同 key 不被 plugin 覆盖)。

**agent 引用一致性**:因为 server key 会被重写为 `<pluginName>:<serverName>`,Codex agent 的 `mcp_servers` 字段也必须在转换时同步重写(见 §7.1),否则 agent 会引用不存在的 MCP server。

### 6.5 Skills 转换

Codex SKILL.md 和 CC SKILL.md 的 frontmatter 结构相同(都是 `name` + `description` + Markdown body)。**v1 做法:直接 `cp -r skills/ → ~/.code-shell/plugins/<name>/skills/`**,不解析、不修改。

如果未来发现某些字段需要转换(如 Codex 独有的 `arguments` / `environment_variables`),回头补一个 SKILL.md 解析器。v1 不预判。

### 6.6 Agents 转换

Codex `agents/*.toml` → CC `agents/*.md`。逐字段映射见 §7.1 详表。

> **字段校准(对照代码 2026-05-29):** `AgentDefinition`(`agent/agent-definition.ts:4-23`)+ `parseAgentDefinition` **只认** `name` / `description` / `model` / `maxTurns` / `tools`。**没有 `thinking`,也没有 `mcp_servers`**——解析器会直接忽略它们。因此早稿里 `model_reasoning_effort → thinking`、`mcp_servers → mcp_servers` 是写给不存在的 schema 的。v1 把这两个(及一切无对应 CC 字段的)统一走 `codex_` 前缀保留:信息不丢、不报错,但 v1 不生效。待 v2 扩 `AgentDefinition` schema 后再让其中可映射的真正生效。

核心规则:
- **有真实对应 CC 字段的** → 转为该字段(v1 仅 `name` / `description` / `model`;`developer_instructions` → body)
- **无对应 CC 字段的**(含 `model_reasoning_effort`、`mcp_servers`、`sandbox_mode` 等) → 加 `codex_` 前缀保留在 frontmatter(信息不丢,v1 不生效)
- **`mcp_servers` 的值** → 即便保留为 `codex_mcp_servers`,其每个 server 名仍按 §6.4 重写为 `<pluginName>:<serverName>`,为 v2 真支持时备好一致的引用
- **`developer_instructions`** → Markdown body
- **必需字段缺失**(`name` / `description`)→ 转换失败,整装失败,错误指明具体 agent 文件

### 6.7 `version` 字段与 `codeshell plugin update`

Codex `plugin.json` 的 `version` 是它自己的 cache key——bump version 表示 plugin 有实质变化。codeshell 跟上这个语义:

**安装时**写 `.cs-meta.json`:
```json
{
  "name": "<plugin-name>",
  "format": "codex",
  "version": "1.2.3",
  "source": "/abs/path/to/source",
  "installedAt": "2026-05-29T10:00:00Z"
}
```

**`codeshell plugin update <name>` 时**:
1. 从 `.cs-meta.json` 读 `source` 和已装 `version`
2. 重读源目录的 `plugin.json`,取新 `version`
3. 相同 → 输出 "already up to date",退出
4. 不同 → 转换到临时目录 `~/.code-shell/plugins/.tmp-<name>-<id>/` → 成功后替换旧目录 → 更新 `.cs-meta.json`

**本地开发 escape hatch**:`codeshell plugin update <name> --force` 忽略 version/mtime 判断,无条件重转。用于本地开发 plugin 时忘记 bump version、或需要验证转换器变更的场景。

**替换策略**:即使 v1 不做完整原子写盘,update 也不能先删旧目录再转换。必须先写临时目录,转换成功后再删除旧目录并 rename 临时目录;转换失败则删除临时目录并保留旧版本可用。

**v1 不做**:从 Git URL 拉源(Codex `codex marketplace add github:...` 那种)。`<source>` 必须是本地路径。远程拉取留 v2。

### 6.8 不做(v1)

- **hooks 转换**:Codex `hooks.json` 与 CC `hooks/hooks.json` 事件名 / 字段差异较大;v1 跳过,装 plugin 时遇到 hooks 字段 → log warning "Codex hooks not supported in v1, skipping",继续装其他部件。
- **commands 转换**:Codex 已 deprecated 自定义 commands;v1 跳过,遇到 commands 字段 → log warning "Codex deprecated custom commands; consider migrating to skills",继续装。
- **原子写盘** / **部件失败隔离** / **dry-run** / **全局 manifest** / **远程 install**:全留 v2。v1 一个部件转换失败 → 整装失败,让用户重装。

## 7. 转换字段映射(三张表)

### 7.1 agents: Codex TOML → CC Markdown

Codex agent 是一个 TOML 文件,CC agent 是一个带 YAML frontmatter 的 Markdown 文件。映射规则:

| Codex TOML 字段 | 必需 | CC Markdown 位置 | 转换规则 |
|---|---|---|---|
| `name` | ✅ | frontmatter `name` | 直接拷贝;缺失则转换失败 + warning |
| `description` | ✅ | frontmatter `description` | 直接拷贝;缺失则转换失败 + warning |
| `developer_instructions` | ✅ | **Markdown body** | 拷到 frontmatter 后的正文;缺失则用空字符串 |
| `model` | ❌ | frontmatter `model` | 直接拷贝(都是模型 key,如 `flash`);**`model` 是 v1 唯一真生效的可选映射** |
| `model_reasoning_effort` | ❌ | frontmatter `codex_model_reasoning_effort` | `AgentDefinition` **无 `thinking` 字段**,原值加前缀保留(v1 不生效;v2 扩 schema 后再映射) |
| `sandbox_mode` | ❌ | frontmatter `codex_sandbox_mode` | **不可译**,加前缀保留(codeshell 沙箱模型不同,见 doc 17) |
| `mcp_servers` | ❌ | frontmatter `codex_mcp_servers` | `AgentDefinition` **无 `mcp_servers` 字段**,加前缀保留;值里每个 server 名仍按 §6.4 重写为 `<pluginName>:<serverName>`(为 v2 备好一致引用) |
| `nickname_candidates` | ❌ | frontmatter `codex_nickname_candidates` | 加前缀保留;codeshell 现无对应 UI |
| 其他 unknown 字段 | ❌ | frontmatter `codex_<name>` | 全部加前缀保留(信息不丢) |

**示例转换**

Codex 输入(`agents/researcher.toml`):
```toml
name = "researcher"
description = "Read-only codebase research"
developer_instructions = """
You investigate the question using read-only tools and report findings.
Never edit files.
"""
model = "flash"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
```

CC 输出(`agents/researcher.md`):
```markdown
---
name: researcher
description: Read-only codebase research
model: flash
codex_model_reasoning_effort: high
codex_sandbox_mode: read-only
---
You investigate the question using read-only tools and report findings.
Never edit files.
```

> 注:`model_reasoning_effort` 落成 `codex_model_reasoning_effort`(原值保留,v1 不生效)。`AgentDefinition` 解析时会忽略所有 `codex_*` 字段,但它们仍留在文件里供 v2 / 人工查阅。

**多个 agent 文件**:Codex `agents/` 目录下每个 `.toml` 都独立转换,目录结构保留(`agents/sub/x.toml` → `agents/sub/x.md`)。

### 7.2 hooks: Codex hooks.json → CC hooks.json

**v1 不做**(跳过 + warning,见 §6.8)。下表为 v2 参考,不在 v1 范围内:

| Codex 事件名 | CC 事件名 | 备注 |
|---|---|---|
| `SessionStart` | `on_session_start` | (CC 在 codeshell 里映射为 `on_session_start`,见 plugins/loadPluginHooks.ts) |
| `SessionEnd` | `on_session_end` | |
| `PreToolUse` | `pre_tool_use` | matcher 字段语义相同 |
| `PostToolUse` | `post_tool_use` | |
| `UserPromptSubmit` | `user_prompt_submit` | |
| `Notification` | `notification` | |
| (其他)| 未支持 | log warning,跳过 |

字段差异较大(envelope schema 不同),v1 索性不接,避免装上后 hook 默默不工作的更差体验。

### 7.3 commands

Codex 已 deprecated 自定义 commands(官方推荐用 skill 替代)。

**v1 行为**:遇到 Codex plugin 含 commands 字段 → log warning "Codex deprecated custom commands; the author should migrate to skills" → 跳过该部件,继续装其他。

**为什么不做转换**:即便底层格式都是 Markdown,Codex commands 已被官方判死刑,转过来意义不大;让用户去找 plugin 作者更新更合理。

## 8. 安装 / 更新 / 卸载命令面

v1 提供 4 个 CLI 子命令。设计上贴近 npm 风格,降低开发者认知成本。

### 8.1 `codeshell plugin install <source>`

- `<source>` v1 **仅本地路径**(绝对或相对)。远程拉取(GitHub URL / marketplace)留 v2。
- 流程见 §6.1(Codex)或 §5.1(CC)。
- 同名已装 → 拒装,提示 "plugin '<name>' already installed; use `plugin uninstall` first or rename the source plugin"。

### 8.2 `codeshell plugin update [<name>]`

- 不带参数 → 遍历所有已装 plugin,逐个尝试 update
- 带 `<name>` → 只 update 该 plugin
- `--force` → 忽略 version/mtime 判断,无条件重装/重转
- 流程:
  - 读 `~/.code-shell/plugins/<name>/.cs-meta.json` 的 `source`
  - 重新解析源目录的 `version`(Codex)/ 或递归最大 mtime(CC,因为 CC 没有 version 字段)
  - 不变 → 输出 "already up to date"
  - 变了或传入 `--force` → 写临时目录,转换成功后替换旧目录
- 源路径已失效(用户移走了源目录)→ warning,跳过该 plugin

**CC mtime 定义**:对 CC plugin,mtime 指源目录下所有普通文件的递归最大 mtime。若实现复杂度过高,v1 可退化为“CC update 需要 `--force` 才重装”,但不能使用源目录自身 mtime 冒充完整变更检测。

### 8.3 `codeshell plugin list`

- 扫 `~/.code-shell/plugins/*/.cs-meta.json`,列出 local installs 的 name / version / format(cc|codex)/ source / installedAt
- 同时读取 `installed_plugins.json` 下 marketplace/cache installs,标记 `[marketplace]`
- **v1 不列 `~/.claude/plugins/*/` native installs**——codeshell 当前不扫 CC 原生目录(见 §5.3);该只读兼容路径留 v2,届时 `list` 再加 `[native]` 标记

### 8.4 `codeshell plugin uninstall <name>`

- 删 `~/.code-shell/plugins/<name>/`(`rm -rf`)
- 不存在 → warning "no plugin named '<name>'"
- **不动** `~/.claude/plugins/`——只读兼容路径不通过 codeshell 卸载
- 安全边界:name 必须是单段合法目录名(禁止 `/`、`..`、空字符串);删除前对目标做 realpath/containment check,确保它是 `~/.code-shell/plugins/` 下的直接子目录;拒绝跟随恶意 symlink 删除外部路径。

### 8.5 不做(v1)

- 远程 install(`github:org/repo` 风格)
- marketplace / 多源
- 启用/禁用 toggle(用户想禁用就 uninstall + 重装,或编辑 settings.disabledPlugins——后者已存在,见现有 plugin gating)
- 交互式选装部件

## 9. 冲突处理与边界

### 9.1 同名 plugin

`install` 时 `~/.code-shell/plugins/<name>/` 已存在 → **拒装并提示用户**(让源 plugin 改 name,或先 uninstall 现有的)。**不自动覆盖、不自动合并。**

理由:plugin name 是用户记忆的入口,自动覆盖会让"昨天还能用的 plugin 今天没了"。强制用户做决定。

### 9.2 双布局混杂

一个源目录里**同时有** `.codex-plugin/plugin.json` **和** CC 风格的 `agents/*.md` / `commands/*.md`:

- 走 Codex 分支(检测优先级见 §6.2)
- CC 风格散点子目录里的内容**忽略**,不合并
- log warning "<source> looks like a Codex plugin; ignoring CC-style siblings"

理由:plugin.json 是 Codex 作者的显式声明,作者认为应该走 Codex 路径;CC 风格的散点目录可能只是开发期残留。

### 9.3 未识别部件

Codex plugin.json 引用了 v1 不支持的部件类型(如未来 Codex 加的 `connectors` / `prompts` 等)→ log warning + 跳过,**不阻塞整装**。

### 9.4 `~/.code-shell/plugins/` 与 `~/.claude/plugins/` 同名(v2)

**v1 不涉及**——v1 不扫 `~/.claude/plugins/`(见 §5.3)。待 v2 加入 CC 原生只读兼容扫描后,再定义同名优先级:届时运行时 `~/.code-shell/plugins/` 优先(codeshell 显式装的),`~/.claude/plugins/` 为只读兜底。

### 9.5 plugin 内自身字段冲突

如 Codex agent TOML 里既有 `model` 又有 `codex_model`:不可能(`codex_` 前缀是 codeshell 转换器加的,不是 Codex 字段)。但保险起见,转换器遇到源里就有 `codex_xxx` 字段 → 用 `codex_codex_xxx` 兜底(双前缀,极端罕见)。

## 10. 错误处理与故障模式

v1 的原则:**整装失败优于半装成功**——一个部件转换失败就整装失败,让用户重装。这避免"装上了但没生效"的更糟体验。

| 失败模式 | 行为 |
|---|---|
| 源路径不存在 / 不是目录 | 立即报错退出,不写盘 |
| Codex `plugin.json` 解析失败(JSON 语法 / 必需字段缺失) | 报错退出,不写盘 |
| Codex agent TOML 解析失败(单个文件) | **整装失败** — 不接受"丢弃个别 agent",因为用户可能正依赖它 |
| Codex agent 缺 `name` / `description` | 同上,整装失败 + 报错指明哪个文件 |
| MCP server 配置无效(JSON 解析失败) | 整装失败 |
| Skill 文件缺 frontmatter | 整装失败(虽然 skills 文件体零转换,安装阶段仍做最小 frontmatter 校验:name/description) |
| `~/.code-shell/plugins/<name>/` 已存在 | 见 §9.1,拒装 |
| 写盘中途失败(磁盘满 / 权限) | install 可能留半装目录;update 必须保留旧版本。`uninstall` 对半装目录也能工作,但需遵守 §8.4 containment check |
| Codex 含 hooks / commands 部件 | log warning(见 §6.8),**不算失败**,继续装其他部件 |
| update 时源目录已不存在 | warning,跳过该 plugin |

**日志**:所有 warning / error 走 codeshell 现有 logger(`packages/core/src/logging/`),不直接 console.log。失败时给用户看的错误信息要包含**源路径**和**失败原因**,不要只说 "install failed"。

## 11. 落地步骤(指向后续 TDD plan)

按依赖顺序分 6 个里程碑,每个独立可测、独立可 commit。具体 TDD 步骤(写测试、跑、实现、commit)留给后续 plan 文档。

### M1 — 公共骨架
- 新建 `packages/core/src/plugins/installer/` 目录
- `installer/types.ts`:`CodexPluginManifest` zod schema(§6.3)、`CSMeta` schema(§6.7)、错误类型
- `installer/detectFormat.ts`:§6.2 的二分判定函数
- `installer/paths.ts`:`~/.code-shell/plugins/<name>/` 的解析、`.cs-meta.json` 路径

### M2 — CC 安装路径
- `installer/installCC.ts`:§5.1 的 cp + 写 `.cs-meta.json`
- 验证子目录至少存在一个的逻辑(§5.1 step 2)
- 测试:fixture plugin 装入 → 检查目录结构 + meta 文件

### M3 — Codex 转换器(逐部件)
- `installer/codex/parseManifest.ts`:解析 plugin.json(§6.3)
- `installer/codex/convertMcp.ts`:§6.4(几乎零转换,但要从 plugin.json 引用解析 .mcp.json 路径)
- `installer/codex/convertSkills.ts`:§6.5(cp -r)
- `installer/codex/convertAgents.ts`:§6.6 + §7.1 完整字段映射
- 测试:每个转换器单元测试 + 真实 Codex plugin fixture 端到端

### M4 — install / update / uninstall / list
- `cli/plugin.ts`:新增 `plugin` 子命令树
- `installer/install.ts`:dispatch CC / Codex 分支
- `installer/update.ts`:§6.7 的 version 对比 + 重转
- `installer/uninstall.ts` / `installer/list.ts`:§8.3、§8.4

### M5 — Loader 接入已登记 plugin
- install 把产物登记进 `installed_plugins.json`(§5.2 推荐方案 a),使现有 `loadPluginHooks` / `scanInstalledPlugins` 零改动即可发现 hooks/skills
- 新增 `loadPluginAgents.ts`:遍历已登记 plugin 的 `agents/<name>.md` → `AgentDefinitionRegistry`(net-new;现无 plugin→agent 加载)
- 新增 `loadPluginMcp.ts`:扫已登记 plugin 的 `mcp-servers.json`,产出待并进 `settings.mcpServers` 的 map。**注入点在 `EngineConfig` 构造前**(CLI `repl.ts`/`run.ts`、desktop worker 装配处),不在 engine 内部(§6.4 注入点校准)
- `pluginCommandsLoader.ts`:维持现有 `installed_plugins.json` installPath 的 CC `commands/*.md` 加载;不加载 Codex commands(v1 不转换)
- **v1 不扫 `~/.claude/plugins/*/`**(§5.3 / §9.4 延后 v2)

### M6 — 失败模式 + 日志 + 文档
- 把 §10 的失败矩阵逐条实现
- 装至少一个真实 Codex MCP plugin fixture 或本地 mirror 端到端跑通
- 更新 `docs/architecture/04-tool-system.md` 和 `docs/architecture/08-extension-points.md` 反映新的 plugin 加载源

### 显式延后到 v2
- 远程 install(github:org/repo)
- marketplace.json 概念
- 原子写盘 / dry-run / 部件失败隔离
- hooks / commands 转换
