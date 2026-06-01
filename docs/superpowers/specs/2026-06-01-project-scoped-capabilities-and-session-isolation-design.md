# 项目级能力配置化与 Session 隔离修复设计

> 日期：2026-06-01  
> 目标仓：`~/Documents/个人学习/代码学习/codeshell`  
> 状态：设计草案  
> 关联调研：`docs/research/session-isolation-state.md`  
> 关联既有设计：`docs/superpowers/specs/2026-05-29-capability-control-design.md`

## 0. 一句话

CodeShell 已经有 user/project/local 多级 settings 地基，也有统一能力控制层雏形，但当前写路径基本只落到 user scope；同时 model 选择仍依赖共享 `modelPool.activeKey`，导致多 session 串台，并使项目级 model 配置无法可靠隔离。本设计把 skill/plugin、subagent、MCP server 的开关与定义先接入 project scope，并把 model 方案绑定到现有 session 隔离债的根因修复：model 选择必须 per-session 化，项目级 model 只作为新 session 默认值或 session overlay 的输入，不能继续写共享 activeKey。

## 0.1 设计摘要 / 结论

首期可交付的后端范围是：**project scope settings 写路径 + `capabilityOverrides` 三态 overlay + skill/plugin/MCP/agent 的项目级读写 + 项目级 agent 定义目录**。这些能力不要求重启应用，至少应在下一次 run / 下一次能力装配时生效。

model 相关能力纳入设计，但不建议在未修 session 隔离前暴露完整「项目级 model」设置。推荐路径是先把主模型选择从共享 `modelPool.activeKey` 迁到 per-session 状态，再接入 project 默认值与 `auxModelKey` overlay；如果排期不允许，则首期只做 skill/plugin/MCP/agent，project model 设置在 UI 中隐藏或标记为后续。

明确不做：不热断开共享 MCP 连接、不把项目配置实现成第二套 denylist、不让项目开关直接改全局 settings、不在首期把 builtin tools 纳入 `capabilityOverrides`。

## 1. 背景与目标

最初触发问题是：桌面设置里切换「后台任务模型」`auxModelKey` 后不生效。排查发现它不是孤立 UI bug，而是共享 runtime 与配置写路径混在一起后的症状：

1. `auxModelKey` 写入 `~/.code-shell/settings.json` 后，`Engine.resolveAuxClient()` 会重新读 settings，但后续仍向共享 `modelPool` 查找新 key；共享 runtime 下 `modelPool` 启动后不随 settings 刷新，因此找不到新模型时静默回退主模型。
2. 多 session 下 model 选择依赖共享 `modelPool.activeKey`，A session 切模型会污染 B session。
3. settings 已支持 project scope，但能力开关与 subagent 写入路径仍主要固定到 user scope，导致「项目级配置」在 UI/服务层没有真正打通。

本设计目标：

- 为项目级能力配置提供清晰的继承/覆盖语义。
- 打通 project scope 写路径，先覆盖 skill/plugin、subagent、MCP server。
- 明确 model 与 session 隔离债的关系，避免引入新的共享状态串台。
- 保持现有全局配置兼容，不破坏 `disabledSkills` / `disabledPlugins` / `mcpServers.<name>.enabled` 等已有字段。

非目标：

- 不在首期重做整个 settings schema。
- 不在首期重做所有 UI；UI 可以后置，先完成后端读写语义。
- 不要求 MCP 已连接实例热重载；仍可沿用「下次 run / 下次连接生效」语义。

## 2. 现状与证据

### 2.1 settings scope 地基已存在

`SettingsManager` 已经定义多级 settings 路径和优先级：`cli > local > project > user > managed`。项目级配置文件位于 `${cwd}/.code-shell/settings.json`，local 配置文件位于 `${cwd}/.code-shell/settings.local.json`。相关位置：

- `packages/core/src/settings/manager.ts:85`：project settings 路径。
- `packages/core/src/settings/manager.ts:88`：local settings 路径。
- `packages/core/src/settings/manager.ts:163`：当前只有 `saveUserSetting()` 写路径。

settings schema 中已有能力相关字段：

- `packages/core/src/settings/schema.ts:178`：`mcpServers.<name>.enabled`。
- `packages/core/src/settings/schema.ts:189`：`disabledSkills`。
- `packages/core/src/settings/schema.ts:196`：`disabledPlugins`。
- `packages/core/src/settings/schema.ts:206`：`disabledAgents`。
- `agent.enabledBuiltinTools` / `agent.disabledBuiltinTools` 已在既有能力控制设计中确认，见 `docs/superpowers/specs/2026-05-29-capability-control-design.md:16-24`。

### 2.2 能力总览 UI 已预留 project 概念，但后端未接通

`CapabilitiesOverviewSection` 已有 `scope: "user" | "project"` 与 `activeRepoPath` prop，说明 UI 层已经知道能力开关有 user/project 两个视角，但 service 写路径仍缺 scope 参数。

