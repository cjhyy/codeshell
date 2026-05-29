# 能力收口设计：统一描述符 + 开关路由（控制层）

> 日期：2026-05-29
> 目标仓：`~/Documents/个人学习/代码学习/codeshell`
> 关联 commit：`7396c29`（设置页把 builtin/MCP/skill/子代理/钩子归到「扩展能力」UI 分组）
> 模块落点：`packages/core/src/capability-control/`（新目录）

## 0. 一句话

`7396c29` 已在 **UI 层**把扩展能力归成一组，但底层是**三套各走各的 loader、不同的元数据形状、分散的开关 config key**。本设计在三套 loader **之上**加一个**只读投影层 + 一个开关路由器**，让「列举 / 展示 / 开关」有单一入口，给那个 UI 分组一个真实后端。**执行层完全不动。**

## 1. 现状（已对照代码核实）

| 机制 | 加载落点 | 开关 settings key（真实路径） | 元数据形状 |
|---|---|---|---|
| **builtin** | `ToolRegistry`（`tool-system/registry.ts`），名字由 `resolveBuiltinToolNames` 选（`preset/index.ts:183`） | `agent.enabledBuiltinTools` / `agent.disabledBuiltinTools`（**嵌套在 `agent.` 下**，非顶层） | `RegisteredTool`（`source: "builtin"`） |
| **MCP** | `MCPManager.connectAll`（`tool-system/mcp-manager.ts:160`），`buildRegisteredTool` 映射进同一 `ToolRegistry`（`source: "mcp"`，带 `serverName`） | `mcpServers[name].enabled`（缺省/`true` 开，`false` 关；`connectAll` 在 `:165` 过滤 `enabled === false`） | `RegisteredTool`（`source: "mcp"`） |
| **skill**（project/user） | `scanSkills(cwd, opts)`（`skills/scanner.ts:228`），**不进 ToolRegistry**；`scanSkills` 会**过滤掉** disabled 项 | `disabledSkills`（精确名，顶层） | `SkillDefinition`（`source: "project"\|"user"\|"plugin"`） |
| **plugin** | `scanSkills` 的 plugin 分支，名字 `plugin:skill`（`scanner.ts:168`）；`readInstalledPlugins`（`plugins/installedPlugins.ts:21`） | `disabledPlugins`（裸插件名，匹配 `plugin:` 前缀，顶层） | `SkillDefinition`（`source: "plugin"`） |

**与原始草案的三处偏差（已修正进本稿）：**
1. builtin 的开关 key **嵌套在 `agent.` 下**，不是顶层。`SettingsManager.saveUserSetting` 已支持点号路径（`manager.ts:178`），故 `settingsKey` 用 `"agent.enabledBuiltinTools"` 等点号形式。
2. `src/llm/capabilities/`（模型能力，无关）已存在；为避免命名歧义，新模块落 **`src/capability-control/`**。
3. `saveUserSetting` 内部已调用 `invalidate()`（`manager.ts:197`），故路由器无需再显式 invalidate。

## 2. 为什么只收口控制层（不动执行层）

tool（模型直接调，走 `ToolRegistry`）与 skill（prompt 期展开 / dispatcher，走 `scanSkills`）是**故意区分**的两个概念。把 skill 硬塞进工具执行 trait 买不到 agent loop 想要的东西，却要付一次迁移。codeshell 执行层已收口到合理程度，值钱且低风险的收口在**控制层**。

## 3. 方案

```
                  ┌─────────────────────────────────────┐
   读（投影,只读）► │  CapabilityService  (新增, 薄)        │
                  │  list(): CapabilityDescriptor[]      │
                  │  setEnabled(id, on): void            │ ──► 按 descriptor.control 路由到底层 settings key
                  └───────┬──────────┬──────────┬────────┘
                          │          │          │
                  builtin投影    MCP投影     skill/plugin投影   （纯函数，输入=loader产出+settings）
```

**两条不变量：**
1. **执行层一行不动**：builtin/MCP 仍走 `ToolRegistry`，skill 仍走 `scanSkills` + dispatcher。
2. **`CapabilityDescriptor` 是算出来的视图，不是新真相源**。真相仍在三套 loader + settings。每次 `list()` 按需重投影，服务不持有可变状态。

### 3.1 分层落点

| 放哪 | 放什么 |
|---|---|
| `packages/core/src/capability-control/`（新） | `types.ts`（descriptor + control 类型）、`project.ts`（四个投影纯函数）、`service.ts`（`CapabilityService`：`list` + `setEnabled`）、`index.ts`（导出） |
| `packages/core/src/engine/engine.ts` | 只加装配/getter：用已有的 `toolRegistry`（`getToolRegistry()`）+ `SettingsManager`（`getSettingsManager()`）实例化 `CapabilityService`。零业务逻辑 |
| `packages/desktop/src/main`（设置页） | 只加两个 `ipcMain.handle` 端点 + service 转发：`capabilities:list` / `capabilities:setEnabled`，照 `skills:list`、`settings:get/set` 的现有模式（`index.ts:252`、`:543`）。不重新实现任何投影 |

