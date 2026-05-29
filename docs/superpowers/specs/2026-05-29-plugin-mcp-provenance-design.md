# 插件提供 MCP:manifest 声明 + 虚拟源投影(归属可追溯)

> 日期：2026-05-29
> 目标仓:`~/Documents/个人学习/代码学习/codeshell`
> 关联:[capability-control 设计](./2026-05-29-capability-control-design.md)、[plugin marketplace 设计](./2026-05-19-plugin-marketplace-design.md)(MVP 把 plugin MCP 列为 deferred)
> 触发:统一「扩展能力」面板要照 Codex 那样展示「插件 → 包含的 MCP + Skill」。当前 plugin 只能贡献 skill,**MCP 无法归属到插件**,本设计补这条链路的**控制层**(声明 + 发现 + 投影),不碰运行时连接。

## 0. 一句话

让插件在 `.claude-plugin/plugin.json` 里**声明** mcpServers;新增 `scanPluginMcpServers()` 照 skills/commands/hooks 的发现模式,从已装插件目录读出这些声明,产出一串**带 `pluginName` 的虚拟 MCP 源**(派生视图,**不写进用户 `settings.mcpServers`**);capability-control 投影据此把 plugin-MCP 归到其插件名下,开关跟着 plugin 走。

## 1. 背景:为什么现在算不出「插件含哪些 MCP」

(均经代码核实,2026-05-29)

| 事实 | 落点 | 含义 |
|---|---|---|
| plugin 只消费 `skills/` | `plugin-marketplace` MVP spec:46-48 | MCP/hooks/commands 中,hooks/commands 后来补了发现,**MCP 仍缺** |
| plugin skill 名带归属 | `scanner.ts:168` `${pluginName}:${dirent.name}` | skill→plugin **可算**(`:` 前缀) |
| `MCPServerConfig` 无来源字段 | `types.ts:386-402`(只有 name/command/url/transport/enabled…) | 一旦进 `settings.mcpServers`,**来源丢失** |
| `RegisteredTool` 无 plugin 字段 | `types.ts:51-68`(`source: "builtin"|"mcp"`,`serverName?`) | 连工具也追不回插件 |
| plugin 发现统一模式 | `installPath` 直给绝对路径,scanner 走 `readInstalledPlugins()` → `entry.installPath` + 子目录 | 新 scanner 可照搬 |

**结论**:要让「插件含 MCP」真实可投影,必须先有两样东西——**(a) 插件能声明 MCP;(b) 声明的归属信息被保留**。本设计两样都给,且刻意走「派生视图」而非「写进用户配置」,与现有 plugin skill 模型一致。

## 2. 核心决策(已定)

1. **声明位置**:插件 manifest `.claude-plugin/plugin.json` 的 `mcpServers` 字段(对齐 Claude Code 约定;不另造 `mcp.json`)。manifest 本是 marketplace MVP 里「lazily, 只 skills 重要」而 deferred 的文件,本设计**首次真正读它**(只读 `mcpServers` 一个字段,其余仍忽略)。
2. **进入方式**:`scanPluginMcpServers()` 产出 `{ pluginName, server }[]` 的**派生列表**,**不写入** `settings.mcpServers`。理由:写进用户配置会污染版本控制 / 用户手配的 MCP,且插件卸载后残留——与 plugin skill「扫描即得、不落用户配置」一致。
3. **归属保留**:归属不靠给 `MCPServerConfig` 加字段(那会渗进执行层类型),而是**留在 scanner 的产出结构** `{ pluginName, server }` 里,投影层直接消费。`MCPServerConfig` 形状不变。
4. **本期不连接**:本设计**只做声明 + 发现 + 投影展示 + 跟随 plugin 的开关**,**不**把虚拟源 connect 进 `MCPManager`。运行时连接是执行层,属下一期(见 §8)。与 capability-control「只收控制层」原则一致。

## 3. 数据流