- `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx:23-26`：`scope: "user" | "project"` 与 `activeRepoPath` prop。
- `packages/desktop/src/renderer/repos.ts`：`Repo[]` 存 `localStorage`，key 为 `codeshell.repos` / `codeshell.activeRepoId`。这是「项目列表」的唯一来源，能力总览页的项目枚举应复用它。
- `App.tsx` 将 `activeRepo?.path ?? null` 作为 `activeRepoPath` 传给 `SettingsPage` / `ChatView` / `CustomizeView`。

### 2.3 当前能力控制层仍写 user scope

既有能力控制设计已把 builtin/MCP/skill/plugin 统一成 `CapabilityDescriptor` 与 `CapabilityService.setEnabled()`，但当时设计明确复用 `SettingsManager.saveUserSetting()`，未引入 project 写路径：

- `docs/superpowers/specs/2026-05-29-capability-control-design.md:141-170`：`setEnabled(id, on)` 根据 `descriptor.control` 路由。
- `docs/superpowers/specs/2026-05-29-capability-control-design.md:152/158/165`：写入均调用 `saveUserSetting()`。
- `packages/core/src/capability-control/service.ts`：`setEnabled(id, on)` 实现层硬调 `saveUserSetting()`，无 scope 参数。
- `packages/desktop/src/main/capabilities-service.ts`：`setCapabilityEnabled(cwd, id, on)` 无 scope 参数。注意此文件在 **main 进程**（非 renderer），scope 透传是跨 IPC 的，不是 renderer 内部调用。

### 2.4 subagent 写路径固定在 user agents 目录

subagent 定义在 service 层**只会写 user 目录** `~/.code-shell/agents/`：编辑任何同名 agent（含项目内置）都会重定向到 user 目录生成 override 文件，service 显式拒绝写 user 目录之外的路径（`agents-service.ts:7` "Writes only ever touch the USER-level dir"、`:113` "Refuses anything outside ~/.code-shell/agents"）。项目级 agents 目前只作为**扫描来源**参与读取，无法从设置页/服务层保存或删除。

- `packages/desktop/src/main/agents-service.ts`：`saveAgent()` 无 `scope` / `cwd` 参数；写路径硬编码为 `userAgentsRoot()`（`:38`）。注意此文件同样在 **main 进程**。
- 现有扫描优先级见 `packages/core/src/engine/engine.ts:222-242`：`1. project <cwd>/.code-shell/agents` → `2. user ~/.code-shell/agents`，注释明写 **"user wins on name"**——即**现状是 user 覆盖 project**。本设计 §7.2 将有意反转这一优先级，详见该节。
- 需要新增 `${cwd}/.code-shell/agents/` 写入路径，并重新定义 user/plugin/project 多来源合并优先级。

### 2.5 session 隔离债已确诊

`docs/research/session-isolation-state.md` 已完成系统调研，关键结论：

- 单 worker 进程承载多 session，`ChatSessionManager` 支持 `maxSessions: 16`，桌面多 tab 是真实并发。
- 每个 session 有独立 `Engine` 实例，但若传入 `runtime`，`Engine` 优先复用全局单例。
- `agent-server-stdio.ts:75-111` 通过 seed Engine 抽出共享 `modelPool` / `toolRegistry` / `mcpPool` / `costTracker`。
- `modelPool` 含 `activeKey`，共享范围是全 worker，串台风险已确诊，见 `docs/research/session-isolation-state.md:20-30`。
- `planMode` / `permissionMode` 已经接入 per-session configure 分支，但 `model` 仍在全局 configure 分支，见 `docs/research/session-isolation-state.md:53-72`。

真实故障链：DeepSeek 的 `maxOutputTokens=384000` 残留到直连 OpenAI `gpt-5.5`，触发 `max_tokens is too large` 400，见 `docs/research/session-isolation-state.md:76-99`。

## 3. 设计决策

| 决策点 | 结论 |
|---|---|
| 配置模型 | 项目覆盖全局，沿用 `SettingsManager` 现有 `project > user` 优先级。 |
| 首期范围 | 后端优先交付 skill/plugin、subagent、MCP server；model 纳入设计但建议放到 session 隔离 Phase 4；builtin tools 首期不纳入。 |
| 覆盖语义 | 使用三态覆盖：`inherit` / `on` / `off`。项目级不直接改全局 denylist。 |
| 兼容策略 | 现有全局 `disabledX[]`、`mcpServers.<name>.enabled` 一字不动，继续表达全局态。 |
| model 策略 | 不继续依赖共享 `modelPool.activeKey`；model 项目级配置必须以 per-session model 状态为前提。 |
| UI 策略 | 首期后置 UI，先把后端 project scope 读写打通。 |

## 4. 核心数据模型：项目级三态覆盖

### 4.1 保留现有全局字段

现有字段继续作为全局默认态：

```jsonc
{
  "disabledSkills": ["superpowers:brainstorming"],
  "disabledPlugins": ["superpowers"],
  "disabledAgents": ["legacy-agent"],
  "mcpServers": {
    "playwright": { "enabled": true }
  }
}
```