## 4. 类型

```typescript
export interface CapabilityDescriptor {
  /** 全局唯一 id，source 前缀天然隔离命名空间 */
  id: string;                       // builtin:<tool> | mcp:<server> | skill:<name> | plugin:<name>
  kind: "builtin" | "mcp" | "skill" | "plugin";
  name: string;                     // 展示名（builtin=工具名；mcp=server名；skill=技能名；plugin=插件名）
  description: string;              // 一行描述，从底层元数据取
  enabled: boolean;                 // 已结合 preset 默认 + 开关 config 算出
  control: CapabilityControl;       // 这个开关写哪个 key、怎么写（路由用，也供 UI 显示来源）
  origin?: {
    serverName?: string;            // mcp
    pluginName?: string;            // plugin
    filePath?: string;              // skill
    toolCount?: number;            // mcp：该 server 暴露的工具数
    isReadOnly?: boolean;          // builtin/mcp
  };
}

export interface CapabilityControl {
  settingsKey:
    | "agent.enabledBuiltinTools"
    | "agent.disabledBuiltinTools"
    | "mcpServers"
    | "disabledSkills"
    | "disabledPlugins";
  /**
   *  - "denylist"    → 关 = 把 token 加进数组（disabled*）；开 = 移除
   *  - "allowlist"   → 开 = 把 token 加进数组（enabled*）；关 = 移除
   *  - "record-flag" → 翻转 mcpServers[token].enabled
   */
  mode: "denylist" | "allowlist" | "record-flag";
  token: string;                    // 写进数组/作为 record key 的标识
}
```

设计点：
- **`control` 内联在每个 descriptor 上**，`setEnabled` 不必再 switch kind——读 `descriptor.control` 即知往哪写、怎么写。投影逻辑与开关逻辑各一处，互不耦合。
- 不引入新真相字段（如 `pinned`/`order`），那是 UI 的事，YAGNI。

## 5. 四种来源各自怎么投影

每个投影函数 `(deps) => CapabilityDescriptor[]`，纯函数，输入是 loader 产出 + 当前 settings。

### 5.1 builtin
- **取数**：`toolRegistry.listToolsDetailed()` 过滤 `source === "builtin"`。
- **enabled 判定**：算 `resolveBuiltinToolNames({ preset, enabledBuiltinTools, disabledBuiltinTools })` 得到当前生效集；工具名在集合内即 `enabled: true`。
- **control（按工具是否在 preset 默认集分流）**：
  - 在 preset 默认集内 → `denylist` over `agent.disabledBuiltinTools`（关 = 加名）。
  - 不在 preset 默认集内 → `allowlist` over `agent.enabledBuiltinTools`（开 = 加名）。
  - （依据 `resolveBuiltinToolNames` 语义：base = preset.builtinTools，先并 enabled 再减 disabled。）
- **id**：`builtin:<toolName>`；`origin.isReadOnly` 取自 `RegisteredTool.isReadOnly`。

### 5.2 MCP（server 级）
- **取数**：`settings.mcpServers`（全量配置）+ `toolRegistry.listToolsDetailed()` 中 `source === "mcp"` 按 `serverName` 聚合算工具数。
- **粒度**：**server 级**（非单工具），UI 也按 server 分组。每 server 一个 descriptor，`origin.serverName` + `origin.toolCount`。
- **enabled 判定**：`config.enabled !== false`。
- **control**：`{ settingsKey: "mcpServers", mode: "record-flag", token: serverName }`。
- **id**：`mcp:<serverName>`。
- **注意**：未连接（仅配置）的 server 也要出 descriptor，靠 `settings.mcpServers` 全量；工具数缺省 0。

### 5.3 skill（project / user）
- **取数**：`scanSkills(cwd, {})`（**传空 opts 拿全量**——`scanSkills` 会过滤掉 disabled，不传空就拿不到关掉的项，UI 无法重开），过滤 `source ∈ {project, user}`。
- **enabled 判定**：`!settings.disabledSkills.includes(name)`。
- **control**：`{ settingsKey: "disabledSkills", mode: "denylist", token: name }`。
- **id**：`skill:<skillName>`；`origin.filePath` 取自 `SkillDefinition.filePath`。

### 5.4 plugin（插件级）
- **取数**：`readInstalledPlugins()` 列已装插件名（`<plugin>@<marketplace>` 取 `@` 前缀）；可选用 `scanSkills(cwd, {})` 中 `source === "plugin"` 的项按插件名聚合补描述。
- **粒度**：**插件级**。plugin skill 不单独出 descriptor（挂在 plugin 下），故不与 `skill:` 撞。
- **enabled 判定**：`!settings.disabledPlugins.includes(pluginName)`。
- **control**：`{ settingsKey: "disabledPlugins", mode: "denylist", token: pluginName }`。
- **id**：`plugin:<pluginName>`；`origin.pluginName`。