```
.claude-plugin/plugin.json (插件内)         readInstalledPlugins() (已装清单)
        │  { mcpServers: { foo: {...} } }            │  key=<plugin>@<market>, entry.installPath
        └──────────────┬─────────────────────────────┘
                       ▼
        scanPluginMcpServers(): { pluginName, server: MCPServerConfig }[]   ← 新增, 纯发现
                       │
                       ▼
        capability-control 投影 (projectPlugins 增强 / 新 projectPluginMcp)
                       │   plugin descriptor.origin.children += { kind:"mcp", name, ... }
                       ▼
        统一面板:插件行展开 → 显示「含 MCP foo / 含 Skill bar」(灰态), 开关只在插件行
```

## 4. 新增/改动

### 4.1 manifest 读取(新)
`packages/core/src/plugins/pluginManifest.ts`(新文件):

```typescript
export interface PluginManifest {
  /** 插件声明的 MCP 源。键 = 源名(投影时会前缀 pluginName 防撞)。 */
  mcpServers?: Record<string, Omit<MCPServerConfig, "name">>;
  // 其余 manifest 字段本期忽略(name/version/commands… 已由别的路径处理)
}

/** 读 <installPath>/.claude-plugin/plugin.json;缺失/损坏→null。 */
export function readPluginManifest(installPath: string): PluginManifest | null;
```

落点对齐 `loadPluginHooks.readHooksJson`(`loadPluginHooks.ts:83-99`)的写法:`existsSync` 守卫、`JSON.parse` try/catch、非对象→null。

### 4.2 MCP 发现(新)
`packages/core/src/plugins/pluginMcpLoader.ts`(新文件),照 `pluginCommandsLoader.scanPluginCommands` 的结构:

```typescript
export interface PluginMcpServer {
  pluginName: string;       // <plugin>@<market> 的 @ 前缀
  serverName: string;       // 投影/展示用裸名
  server: MCPServerConfig;  // name 已填为 `${pluginName}:${serverName}` 防撞
}

/** 遍历 readInstalledPlugins() → 每插件读 manifest.mcpServers → 扁平产出。memoize。 */
export function scanPluginMcpServers(): PluginMcpServer[];
```

要点:
- plugin 名 = `key.lastIndexOf("@")` 前缀(与 scanner/commands 一致)。
- 源 `name` 命名空间化为 `${pluginName}:${serverName}`,与 plugin skill 的 `:` 约定同形,避免与用户 `settings.mcpServers` 里同名源相撞。
- 缺 manifest 或无 `mcpServers` 字段 → 跳过(graceful)。
- memoize + 暴露 `invalidatePluginMcpCache()`(对齐 `invalidateSkillCache`)。

### 4.3 capability-control 投影增强
现有 `projectPlugins`(`capability-control/project.ts`)产出的 plugin descriptor 增加 `origin.children`,把该插件包含的 skill + mcp 子项**摊出来展示**(灰态,不带独立开关):

```typescript
// types.ts: CapabilityDescriptor.origin 增加
children?: Array<{
  kind: "skill" | "mcp";
  name: string;            // skill: 裸技能名;mcp: 裸源名
  description?: string;
}>;
```

`projectPlugins` 新签名补两个入参(纯函数,仍无 I/O):

```typescript
export function projectPlugins(input: {
  installed: Record<string, unknown>;
  disabledPlugins: string[];
  pluginSkills: SkillDefinition[];     // scanSkills 里 source==="plugin" 的全量
  pluginMcpServers: PluginMcpServer[]; // scanPluginMcpServers() 产出
}): CapabilityDescriptor[];
```

归属计算(纯函数,无新数据源):
- skill 子项:`pluginSkills` 里 `name` 的 `:` 前缀 === 该 plugin 名 → 取 `:` 后裸名为 child。
- mcp 子项:`pluginMcpServers` 里 `pluginName` === 该 plugin 名 → `serverName` 为 child。