这些字段仍可由 user scope settings 写入，保证现有行为零回归。

### 4.2 新增项目级覆盖表

项目级 settings 引入 `capabilityOverrides`，只表达「本项目相对全局默认的覆盖」：

```jsonc
// ${cwd}/.code-shell/settings.json
{
  "capabilityOverrides": {
    "skills": {
      "superpowers:brainstorming": "off",
      "project-doc-helper": "on"
    },
    "plugins": {
      "superpowers": "off"
    },
    "agents": {
      "my-agent": "on"
    },
    "mcp": {
      "playwright": "off"
    }
  }
}
```

类型建议：

```ts
export type CapabilityOverride = "inherit" | "on" | "off";

export interface CapabilityOverrides {
  skills?: Record<string, CapabilityOverride>;
  plugins?: Record<string, CapabilityOverride>;
  agents?: Record<string, CapabilityOverride>;
  mcp?: Record<string, CapabilityOverride>;
}
```

实现上可以选择不持久化 `inherit`，用户将某项重置为继承时删除对应 key，减少 settings 噪音。

> builtin tools 首期不放进 `capabilityOverrides`。原因是 builtin 当前还叠加 preset 默认集、`agent.enabledBuiltinTools`、`agent.disabledBuiltinTools` 三层语义，比 skill/plugin/MCP/agent overlay 更复杂。若后续要支持，可单独增加 `capabilityOverrides.builtin` 并设计 preset 交互。

### 4.3 生效计算

统一公式：

```ts
function applyOverride(globalEnabled: boolean, override?: CapabilityOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return globalEnabled;
}
```

各能力的 `globalEnabled` 来源保持现状：

- skill：`!disabledSkills.includes(skillName)`。
- plugin：`!disabledPlugins.includes(pluginName)`。
- agent：`!disabledAgents.includes(agentName)`。
- MCP：`mcpServers[name]?.enabled !== false`。

关键点：项目级覆盖表不是另一个 denylist。它是 overlay，因此可以表达「全局关、项目强开」以及「全局开、项目强关」。

## 5. 后端写路径设计

### 5.1 SettingsManager 新增 project 写 API

新增：

```ts
saveProjectSetting(key: string, value: unknown, cwd: string): void;
deleteProjectSetting?(key: string, cwd: string): void;
getForScope?(scope: "user" | "project", cwd?: string): Partial<ValidatedSettings>;
getEffective?(cwd?: string): ValidatedSettings;
```

要求：

- 使用与 `saveUserSetting()` 相同的点号路径写入能力。
- 复用原子写入策略。
- 写入 `${cwd}/.code-shell/settings.json`，必要时创建目录。
- 写入后 invalidate 当前 settings cache。
- 对 `cwd` 做规范化与边界校验，避免传入空 cwd 或非项目路径时意外写到错误位置。
- capability overlay 计算不能只依赖已合并的 `get()` 结果；需要能分别读取 user/global baseline 与 project overlay。可以显式新增 `getForScope()` / `getEffective()`，也可以在 `SettingsManager` 内部提供等价 raw-scope 读取能力。

### 5.2 CapabilityService 支持 scope

将现有：

```ts
setEnabled(id: string, on: boolean): void
```

扩展为：

```ts
type SettingsScope = "user" | "project";
type ProjectCapabilityState = "inherit" | "on" | "off";

setEnabled(id: string, on: boolean, opts?: { scope?: SettingsScope; cwd?: string }): void;
setOverride?(id: string, state: ProjectCapabilityState, opts: { scope: "project"; cwd: string }): void;
```

推荐语义：

- `scope: "user"`：保持当前行为，写 `disabledSkills` / `disabledPlugins` / `mcpServers.<name>.enabled` 等全局字段。
- `scope: "project"`：不写全局 denylist，写 `capabilityOverrides.<bucket>.<token>`。
- `inherit`：删除项目覆盖 key，而不是写入字符串。

示例路由：

```ts
if (scope === "project") {
  const path = `capabilityOverrides.${bucket}.${token}`;
  if (state === "inherit") settings.deleteProjectSetting(path, cwd);
  else settings.saveProjectSetting(path, state, cwd);
  return;
}

// user scope: existing descriptor.control route
writeExistingUserControl(descriptor.control, on);
```

### 5.3 desktop service / IPC 透传 scope

扩展 renderer service：

```ts
setCapabilityEnabled(cwd: string, id: string, on: boolean, opts?: { scope?: "user" | "project" }): Promise<void>;
setCapabilityOverride(cwd: string, id: string, state: "inherit" | "on" | "off"): Promise<void>;
```

IPC payload 需要包含：

- `cwd`：用于加载对应项目 settings。
- `scope`：user/project。
- `id`：`skill:<name>` / `plugin:<name>` / `mcp:<server>` / `agent:<name>`。
- `state`：project scope 下优先使用 `inherit/on/off`。