## 6. id 命名空间

```
builtin:<toolName>
mcp:<serverName>
skill:<skillName>      # project/user 裸名
plugin:<pluginName>
```
source 前缀天然隔离；plugin skill 不出独立 descriptor，无碰撞。

## 7. setEnabled 路由

```typescript
setEnabled(id: string, on: boolean): void {
  const d = this.list().find((c) => c.id === id);
  if (!d) throw new CapabilityNotFoundError(id);
  const { settingsKey, mode, token } = d.control;
  const cur = this.settings.get();

  switch (mode) {
    case "denylist": {                                   // 关 = token 在数组里
      const arr = new Set<string>(readArray(cur, settingsKey));
      on ? arr.delete(token) : arr.add(token);
      this.settings.saveUserSetting(settingsKey, [...arr]);
      break;
    }
    case "allowlist": {                                  // 开 = token 在数组里
      const arr = new Set<string>(readArray(cur, settingsKey));
      on ? arr.add(token) : arr.delete(token);
      this.settings.saveUserSetting(settingsKey, [...arr]);
      break;
    }
    case "record-flag": {                                // 翻转 mcpServers[token].enabled
      const servers = { ...(cur.mcpServers ?? {}) };
      if (!servers[token]) break;                        // 未配置的 server 不凭空创建
      servers[token] = { ...servers[token], enabled: on };
      this.settings.saveUserSetting("mcpServers", servers);
      break;
    }
  }
  // saveUserSetting 内部已 invalidate；无需再调。
}
```

- `readArray(cur, "agent.disabledBuiltinTools")` 按点号路径从 `ValidatedSettings` 取数组（builtin key 嵌套在 `agent.` 下）。
- 写入复用现有 `SettingsManager.saveUserSetting(key, value)`（原子 tmp+rename，支持点号路径），不新增持久化路径。

## 8. 生效时机

- **写入即落盘**（`saveUserSetting` 原子写）。
- **何时影响运行中 agent**：builtin/skill/plugin 在下次 `engine.run()` 重新 `resolveBuiltinToolNames` / `scanSkills` 时生效；MCP 的 `enabled` 在下次 `connectAll` 生效。**本设计不热重载运行中会话**（与现状一致，YAGNI）。UI 提示「下次对话生效」。

## 9. desktop 侧

只加两个转发端点，逻辑全在 core（照 `skills:list` / `settings:set` 既有模式）：

```typescript
// packages/desktop/src/main/capabilities-service.ts  (薄转发)
export function listCapabilities(cwd: string): CapabilityDescriptor[] { /* new CapabilityService(...).list() */ }
export function setCapabilityEnabled(cwd: string, id: string, on: boolean): void { /* ...setEnabled(id, on) */ }

// packages/desktop/src/main/index.ts
ipcMain.handle("capabilities:list", async (_e, cwd: string) => listCapabilities(cwd));
ipcMain.handle("capabilities:setEnabled", async (_e, cwd: string, id: string, on: boolean) => setCapabilityEnabled(cwd, id, on));
```

> 注：skills/plugins 发现走主进程直连 core（非 worker），故 `CapabilityService` 在主进程内实例化即可（`new SettingsManager(cwd, scope)` + 一个临时 `ToolRegistry`/或复用 seed engine 的 registry）。装配细节在实现计划里定。

## 10. 测试

- **投影单测**（`project.ts`）：mock `RegisteredTool[]` / `mcpServers` config / `SkillDefinition[]` + settings，断言产出的 `CapabilityDescriptor[]`（id、enabled、control、kind）。四源各一组，含「已关掉的项仍出现且 `enabled:false`」用例（skill/plugin/builtin/mcp 各验一遍）。
- **`setEnabled` 路由单测**（`service.ts`）：四种 mode × 开/关，断言写进 settings 的最终形状（denylist 增删、allowlist 增删、record-flag 翻转、未配置 server 不凭空建、点号路径写到 `agent.*`）。
- **回归**：跑现有 engine / tool-system 测试，确认执行层零行为变化（本设计不碰执行路径，应全绿）。

## 11. 迁移步骤（TDD）

1. 新建 `packages/core/src/capability-control/`：`types.ts`、`project.ts`、`service.ts`、`index.ts`。
2. 先写投影 + 路由单测（红），再实现（绿）。
3. `engine.ts` 装配：暴露 `CapabilityService`（或一个 getter），复用 `getToolRegistry()` + `getSettingsManager()`。
4. desktop：`capabilities-service.ts` 薄转发 + `index.ts` 两个 `ipcMain.handle`。
5. 跑全量测试回归。

## 12. 收益

- **UI 承诺的统一有真实后端**：「扩展能力」分组后端兑现。
- 四类能力的「列举 + 开关」收敛到**单一入口**；新增来源只需加一个投影函数 + 一条 control 路由。
- 改动是**投影 + 路由**，执行层零碰，风险面小、可单测、可一次成型。
