# Subagent 配置面板 — 设计文档

日期：2026-05-27
范围：在桌面 app 设置页新增一个「子代理 / Subagents」模块，让用户新增自定义子代理、禁用/启用内置的 4 个、修改任意子代理（含内置 4 个）的模型及其他字段。

## 背景与现状

- 子代理角色定义是磁盘文件：`<name>.md`，YAML frontmatter + markdown body。
  - frontmatter 字段：`name`（必填）、`description`（必填）、`model`（可选，ModelPool key）、`maxTurns`（可选）、`tools`（可选，工具名数组）。
  - body = 角色的 system prompt。
  - 类型定义：`packages/core/src/agent/agent-definition.ts` 的 `AgentDefinition`。
- 内置 4 个角色是**项目级**文件，随仓库版本控制：
  - `.code-shell/agents/researcher.md`、`explorer.md`、`planner.md`、`general-purpose.md`。
  - 四个的 `model` 当前都被注释掉（继承父模型）。
- 加载：`AgentDefinitionRegistry.loadFromDir(dir)`（`agent-definition-registry.ts`）扫单个目录的 `*.md`，非递归，坏文件跳过并告警。引擎 `loadAgentDefinitionsForCwd(cwd)` 只扫 `<cwd>/.code-shell/agents`（`engine.ts:189-192`），按 cwd 缓存（`engine.ts:1797-1802`）。
- 模型解析：`resolveChildLlm(modelKey, pool, parentLlm)`（`engine.ts:177-187`）。agent 的 `model` 是 ModelPool **key**，不是任意模型串；key 不存在时静默回退父模型。
- `agent_type` 解析：`resolveAgentTypeOverrides`（`agent.ts:52-68`）。未知 type → 抛错 `unknown agent_type 'x'. Available: ...`。
- 当前 Agent 工具的 `agent_type` 入参是**自由字符串**（`agent.ts:136-142`），无 enum，LLM 并不被告知有哪些可用角色。
- 禁用机制：skills 用 `settings.disabledSkills`、插件用 `settings.disabledPlugins`（`schema.ts:176-184`）。**目前没有 `disabledAgents`。**
- 桌面侧目前没有任何 agent 定义管理的 UI / IPC / preload 方法。
- 模型 key 列表来源：`settings.models[].key`（+ 可选 `label`），见 `schema.ts:81-115`。

## 核心设计决策

1. **存储位置**：用户的新增与对内置的修改一律写到**用户级** `~/.code-shell/agents/<name>.md`。内置的项目级文件永不被改写。
2. **覆盖语义**：加载时合并项目级 + 用户级两个目录，**用户级同名文件覆盖项目级**。即「修改内置 researcher 的模型」= 在 `~/.code-shell/agents/researcher.md` 写一份覆盖文件。
3. **禁用语义（关键）**：禁用 = **从源头让 LLM 不可见**，而非运行时拦截。被 `settings.disabledAgents` 列出的角色名在注册表加载后被过滤掉：既不进 `registry.list()`，`registry.get()` 也取不到。于是它自动从 Agent 工具暴露给 LLM 的可用角色列表中消失。既有的 unknown-type 抛错（`agent.ts:58-60`）天然成为兜底——无需新增「报错 vs 回退」逻辑。
4. **`agent_type` 对 LLM 可见**：把当前可用（已过滤禁用项）的角色名动态列进 Agent 工具 `agent_type` 入参的描述中，让 LLM 知道有哪些角色可选。
5. **模型选择**：编辑表单里 `model` 是**下拉**，选项 = `settings.models[].key`（显示 label），外加「跟随父模型（继承）」选项（= 不写 model 字段）。不自由输入。
6. **工具选择**：`tools` 是**多选勾选**，候选来自 core 枚举的内置工具名。不勾任何 = 不写 tools 字段 = 继承父全集。
7. **新增表单**：全字段（name / description / model / maxTurns / tools / system prompt）。