## 6. 读取与投影设计

### 6.1 CapabilityDescriptor 增加 scope 视图信息

保留既有 descriptor 概念，增加 project overlay 相关字段：

```ts
interface CapabilityDescriptor {
  id: string;
  kind: "mcp" | "skill" | "plugin" | "agent";
  name: string;
  enabled: boolean;          // 当前 scope 视图下最终生效值
  globalEnabled: boolean;    // user/global 态
  projectOverride?: "on" | "off";
  effectiveSource: "user" | "project" | "default";
  control: CapabilityControl;
  /** 对 agent 等「定义型」能力：当前生效定义来源 + 被遮蔽的同名定义来源。
   *  用于 §7.2 反转优先级后向用户提示「本项目覆盖了你的 user 版本」。 */
  definitionSource?: "project" | "user" | "plugin" | "builtin";
  shadowedSources?: Array<"project" | "user" | "plugin" | "builtin">;
}
```

如果 UI 首期后置，后端仍应返回这些字段，方便后续设置页展示「继承自全局 / 本项目覆盖」。

### 6.2 readDisabledLists 的合并点

当前 engine 在 `readDisabledLists()` 中读取合并后的 disabled 数组，作为 skill/plugin 过滤输入。项目级覆盖应在这一层附近生效，因为这里正好是 run 期能力装配入口：

- `packages/core/src/engine/engine.ts:2002-2021`：当前 `readDisabledLists()` 只读合并后的 `disabledX` 数组。
- `docs/research/session-isolation-state.md:38-49`：skills 在每次 run 重算，per-run 装配本身是好设计。

建议改为：

1. 读取 user/global settings 得到 `globalEnabled`。
2. 读取 project `capabilityOverrides` 得到 overlay。
3. 输出最终 disabled lists 给现有 scanner/dispatcher 使用。

注意：如果 `SettingsManager.get()` 已经按 `project > user` 合并，那么不能让项目级 `disabledSkills` 数组简单覆盖 user 数组，否则无法表达三态继承。这里必须使用 raw-scope 读取能力：先读 user/global baseline，再读 project `capabilityOverrides`，最后在 capability 层做 overlay 计算。换言之，`get()` 的 effective settings 适合普通配置读取，但不适合单独承担三态继承计算。

### 6.3 MCP server 的读取语义

MCP 全局字段仍为 `mcpServers[name].enabled`。项目级 `capabilityOverrides.mcp[name]` 只影响当前项目/session 的可见能力。

首期可接受语义：

- 如果 MCP pool 已连接但项目覆盖为 off：工具投影与 tool definitions 过滤掉该 server 的工具。
- 不要求立即断开共享 MCP 连接。
- 下次 `connectAll` 时可跳过 project off 的 server，但必须小心共享 `mcpPool` 不应因一个项目 off 而断开另一个项目需要的连接。

因此更安全的模型是：底层连接池可共享，session/project 看到的是过滤后的能力视图。

实现边界：MCP project overlay 必须在 `getToolDefinitions()` / per-run tool snapshot / capability projection 层过滤，**不能**从共享 `ToolRegistry` unregister 工具，也不能因为某项目把 server 设为 off 就断开共享 `MCPManager` 连接。否则 A 项目关闭 `playwright` 会让 B 项目也失去同一 server 的工具。

## 7. subagent 项目级定义

subagent 不只是开关，还包括定义文件写入，因此工程量大于 skill/plugin/MCP 开关。

### 7.1 新增项目级 agents 目录

新增写路径：

```text
${cwd}/.code-shell/agents/<agent-name>.md
```

API 扩展：

```ts
saveAgent(def: AgentDefinition, opts?: { scope?: "user" | "project"; cwd?: string }): Promise<void>;
deleteAgent(name: string, opts?: { scope?: "user" | "project"; cwd?: string }): Promise<void>;
```

语义：

- `scope: "user"`：保持写 `~/.code-shell/agents/`。
- `scope: "project"`：写 `${cwd}/.code-shell/agents/`。
- project 写入要求 cwd 必填。
- 删除 project agent 只删除项目目录中的定义，不影响 user/plugin 同名定义。

### 7.2 多来源合并优先级（⚠ 有意反转现状）

目标读取优先级：

```text
project agents > user agents > plugin agents > builtin agents
```

**这是对现有行为的有意反转，不是顺承。** 现状（`packages/core/src/engine/engine.ts:222-242`）是 user 目录在 project 目录之后扫描并以 **"user wins on name"** 覆盖，即**现状是 user > project**。本设计明确将其改为 **project > user**，实现时必须：

1. 修改 `engine.ts:222-242` 的合并逻辑，让同名时 project 定义胜出。
2. 增加**回归测试**覆盖反转（见 §12.3）：旧的 "user wins" 行为会被这次改动改掉，必须有测试钉住新语义，避免无声回退。
3. 在迁移说明中标注：曾依赖「user agent 覆盖 repo 内置同名 agent」的用户，行为会变化。