**开关粒度不变**:plugin descriptor 仍是 `denylist over disabledPlugins`(关插件 = 加插件名)。children 只展示,无各自 control。这正是你要的「选择跟着 plugin 走」。

### 4.4 service 装配
`CapabilityService.list()`(`capability-control/service.ts`)给 `projectPlugins` 多喂两个来源:复用已注入的 `scanSkills` 结果筛 `source==="plugin"`,新注入 `scanPluginMcpServers`。`CapabilityServiceDeps` 加一个 `scanPluginMcpServers: () => PluginMcpServer[]` 依赖(保持可注入、可单测)。

### 4.5 barrel 导出
`packages/core/src/index.ts` 导出 `readPluginManifest`、`scanPluginMcpServers`、`PluginMcpServer`、`PluginManifest`、`invalidatePluginMcpCache`。

## 5. 命名空间与防撞

```
plugin 源 name:  <plugin>:<server>     # 例 superpowers:filesystem
独立 MCP name:   <server>              # 用户 settings.mcpServers 的裸名
```
派生的 plugin 源**不进** `settings.mcpServers`,故即便裸名相同也不冲突——它们活在不同的列表里(派生 vs 用户配置)。统一面板里 plugin-MCP 只作为插件的 child 出现,不在「独立 MCP」区重复。

## 6. 测试

- **`readPluginManifest` 单测**:有 `mcpServers` / 无该字段 / 文件缺失 / JSON 损坏 → 期望解析对象 / null。临时目录写 fixture,对齐 `manager.test.ts` 的 tmpdir 模式。
- **`scanPluginMcpServers` 单测**:mock `readInstalledPlugins` + 临时 installPath 目录,放含/不含 manifest 的插件,断言产出的 `{pluginName, serverName, server.name}`(含 `:` 前缀防撞)。
- **`projectPlugins` 增强单测**(`capability-control/project.test.ts` 扩充):喂 pluginSkills + pluginMcpServers,断言 plugin descriptor 的 `origin.children` 含正确归类的 skill/mcp 子项;开关仍是 `disabledPlugins` denylist;不属于任何插件的 skill/mcp **不**出现在 children。
- **`CapabilityService.list` 回归**:四源仍齐;plugin descriptor 带 children。
- **回归**:`bun test packages/core/src` 全绿(执行层零碰)。

## 7. 迁移步骤(TDD)

1. `pluginManifest.ts` + 单测(红→绿)。
2. `pluginMcpLoader.ts`(`scanPluginMcpServers` + memoize)+ 单测。
3. `CapabilityDescriptor.origin.children` 加类型;`projectPlugins` 增强 + 单测。
4. `CapabilityServiceDeps` 加 `scanPluginMcpServers`;`service.ts` 装配;`service.test.ts` 扩充。
5. barrel 导出;`tsc --noEmit` + 全量 `bun test`。
6. (UI 在另一个 spec/plan:统一面板消费 `origin.children` 渲染可展开插件行。)

## 8. 明确不做(YAGNI / 下一期)

- **运行时连接**:把派生的 plugin 源真正 connect 进 `MCPManager`(让插件 MCP 工具能被模型调用)。本期只声明 + 展示 + 开关。连接需决定:虚拟源何时进 `connectAll`、disabledPlugins 如何过滤、工具名前缀策略——独立一期。
- **manifest 其余字段**:name/version/permissions/commands inline 等一律忽略。
- **用户在面板里单独开关 plugin 内的 mcp/skill**:刻意不做,开关粒度跟 plugin 走(本设计的前提)。

## 9. 收益

- 「插件含哪些 MCP / Skill」从**算不出**变成**可投影**,统一面板能照 Codex 那样如实展开插件子项。
- 归属走**派生视图 + scanner 产出结构**,`MCPServerConfig`/执行层类型零改动,边界干净。
- 与现有 plugin skill 的发现/投影模型完全同构,新增来源只是「多一个 scanner + 投影多消费一个入参」。