## core 改动

### schema
`packages/core/src/settings/schema.ts`：在 `disabledSkills` / `disabledPlugins` 旁新增
```ts
disabledAgents: z.array(z.string()).default([]),
```

### agent 定义序列化
`packages/core/src/agent/agent-definition.ts`：新增 `serializeAgentDefinition(def: AgentDefinition): string`，把 `AgentDefinition` 写回 frontmatter + body 字符串（与 `parseAgentDefinition` 互逆）。省略未设置的可选字段（不写 `model` 即继承）。

### 工具名清单
若 core 尚未导出「全部内置工具名」清单，则新增一个导出（枚举内置工具：Read/Grep/Glob/WebSearch/Edit/Write/Bash/Agent 等）。桌面侧 `tools` 多选用它当候选。实现前确认是否已有现成导出，有则复用。

### 注册表合并 + 来源标记 + 禁用过滤
- `AgentDefinition` 增加可选元信息（不进 frontmatter，仅运行期）：`source?: "builtin" | "user"`、`filePath?: string`、`override?: boolean`。或在 registry 层用单独结构携带，避免污染序列化。**实现时择一，保持序列化纯净。**
- `loadAgentDefinitionsForCwd(cwd)` 改为合并：
  1. 项目级 `<cwd>/.code-shell/agents/*.md` → 标 `source: "builtin"`（更准确说是「项目级」，但 UI 上内置 4 个即来自此）。
  2. 用户级 `~/.code-shell/agents/*.md` → 标 `source: "user"`；同名时覆盖项目级，并把该项 `override: true`。
- 新增禁用过滤：接受 `disabledAgents: string[]`，加载后从注册表剔除这些 name。
- 引擎 `getAgentDefinitions(cwd)` 的缓存 key 要带上 `disabledAgents` 指纹，设置变更后缓存失效、重载。

### Agent 工具 `agent_type` 描述
在生成工具定义时，把当前注册表（已过滤禁用）的角色名拼进 `agent_type` 的描述（如 `Available: researcher, explorer, ...`）。保持 `type: "string"`，用描述列举即可（避免 schema enum 在无角色时为空数组的边角问题）。

## desktop 改动

### main: agents-service.ts（仿 skills-service.ts）
- `listAgents(cwd)` → `AgentSummary[]`：合并两源后的列表，每项含 name / description / model / maxTurns / tools / systemPrompt / source / override / filePath / disabled（disabled 由 settings.disabledAgents 推出）。
- `readAgentBody(filePath)`：读 md 正文。
- `saveAgent(def, { asOverride })`：序列化写到 `~/.code-shell/agents/<name>.md`（原子写：.tmp + rename，沿用项目惯例）。
- `deleteAgent(name)`：删用户级 `~/.code-shell/agents/<name>.md`。仅能删用户级/覆盖文件；内置项目文件不可删（UI 只给「禁用」）。
- 启用/禁用不在本 service：走现有 `updateSettings(scope, { disabledAgents })`。

### main: IPC handlers
`packages/desktop/src/main/index.ts` 注册 `agents:list` / `agents:readBody` / `agents:save` / `agents:delete`，校验入参，转调 agents-service。

### preload 桥
`packages/desktop/src/preload/index.ts` + `types.d.ts`：暴露 `listAgents` / `readAgentBody` / `saveAgent` / `deleteAgent`，加 `AgentSummary` 类型。

### renderer: AgentsSection.tsx
沿用三栏 customize 风格：
- 左栏：角色列表。内置 4 个带「内置」标；被用户覆盖的标「已覆盖」；用户自建的另列。每项一个**启用/禁用**勾选（写 `settings.disabledAgents`）。
- 右栏：选中角色的**全字段编辑表单**：
  - `name`（自建可改；内置不可改名）。
  - `description`（文本）。
  - `model`（下拉：settings.models[].key + 「跟随父模型」）。
  - `maxTurns`（数字）。
  - `tools`（多选勾选，候选来自 core 工具清单；不勾 = 继承父全集）。
  - system prompt（多行 textarea = md body）。