理由（为什么值得反转）：

- 项目定义最贴近当前 repo，团队在 repo 里内置的 agent 应当对该 repo 生效。
- user 定义表达跨项目的个人默认，作为兜底。
- plugin/builtin 是可复用基线。

**风险与缓解**：project > user 意味着 clone 一个外部 repo 时，repo 内携带的同名 agent 定义会**静默替换**你信任的 user 版本（一个可执行行为被换掉，非纯开关）。因此本设计要求：

- descriptor 暴露 `definitionSource` 与 `shadowedSources`（见 §6.1）。
- UI 在被项目覆盖处显式提示「本项目覆盖了你的 user 版本（点击查看/还原）」。
- 该提示是反转优先级能被接受的前提，不是可选项。

> 注：本节只针对 agent **定义文件**谁胜出。能力的**开/关**走 §4 的三态 overlay，开关层面 project overlay 本就能盖过 user 全局态，与本节无关。

### 7.3 agent 开关 overlay

agent 的开关使用 `capabilityOverrides.agents`：

```jsonc
{
  "capabilityOverrides": {
    "agents": {
      "code-reviewer": "off",
      "project-planner": "on"
    }
  }
}
```

最终启用公式与其他能力一致。

## 7.5 能力总览页（多项目树形导航）

改造现有 `CapabilitiesOverviewSection`，从「单一 scope 视图」升级为「跨层级总览」。

### 7.5.1 层级范围

- **用户（全局）**：一行，对应现有 user scope 字段，表达全局默认态。
- **项目**：来自 `repos.ts` 的 `Repo[]`（`localStorage` key `codeshell.repos`）逐个枚举，每个项目一行，写 `${repo.path}/.code-shell/settings.json` 的 `capabilityOverrides`。
- **会话（session）层：本期不做。** 留待 §8 的 per-session 隔离（方案 A）落地后再加；届时会话 overlay 只活在内存、关闭即弃。本页不出现会话 tab，避免给出无法兑现的承诺。

优先级：**项目 > 用户**（与 §4 三态 overlay 一致；agent 定义文件的 project > user 见 §7.2）。

### 7.5.2 布局

左树右单：左侧一棵两层树（用户 + 项目列表），右侧是选中 scope 的能力清单。

```text
能力总览
┌─────────────┬───────────────────────────────┐
│ 用户(全局)   │ [codeshell] 的能力             │
│ 项目         │  Skills                        │
│  ▸ codeshell │   brainstorming   [继承▾]      │
│  ▸ tanka-web │   doc-helper      [开]         │
│  ▸ foo-svc   │  Plugins                       │
│             │   superpowers     [关]         │
│             │  Agents                        │
│             │   code-reviewer   [继承] ⚠覆盖  │
│             │  MCP                           │
│             │   playwright      [继承▾]      │
└─────────────┴───────────────────────────────┘
```

- 选中「用户」：能力项是**二态**（开/关），写全局字段，等价现有行为。
- 选中某「项目」：能力项是**三态**（继承/开/关），写该项目 `capabilityOverrides`；「继承」删除对应 key（§5.2）。
- 每项展示最终生效值，并标注来源（继承自全局 / 本项目覆盖），数据取自 §6.1 descriptor 的 `effectiveSource`。
- 对 agent，若 `shadowedSources` 非空，显示 ⚠「本项目覆盖了你的 user 版本」提示（§7.2 缓解措施）。

### 7.5.3 service / prop 调整

- 组件 prop 从单个 `scope` + `activeRepoPath` 改为：项目列表（`Repo[]`）+ 当前选中 scope（`{ kind: "user" } | { kind: "project"; repoPath: string }`）。
- 切换树节点 → 用对应 `cwd` 重新拉取该 scope 的 descriptor 列表。
- 勾选写入走 §5.3 的 `setCapabilityEnabled` / `setCapabilityOverride`，带 `scope` + `cwd`。
- 注意：底层 service 在 main 进程（`packages/desktop/src/main/capabilities-service.ts`），所有写入经 IPC，payload 必带 `cwd`。

## 8. model 与 session 隔离设计

model 是本设计风险最高的部分。项目级 model 配置如果继续写共享 `modelPool.activeKey`，会直接复现多 session 串台，因此必须先定义隔离边界。本节拆成三层：主模型 session 隔离、后台模型 `auxModelKey`、per-model runtime 状态去毒。

### 8.1 当前 bug 链

- `EngineRuntime` 共享 `modelPool`、`toolRegistry`、`settings`、`mcpPool`、`costTracker`、`sandboxCache`，见 `packages/core/src/engine/runtime.ts:24`。
- 共享 runtime 的引入动机是 bootstrap-then-extract：`agent-server-stdio.ts:9-26` 注释说明用 seed Engine 初始化后抽出 pool/registry 共用。
- `modelPool.activeKey` 是共享状态，`model-pool.ts:202`。
- `server.ts:454` 已有 per-session configure 分支，但只处理 planMode / permissionMode，model 留在全局分支。
- `types.ts:136` 注释已说明 `sessionId` 存在时 configure 特定 chat session，否则 worker-global。
- 前端切模型 `App.tsx:971` 调 `configure({ model: opt.key })` 不带 `sessionId`，必然落入全局分支。

### 8.2 主模型：model/activeKey per-session 化

推荐把 model 选择从共享 `ModelPool.activeKey` 中拆出，成为 session 私有状态：

```ts
interface SessionModelState {
  modelKey?: string;          // 当前 session 显式选择
  pendingModelKey?: string;   // run 中切换时挂起
  defaultModelKey?: string;   // 来自 user/project settings 的初始默认
}
```

语义：

1. 新 session 创建时，从项目 settings overlay + user settings 计算默认 model。
2. `configure({ sessionId, model })` 写对应 session 的 `modelKey`。
3. `configure({ model })` 无 `sessionId` 时只更新全局默认，用于未来新 session，不影响已有 session。
4. run 进行中切换 model 不修改当前 run 正在使用的 client；写入 `pendingModelKey`，run 结束后生效。
5. `Engine.run()` 在 run 入口读取 session model state，构建本 run 的 `llmClient`。

`ModelPool` 可继续作为「模型目录 / 模型定义 registry」存在，但不应再持有跨 session 生效的 `activeKey`。如果需要保留 `activeKey` API 兼容旧调用，应将它降级为全局默认值，只用于新 session 初始化，不用于已有 session 的 run 决策。

这与 `docs/research/session-isolation-state.md:182-188` 的落地建议一致：

- 立即止血：`max_tokens` 查不到就省略。
- 根因：`model` / `activeKey` 进入 per-session 状态容器。
- 去毒：per-model 字段不要挂在长寿 client 上。
- 装配时机：model / max_tokens per-turn 或至少 per-run 现算。

### 8.3 后台模型：auxModelKey 的项目级语义

`auxModelKey` 是后台任务模型，应支持 project overlay，但不能依赖启动时共享 `modelPool` 是否包含该 key。

推荐新增 `modelOverrides.auxModelKey`，不复用顶层 `auxModelKey` 作为项目覆盖字段：

- user scope：继续保存全局 `auxModelKey`。
- project scope：保存 `modelOverrides.auxModelKey`。

理由：顶层 `auxModelKey` 是普通 settings 字段，天然会被 `project > user` 合并；但本设计希望 model 与 capability 一样保留「全局默认 + 项目覆盖」的可解释边界。独立的 `modelOverrides` 能避免实现者误用 effective settings，把项目默认值当作全局模型选择写回共享 runtime。

示例：

```jsonc
{
  "modelOverrides": {
    "auxModelKey": "openrouter:anthropic/claude-sonnet-4.5"
  }
}
```

`resolveAuxClient()` 不应只查启动时共享 `modelPool.get(auxKey)`；需要确保模型目录/配置源按当前 settings 解析，或在 settings 更新后重建当前 session 可见的 model registry。找不到 `auxModelKey` 时应明确 warn/error，不能静默 fallback 到主模型，否则用户无法判断项目级配置是否生效。

### 8.4 per-model runtime 状态去毒

session 隔离只能解决「谁选了哪个模型」的问题，还必须避免 per-model 字段残留在长寿 client 上。`docs/research/session-isolation-state.md:107-120` 已列出风险字段：`maxTokens`、capability cache、sticky flag、OpenAI SDK client 等。

实现原则：

- `max_tokens` / `max_completion_tokens` 必须按当前 run 的模型现算。查不到可信 `maxOutputTokens` 时，OpenAI 侧省略该字段；Anthropic 侧保留安全默认，因为其 API 要求必填。
- 切换模型不能原地修改正在复用 client 的 per-model 字段。可选实现是每次 run 整体重建 client，或按 `(provider, model)` key 缓存不可变 client。
- sticky flags（例如某模型 400 后学到的请求 shape）必须绑定到 provider/model key，不能污染另一个模型。
- model registry 可以共享，但 runtime client 状态必须是 per-run、per-session 或 per-model-key，而不是 worker-global mutable。

### 8.5 三个可选落地策略

| 策略 | 描述 | 优点 | 风险/缺点 | 建议 |
|---|---|---|---|---|
| A. 先修 session model 隔离，再接项目级 model | model/activeKey per-session 化，项目级 model 作为 session 默认与 overlay 输入 | 根因正确，长期稳定 | 工程量最大 | **推荐** |
| B. 首期暂缓 model，只做 skill/plugin/subagent/MCP | 不触碰 model，避免扩大范围 | 低风险，可快速交付能力配置 | 不能解决 auxModelKey 初始诉求 | 可作为分阶段方案 |
| C. model 只作为「新会话默认值」 | project model 只影响新 session，不保证运行中隔离 | 实现较小 | 容易被误解为完整项目级 model；仍需避免共享 activeKey 污染 | 仅可作为临时折中 |