- 操作：内置编辑后「保存」→ 在用户级生成同名覆盖文件；自建直接存用户级。「新增子代理」按钮；「删除」（仅用户级/覆盖文件）。
- settings 读写沿用 `window.codeshell.getSettings/updateSettings`（参考 ModelSection）。

### renderer: SettingsPage.tsx
- `ModuleId` 加 `"agents"`。
- `MODULES` 加 `{ id: "agents", label: "子代理", Icon: <Bot 或类似> }`。
- render 分支 `active === "agents"` → `<AgentsSection activeRepoPath={...} />`。
- 若需要项目/用户 scope，按现有 `supportsProjectScope` 处理；本面板写用户级，scope 固定 user 即可。
- CSS 复用 customize 三栏样式。

## 数据流小结

```
用户在「设置 → 子代理」改 researcher 模型
  → AgentsSection 调 saveAgent(def, {asOverride:true})
  → main 写 ~/.code-shell/agents/researcher.md（覆盖文件）
  → 引擎下次 getAgentDefinitions 重新合并：用户级 researcher 覆盖项目级
  → resolveChildLlm 用新 model key 路由子代理模型

用户禁用 explorer
  → updateSettings(user, { disabledAgents: [..., "explorer"] })
  → 引擎缓存因 disabledAgents 指纹变化而失效
  → 注册表加载后剔除 explorer
  → Agent 工具 agent_type 描述里的 Available 不再含 explorer，LLM 看不到
```

## 错误处理

- 坏的用户级 md 文件：沿用 registry 既有行为——跳过并收集 warning，不影响其他角色。UI 可显示 warnings（次要，可后续）。
- 保存时 name 冲突：自建 agent 的 name 若与现有用户级文件重名 → 提示覆盖确认（复用 ConfirmDialog）。
- 删除内置：UI 不提供（只禁用）。
- 未知/被禁 agent_type 被硬调：既有抛错兜底，不新增逻辑。

## 测试

core 单元测试（沿用 `packages/core/src/settings/manager.test.ts` 的惯例）覆盖：
1. 注册表合并：用户级同名覆盖项目级；非同名两者并存。
2. `override` / `source` 标记正确。
3. `disabledAgents` 过滤：被禁角色不出现在 `list()` / `get()`。
4. `serializeAgentDefinition` ↔ `parseAgentDefinition` 往返一致；省略可选字段时不写出。
5. 引擎缓存随 disabledAgents 变化失效（行为级，按现有测试风格择需）。

## 改动清单

- **core**
  - `settings/schema.ts`：+ `disabledAgents`
  - `agent/agent-definition.ts`：+ `serializeAgentDefinition`（及来源元信息处理）
  - `agent/agent-definition-registry.ts` / `engine/engine.ts`：用户级目录合并、来源标记、disabled 过滤、缓存指纹
  - 工具名清单导出（若缺）
  - `tool-system/builtin/agent.ts`：`agent_type` 描述动态列出可用角色
  - 对应单元测试
- **desktop/main**
  - `main/agents-service.ts`（新）
  - `main/index.ts`：IPC handlers
- **desktop/preload**
  - `preload/index.ts` + `types.d.ts`：4 个方法 + `AgentSummary`
- **desktop/renderer**
  - `settings/AgentsSection.tsx`（新）
  - `settings/SettingsPage.tsx`：注册「子代理」模块
  - 复用 customize CSS

## 非目标（YAGNI）

- 不做 agent 的项目级 scope 编辑（统一写用户级）。
- 不做 agent 的 GitHub/远程安装（与 skills 的安装能力对齐留待后续）。
- 不做 warnings 的精细 UI 呈现（坏文件静默跳过即可，后续可加）。
- 不引入 codex 风格的 agent 格式；沿用现有 md + frontmatter。