正式实现建议选择 A；如果排期受限，可先交付 B，并在 UI 中明确隐藏或禁用 project model 设置，避免给出错误承诺。

## 9. 兼容与迁移

- 现有 user settings 无需迁移；没有 `capabilityOverrides` / `modelOverrides` 时，行为必须完全等同当前版本。
- 旧 UI / 旧 IPC 调用 `setCapabilityEnabled(id, on)` 没有传 `scope` 时，默认视为 `scope: "user"`，继续写现有全局字段。
- project settings 只新增字段，不重写既有 `disabledSkills` / `disabledPlugins` / `disabledAgents` / `mcpServers`。
- `inherit` 不落盘；重置继承时删除对应 project override key。
- 读取到未知 override value 时按 `inherit` 处理，并记录 warn，避免坏配置导致能力全部消失。
- project agent 定义优先级从现状的 user > project 反转为 project > user，这是唯一明确的行为变化；需要在 release note / UI 提示里说明。
- 若 Phase 4 未落地，不暴露 project model 设置；否则用户会误以为已有 session 也能可靠隔离。

## 10. 验收标准

功能完成后，至少应满足以下产品级验收：

1. 项目 A 将某个 skill 设为 off，不影响项目 B 与全局 user 设置。
2. 全局关闭某个 plugin 后，项目 A 可以通过 project override 将它强制 on，且只在项目 A 生效。
3. 项目 A 将某个 MCP server 设为 off 后，项目 B 仍能使用同一 server；共享 `ToolRegistry` / `MCPManager` 未被全局修改或断开。
4. 项目内新增同名 agent 时，项目 agent 胜出；删除项目 agent 后回落到 user agent；UI 能提示存在覆盖关系。
5. 旧版设置页或旧 IPC 不传 scope 时，仍按 user scope 修改全局能力开关。
6. 如果 Phase 4 落地：两个 session 同时切换主模型互不影响；无 `sessionId` 的 model configure 只改变新 session 默认值。
7. 如果 Phase 4 落地：修改项目级 `auxModelKey` 后，后台任务使用项目指定模型；模型 key 无效时给出明确 warn/error，不静默回退主模型。

## 11. 实施分期

### Phase 1：project scope 写路径与 overlay schema

- `SettingsManager.saveProjectSetting(key, value, cwd)`。
- `SettingsManager.deleteProjectSetting(key, cwd)` 或等价删除能力。
- settings schema 增加 `capabilityOverrides`。
- 单元测试覆盖点号路径写入、目录创建、原子写、invalidate。

### Phase 2：能力控制层 project overlay

- `CapabilityService.setEnabled()` 增加 scope/cwd。
- 新增 `setOverride()` 或等价 API 表达 `inherit/on/off`。
- descriptor 返回 `globalEnabled`、`projectOverride`、`effectiveSource`。
- desktop capabilities service / IPC 透传 scope/cwd/state。
- `readDisabledLists()` 或其上游能力计算接入 overlay。

### Phase 3：subagent 项目级定义

- `saveAgent(def, { scope, cwd })`。
- `deleteAgent(name, { scope, cwd })`。
- 新增 `${cwd}/.code-shell/agents/` 扫描与写入。
- **反转** `engine.ts:222-242` 合并优先级为 project > user > plugin > builtin，加回归测试（§12.3）。
- descriptor 暴露 `definitionSource` / `shadowedSources`。

### Phase 3.5：能力总览页（UI）

- 改造 `CapabilitiesOverviewSection` 为左树右单：用户 + `repos.ts` 项目列表。
- 选中节点按 `cwd` 拉取 descriptor；用户层二态、项目层三态。
- agent 覆盖处用 `shadowedSources` 渲染 ⚠ 提示。
- 不含会话层（待 Phase 4 之后）。

### Phase 4：model session 隔离与项目级 model

- `configure({ sessionId, model })` 接入 per-session 分支。
- 前端切模型带上 active session id。
- 无 `sessionId` 的 global configure 只更新新 session 默认，不影响已有 session。
- run 中切换 model 挂起到 run 边界。
- `max_tokens` 查不到时省略，Anthropic 保留安全默认。
- per-model runtime 字段整体重建或按 `(provider, model)` key 缓存，禁止原地修改长寿 client。
- 项目级 `auxModelKey` / 默认 model 接入 session 初始化。

## 12. 测试计划

### 12.1 settings 写入

- user scope setEnabled 仍写原字段，旧测试不变。
- project scope `off` 写 `capabilityOverrides.<bucket>.<token> = "off"`。
- project scope `on` 写 `"on"`。
- project scope `inherit` 删除覆盖 key。
- cwd 缺失时 project 写入报错。

### 12.2 能力合并

覆盖矩阵：

| globalEnabled | projectOverride | finalEnabled |
|---|---|---|
| true | undefined/inherit | true |
| true | off | false |
| true | on | true |
| false | undefined/inherit | false |
| false | off | false |
| false | on | true |

对 skill/plugin/agent/MCP 各跑一组。

### 12.3 subagent 合并

- **回归（反转语义）**：project/user 存在同名定义时 **project 胜出**（钉住对 `engine.ts:222-242` "user wins on name" 的反转，防无声回退）。
- project/user/plugin/builtin 四源同名时，project 胜出。
- 同名 project 覆盖 user 时，descriptor 的 `definitionSource === "project"` 且 `shadowedSources` 含 `"user"`（驱动 §7.2 的 UI 提示）。
- 删除 project agent 后回落到 user agent。
- project off 能禁用 project agent。
- project on 能启用全局 disabled agent。

### 12.4 session model 隔离

- 两个 session 并发，A 切 model 不影响 B。
- `configure({ sessionId, model })` 只影响目标 session。
- `configure({ model })` 只影响新 session 默认。
- run 中切换 model 不改变当前 run 的 client，下个 run 生效。
- DeepSeek `maxOutputTokens=384000` → gpt-5.5 时，请求中 `max_tokens` 省略或不超过 gpt-5.5 上限。
- `auxModelKey` 修改后，后台任务使用新 key；找不到时产生明确错误/警告，不静默回退主模型。

## 13. 风险与注意事项

1. **不要把项目级 overlay 实现成第二套 denylist。** 否则无法表达「全局关、项目开」。
2. **不要让 project MCP off 断开共享 MCP 连接。** 多 session/project 共享 pool 时，断开会影响其他 session。
3. **不要继续把 model 写到共享 activeKey。** 这会直接破坏项目级 model 隔离。
4. **不要依赖前端 busy 禁用作为唯一防线。** `docs/research/session-isolation-state.md:100-132` 已说明前端 busy 信号不可靠，后端必须有 run-state 防护。
5. **注意 settings 合并层与 overlay 层的边界。** `SettingsManager.get()` 的 project > user 合并适合普通标量，但能力三态 overlay 需要保留「继承」语义。
6. **subagent 定义覆盖需要可解释。** 同名覆盖如果 UI 不展示 source，会让用户误以为编辑的是全局 agent。

## 14. 待拍板问题

1. model 是否按推荐方案 A 进入本专项，还是先按 Phase 1-3.5 交付能力配置，model 单开专项？
2. builtin tools 是否作为未来扩展进入 `capabilityOverrides.builtin`？本稿首期明确不包含 builtin。
3. project local settings `${cwd}/.code-shell/settings.local.json` 是否也允许写能力 overlay？建议首期只写 project settings，local 留给机器私有/临时配置。
4. ~~project agent 与 user agent 同名时是否允许覆盖~~ **已拍板**：允许覆盖，**project > user**（反转现状，见 §7.2），必须在 descriptor 暴露 `definitionSource` / `shadowedSources` 并由 UI 提示。
5. ~~project `auxModelKey` 字段放在 `modelOverrides.auxModelKey`，还是复用顶层 `auxModelKey`~~ **本稿推荐** `modelOverrides.auxModelKey`，避免与普通 settings 合并语义混淆；如后续要改为复用顶层字段，需要同步修改 §8.3。

## 15. 关键文件索引

- `docs/research/session-isolation-state.md`：session 隔离现状、故障链、三家对标与修复优先级。
- `docs/superpowers/specs/2026-05-29-capability-control-design.md`：既有能力控制层设计。
- `packages/core/src/settings/manager.ts`：settings scope、`saveUserSetting()`。
- `packages/core/src/settings/schema.ts`：能力相关 schema。
- `packages/core/src/capability-control/service.ts`：当前能力开关服务。
- `packages/core/src/engine/engine.ts`：`resolveAuxClient()`、`reloadModelPool()`、`readDisabledLists()`、`switchModel()`、run 装配入口；`:222-242` agent 多源扫描与现状 "user wins on name"。
- `packages/core/src/engine/runtime.ts`：共享 runtime 定义。
- `packages/core/src/cli/agent-server-stdio.ts`：seed Engine bootstrap 与共享 runtime 组装。
- `packages/core/src/protocol/chat-session-manager.ts`：多 session 管理。
- `packages/core/src/protocol/server.ts`：`handleConfigure` per-session/global 分支。
- `packages/core/src/protocol/types.ts`：`configure({ sessionId })` 协议语义。
- `packages/core/src/model/model-pool.ts`：`activeKey`。
- `packages/desktop/src/renderer/settings/ModelSection.tsx`：`auxModelKey` 设置 UI。
- `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx`：能力总览页（待改造为多项目树形导航，见 §7.5）。
- `packages/desktop/src/main/capabilities-service.ts`：能力开关 service（**main 进程**）。
- `packages/desktop/src/main/agents-service.ts`：subagent 保存/删除 service（**main 进程**，当前只写 user 目录）。
- `packages/desktop/src/renderer/repos.ts`：桌面 repo 列表（`Repo[]`）与 activeRepoPath 来源，是能力总览项目列表的数据源。
