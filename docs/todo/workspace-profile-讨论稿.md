# WorkspaceProfile（数字人 / 工作间画像）— 讨论稿 v0.5

> 状态：**历史讨论稿**。WorkspaceProfile MVP、数字人库、会话绑定、
> Pet 团队与三层记忆注入已经落地；当前实现与安全边界以
> [`docs/architecture/14-digital-human-and-pet.md`](../architecture/14-digital-human-and-pet.md)
> 为准。本文保留早期产品推导，未完成的后续阶段以根 `TODO.md` 为准。
> 日期：2026-06-09 ｜ 范围：MVP（单 workspace 同一时刻绑一个 Profile，可切换、可开关、本地可安装）
> v0.2 变更：Profile 升格为「数字人」——新增可切换、经验三层、向下降级为 plugin 三个维度。
> v0.4 变更：**marketplace 暂不纳入 MVP**。先聚焦本地数字人闭环：本地安装/激活/切换/主指令/经验/Team Board。
> v0.5 变更：**MVP 只做全局 Profile 库**。项目定制不通过 workspace profile 完成，而通过现有 `CLAUDE.md` / 项目指令叠加。

---

## 0. 一句话

**组装一个 Profile = 组装一个数字人。** 给 workspace 装上一个 Profile，进去就是一个**有专业人设、自带工作流、自带能力（plugin/skill/tool/子代理团队）、自带可移植经验**的数字同事；workspace 内可按工作阶段**切换**当前数字人（写PRD → UI设计 → 写代码），同一时刻专注一个活；开了就上线，关了就消失。MVP 先做**本地安装 / 本地切换 / 本地团队面板**，发布到 marketplace 与远程分发后置。

代号取自用户原话：「preset 为 plugin 的超集」「组装一个 profile 就是组装一个数字人」「workspace 里可以切换 profile，同一时间绑定干一个活」「在 codeshell 当 profile，也能降级为 plugin」。

---

## 1. 名词对齐（避免撞车）

codeshell 里 `preset` 一词**已被占用**，含义比用户想的窄，必须区分：

| 名词                               | 已存在？                               | 含义                                                                                                                                         | 谁拥有               |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `AgentPreset`（现有）              | ✅ `packages/core/src/preset/index.ts` | **窄**：`promptSections` + `builtinTools` + 默认权限 + 是否注入 git。只到「agent 人格底色 + 内置工具集」。内置 `general` / `terminal-coding` | core                 |
| **`WorkspaceProfile`（本文主角）** | ✅ 已落地                              | **超集**：引用一个底层 `AgentPreset`，再叠加 plugins / skills / mcp / 子代理团队 / **主指令编排**，并绑定到 workspace、可开关、本地可安装    | core + Desktop + Pet |

设计原则：**Profile 引用 AgentPreset，不替换、不修改它。** 底层窄 preset 一行不动，迁移成本为零。

---

## 2. 目标（Goals）

1. **一个 workspace 同一时刻绑一个 Profile，且可切换**：进入 workspace（cwd）→ 当前 Profile 声明的能力自动注册、主指令自动注入。用户可在 workspace 内按阶段**切换**当前 Profile（写PRD → UI设计 → 写代码），切换后旧的下线、新的上线，**始终专注一个活**。
2. **可开关、可逆（preset 语义）**：开 = 整套上线；关/切走 = 整套从运行时消失（文件留在盘上，运行时看不见）。
3. **能力按 workspace 隔离**：workspace-A 的剧本 Profile 不污染 workspace-B 的 coding 环境。
4. **进门即生效的主流程**：Profile 能携带「主 agent 指令」（如 seedance 的「制片人按 导演→服化道→分镜 三阶段调度」），装上即成为该 workspace 的系统提示一部分。
5. **数字人 = 可移植经验**：Profile 自带一层**跟着它走**的经验（数字人方法论/审美/流程），横跨多个 workspace 复用；项目差异优先通过本地 `CLAUDE.md` / 项目指令叠加。详见 §5.5 经验三层模型与 §5.7 边界。
6. **本地可安装 / 可导入导出 / 未来可降级**：MVP 先把 Profile 做成本地可安装、可激活、可切换的数字人包；marketplace、远程发布、一键分发后置。导出为普通 plugin 的方向保留，但不阻塞本地体验闭环。详见 §5.6。

### 非目标（本期不做）

- ❌ **跨 workspace 的 team 协作**（一个总指挥调度多个 workspace、汇总结果）→ 列为 §7 future。
- ❌ 改动现有 `AgentPreset` 的语义或内置 preset。
- ❌ 同一 workspace **同时**激活多个 Profile（MVP：同一时刻一个，但**可切换**）。
- ❌ marketplace / 远程发布 / 公开分发（本期先不考虑，避免过早进入包管理、权限、版本、兼容性问题）。
- ❌ workspace 内独立 Profile 库 / 项目专属 Profile 定制（本期先不做；项目定制放进现有 `CLAUDE.md` / 项目指令）。

---

## 3. 效果（用户视角的体验）

**剧本 workspace：**

```
$ cd ~/projects/我的剧集 && code-shell
[Profile: seedance-分镜团队 已激活]
你> 把 ep01 剧本拆成 Seedance 提示词
AI（制片人）> 好，进入三阶段流程。先调 director 分析剧本…
            （director / art-designer / storyboard-artist 三个子代理 + 7 个 skill 全部可用，
             因为 Profile 装上时它们随之注册；主流程指令已注入系统提示）
```

**coding workspace：**

```
$ cd ~/code/codeshell && code-shell
[Profile: terminal-coding（默认）]
你> 修一下这个 bug
AI> （就是普通的改代码 terminal，没有剧本团队那套东西）
```

**同一个你**，在两个目录之间切，得到两套完全不同的「同事」。关掉 seedance Profile，剧本 workspace 立刻退回普通助手——文件还在，能力没了。

---

## 4. 现状盘点：零件已经在了

**好消息：MVP 的底座几乎全部存在，这是「装配 + 加一层」而非「从零造」。**

| 用户愿景的一块                        | codeshell 现状                                                                             | 证据                                                       | 缺口                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| workspace = 工作间                    | ✅ 一个 cwd 就是 workspace，有 `${cwd}/.code-shell/`                                       | `settings/manager.ts:85`                                   | —                                                        |
| **能力按 workspace 隔离**             | ✅ `CapabilityOverrides` 项目级三态 on/off/inherit，覆盖 skills/plugins/agents/mcp/builtin | `settings/schema.ts:8-30`、`capability-control/overlay.ts` | — 这是隔离底座                                           |
| agent 人格 + 内置工具                 | ✅ `AgentPreset`                                                                           | `preset/index.ts`                                          | 语义窄，需被引用而非扩展                                 |
| plugin = agents+skills+mcp+hooks+命令 | ✅ 完整 installer + marketplace + `disabledPlugins` 总开关                                 | `plugins/installer/*`、`loadPluginAgents.ts:12`            | 装不进「主指令」层                                       |
| 自定义 preset 可注册                  | ✅ `registerPreset()`                                                                      | `preset/index.ts:167`                                      | 只能注册窄 preset                                        |
| **超集 Profile**                      | ❌ 不存在                                                                                  | —                                                          | **本提案核心**                                           |
| Profile 本地安装/导入                 | ⚠️ plugin 能，Profile 不能                                                                 | `plugins/installer/*`                                      | MVP 先做全局 `~/.code-shell/profiles/`，不接 marketplace |
| 项目定制指令                          | ✅ 已有项目指令/`CLAUDE.md` 方向                                                           | `prompt/composer.ts`                                       | 与 Profile.mainInstruction 排序需明确                    |
| 跨 workspace team                     | ❌ 无 team / 无 cross-session                                                              | grep 无                                                    | future                                                   |

---

## 5. 设计草案

### 5.1 数据结构（草案，待评审）

```ts
// 新增 packages/core/src/profile/types.ts（示意，非最终）
interface WorkspaceProfile {
  name: string; // "ui-designer"
  label: string; // "UI 设计师"
  description: string;

  basePreset: AgentPresetName; // 引用现有窄 preset，如 "general"
  // —— 超集叠加的部分（= 可降级为 plugin 的部分）——
  plugins: string[]; // 装上即 force-enable 的 plugin 名（写进 capabilityOverrides.plugins = "on"）
  skills?: string[]; // 额外 force-enable 的 skill
  mcp?: string[]; // 额外 force-enable 的 mcp server
  agents?: string[]; // 额外 force-enable 的子代理 role
  // —— 数字人层（codeshell 专属，降级为 plugin 时丢弃）——
  mainInstruction?: string; // 注入为该 workspace 系统提示的一段（承载「制片人三阶段调度」），见 §5.3
  portableMemory?: boolean; // 是否拥有可移植经验层 profiles/<name>/memory，见 §5.5
  // —— 本地包元信息（远程发布后置）——
  version?: string;
  source?: string; // local / git；marketplace 后置
}
```

> **降级线**：上半部分（basePreset 之外的 plugins/skills/mcp/agents）是与 plugin 同构的，导出为 plugin 时原样保留；下半部分（mainInstruction / portableMemory）是数字人专属，降级时丢弃。见 §5.6。

### 5.2 激活机制（复用现有底座）

Profile **不发明新隔离机制**，它是 `CapabilityOverrides` 的「批量写入器」：

```
激活 Profile
  └─ 把 profile.plugins → 写入 ${cwd}/.code-shell/settings.json
         capabilityOverrides.plugins[x] = "on"
  └─ skills/mcp/agents 同理写各自 bucket
  └─ basePreset → 写 agent.preset
  └─ mainInstruction → 注入系统提示（见 5.3）

关闭 Profile
  └─ 把这些 override 改回 "off" 或删除（回到 inherit）
  └─ 运行时下一轮/下个 session 重新扫描 → 能力消失
```

这样「开/关/可逆」**白送**——因为 `CapabilityOverrides` 本来就是三态、本来就项目级、本来就被 engine 折叠进运行时（`engine.ts:2605,2764`）。

### 5.3 主指令注入（关键缺口，命中用户核心诉求）

现状：`PromptComposer`（`prompt/composer.ts`）按 `AgentPreset.promptSections` 拼系统提示，但**没有「workspace 级自定义主指令」的注入点**。需要新增：

- 让 composer 读取 active Profile 的 `mainInstruction`，作为一段追加到系统提示。
- 这一段就是 seedance 顶层 `CLAUDE.md` 里「制片人按三阶段调度三个子代理」的内容。
- 边界已决策：本地 `CLAUDE.md` 最高 > `Profile.mainInstruction` > `basePreset.promptSections`；具体拼接格式留 P2 评审。

### 5.4 切换（workspace 内换数字人）

同一 workspace 同一时刻只有一个 active Profile。切换 = 一次「关旧 + 开新」的事务：

```
切换 Profile  A → B
  └─ 撤销 A 写入的 capabilityOverrides（回 inherit/off）
  └─ 应用 B 的 capabilityOverrides（见 5.2）
  └─ active profile 记录写进 ${cwd}/.code-shell/settings.json（如 agent.activeProfile = "B"）
  └─ 下一轮 PromptComposer 换成 B 的 mainInstruction + B 的可移植经验层
```

体验：用户在「写PRD / UI设计 / 写代码」之间切，**始终专注一个活**。已有的配置热重载第二层（settingsBus→refreshRuntimeConfig）天然支撑「下一轮生效」。

### 5.5 经验三层模型（数字人的灵魂）

复用现有 `MemoryManager`（`session/memory.ts`）——它已支持「有 `projectDir` → 项目级；无 → 全局」。数字人只需**新增中间一层**：

```
① 全局经验    ~/.code-shell/memory              所有 workspace、所有数字人共享
② 数字人经验  profiles/<name>/memory   ★新增★   跟着 Profile 走，装到哪个 workspace 都在
③ 局部经验    projects/<hash>/memory            workspace × 数字人 的交集，只在这个 workspace 有
```

- 用户原话映射：「UI 设计师的通用方法论」→ ②；「某项目的设计规范/品牌色」→ ③。
- 注入顺序（待评审）：① 垫底 → ② 数字人 → ③ 局部 最具体，越具体越靠近当前任务。
- 实现：active Profile 若 `portableMemory`，则在原有 user/dream 两个 `MemoryManager` 之外，再挂一个 `baseDir = profiles/<name>` 的实例；dream 自动整理也按数字人分桶。
- **这层是「组装数字人」与「组装一包工具」的本质区别**：没有 ② 就只是 plugin；有了 ② 才是数字人。

### 5.6 本地安装 / 导入导出 / 降级（marketplace 后置）

MVP 不先做 marketplace。先把 Profile 做成**本地数字人包**：能放在本机、被 workspace 激活、被关闭/切换、可导入导出。远程发布、公开分发、一键安装后置。

保留**双向身份**方向（命中用户「在 codeshell 当 profile，也能降级为 plugin」），但不让它阻塞 P0-P3：

```
        ┌─────────────── WorkspaceProfile（codeshell 全功能）
        │   = plugin 同构层（agents/skills/mcp）
        │   + 数字人层（mainInstruction / 可移植经验）
        │
  导出 ─┤
        │
        └──降级──> 普通 plugin（codex 等也能吃）
              = 只保留 plugin 同构层，丢弃数字人层
```

- **MVP 安装路线**：先只做全局 Profile 库：`~/.code-shell/profiles/<name>/profile.json`。workspace 不保存 Profile 本体，只在 `${cwd}/.code-shell/settings.json` 里记录当前激活哪个 Profile。
- **未来安装路线**：Profile 仍可寄生于 plugin —— 一个 plugin 包里多放一个 `profile.json`，installer 识别后这个包**既可当普通 plugin 装、也可作为 Profile 激活**。这条路线保留到 P5。
- **降级**：导出时若目标是通用 plugin，剥掉 `profile.json` 的数字人字段即可，剩下的就是合法 plugin。向下兼容方向成立，但实现不进入本地 MVP 的关键路径。
- **反向领养**：一个纯 codex plugin 装进 codeshell，可被「领养」为一个最简 Profile（basePreset=general + 该 plugin），用户再往上加 mainInstruction / 经验把它养成数字人。

### 5.7 Profile 与项目指令的边界（v0.5 决策）

MVP 暂不做 `workspace/.code-shell/profiles/`，也不做“项目专属数字人配置”。项目定制内容放到现有 `CLAUDE.md` / 项目指令里，由它覆盖或约束当前激活的 Profile。

```
~/.code-shell/profiles/
  全局数字人库：这个数字人是谁、会什么、通用工作流是什么

workspace/CLAUDE.md
  项目本地约束：背景、路径、品牌规范、技术栈、交付格式、禁忌

workspace/.code-shell/settings.json
  只记录：当前激活哪个 Profile，以及 Profile 写入的 capabilityOverrides
```

一句话边界：**Profile 管数字人，`CLAUDE.md` 管项目。**

示例：

- `UI 设计师 Profile`：你是产品 UI 设计师，按信息架构 → 交互状态 → 视觉规格工作。
- 项目 `CLAUDE.md`：本项目品牌色是 `#0B57D0`，优先使用 Radix UI，页面要适配 B 端密集信息场景。

优先级沿用已决策顺序：本地 `CLAUDE.md` 最高 > `Profile.mainInstruction` > `basePreset.promptSections`。

---

## 6. 实施路径（MVP，分阶段）

> 每阶段独立可验证；遵循本仓库 TDD + rebuild core 约定。

- **P3（先行，验证体验）— seedance 手动落地**：把微信里的 seedance 包整理成全局 `~/.code-shell/profiles/seedance/` 下的 Profile，在单独试验 workspace 里用现有 `capabilityOverrides` **手写**激活，端到端跑通「装上→三个子代理+7 skill 可用→三阶段流程进门即生效→关掉→消失」。**先让用户亲眼看到效果，再固化抽象。**【用户已选：从 seedance 入手】
- **P0 — 定义层**：`WorkspaceProfile` 类型 + schema + 把 seedance 写成第一个 `profile.json`。
- **P1 — 激活/切换/关闭**：Profile → `CapabilityOverrides` 批量写入器（§5.2）；`activeProfile` 记录 + 切换事务（§5.4）。**复用现有隔离，不造新机制。**
- **P2 — 主指令注入**：`PromptComposer` 新增 active-Profile `mainInstruction` 注入点（§5.3），优先级低于本地 CLAUDE.md。核心「真·新功能」。
- **P2.5 — 经验三层**：给 `MemoryManager` 挂第二个 `baseDir = profiles/<name>` 实例（§5.5）；dream 按数字人分桶。
- **P3.5 — Team Board v1**：本地管理多个「cwd × Profile」工位，人当总指挥（§6.5）。先做总览与进入工位，不做跨 session 派活。
- **P4 — 本地导入/导出/降级准备**：Profile 本地包导入导出；保留导出为纯 plugin 的数据边界，但不接 marketplace。
- **P5 — marketplace / 远程发布 / 一键安装**：等本地数字人体验跑通后再做。此阶段才处理远程包管理、权限、版本、兼容性与公开分发。

**风险/待定清单：**

- ⚠️ **三个指令源的合并细节**：优先级已决策为本地 CLAUDE.md > Profile.mainInstruction > basePreset.promptSections；P2 还需评审具体拼接格式、冲突提示与可观测性。
- ⚠️ **经验三层的注入顺序与去重**（§5.5）：① 全局 / ② 数字人 / ③ 局部 同名 memory 如何覆盖？dream 整理时三层是否互相污染？
- ⚠️ **切换事务的原子性**：切到一半失败，capabilityOverrides 不能停在半改状态。
- ⚠️ 热生效粒度：现状「下一轮/下个 session」，非「当句即变」（配置热重载第二层固有行为）。需向用户明确预期。
- ⚠️ 分发顺序：marketplace 后置，避免过早把产品重心拖进包管理/权限/版本；P0-P3 只验证“数字人是否真的有用”。
- ⚠️ 项目定制边界：MVP 不支持 workspace profile 定制；如果用户想给某项目加品牌、路径、技术栈、交付格式，统一写进 `CLAUDE.md` / 项目指令。

---

## 6.1 产品化方向（P3 之后再逐步做）

核心判断：后续产品 idea 不应围绕“更强的 preset”，而应围绕**个人 AI 工作室里的数字同事系统**。用户要感知到的不是“我开了一包工具”，而是“我请来了一个特定同事，他有工作流、有经验、能在工位里开工”。

### Profile Builder（组装数字人）

把 `profile.json` 从工程配置变成可操作的创建流程：

- 选底层人格：coding / general / research / design。
- 选能力：plugins / skills / MCP / agents。
- 写主流程：这个数字人怎么工作，何时调用哪些子代理。
- 配经验层：是否启用可移植记忆，哪些经验跟着数字人走。
- 预览影响：激活后会开启哪些能力、注入哪些主指令、影响哪个 workspace。

### Profile Switcher（切换数字人）

切换不只是改 setting，而是一个用户能理解的状态变化：

```
当前工位：剧本间
当前数字人：Seedance 分镜制片人
已启用：3 agents / 7 skills / 2 MCP / portable memory on
```

切换时展示“将关闭哪些能力、开启哪些能力、主指令会变成什么”。这样 Profile 不会像黑盒，用户能理解为什么切走后能力会消失。

### Memory Studio（经验三层可见化）

把经验三层做成数字人的核心护城河：

- 全局经验：我这个人的长期偏好。
- 数字人经验：这个 UI 设计师的审美、方法论、检查清单。
- 项目经验：这个项目的品牌色、组件规范、业务背景。

关键交互：允许用户把项目经验“提升”为数字人经验。例如「这条设计规范以后所有 UI 设计师工位都要记住」。这会让用户感觉数字人在成长，而不是只读取文件。

### Team Board v1（人类总指挥）

Team Board 先只做本地总览，不做 agent 调 agent：

```
剧本工位     ~/story      Seedance 制片人      idle
设计工位     ~/design     UI 设计师            active
代码工位     ~/repo       Coding 工程师         idle
```

点一行就是“我去那个工位和那个数字人说话”。可以加一个轻量的 handoff note：把当前工位产出的摘要带到另一个工位，但不自动派活、不自动汇总。

### 样板数字人优先级

P3 seedance 跑通后，不建议马上抽象到很大；先再手动养 2-3 个数字人确认边界：

- `PRD 产品经理`：访谈材料 → PRD → 任务拆分。
- `UI 设计师`：需求 → 页面结构 → Figma/前端规格。
- `Repo 维护工程师`：issue → 代码修改 → 测试 → PR 描述。

Seedance + PRD + UI + Coding 基本覆盖“内容创作 / 产品设计 / 代码生产”三种工作形态，足够验证 WorkspaceProfile 的产品边界。

---

## 6.5 Team v1（人当总指挥）—— 纳入 MVP 范围

> 用户定义：「不同 workspace + profile 组成 team，我指挥」。关键是**总指挥是人，不是 agent**。
> 因此 Team v1 **不需要任何 cross-session / agent-调-agent 机制**，它几乎是 §6 的自然结果 + 一个总览面板。

### 模型

```
工位 = 一个 cwd  ×  它当前激活的 Profile(数字人)
Team = 一组工位
指挥 = 人在面板上切到某工位说话
```

### 两种粒度都支持（用户已选）

- **跨目录**：剧本间(~/剧集) / UI间(~/设计) / 代码间(~/repo) 各是独立目录的工位。复用现有 cwd=workspace，零新概念。
- **同目录多间**：同一产品项目里「写PRD / UI / 写代码」是同一 cwd 下可切换的不同数字人（即 §5.4 切换）。

### Team v1 vs Team v2（划清边界，避免混淆）

|                     | 总指挥    | 需要新造的东西                                    | 何时      |
| ------------------- | --------- | ------------------------------------------------- | --------- |
| **Team v1（本期）** | **人**    | 仅一个总览面板（成员 = 工位）；切换/激活复用 §5.x | **MVP**   |
| Team v2（future）   | **agent** | cross-session 通道、agent 调度 agent、结果汇总    | §7 future |

### 面板形态（用户选：「一个 Team 总览面板」）

- 列出 team 的成员工位：每行 = 工位名 + cwd + 当前数字人 + 状态。
- 点一行 → 跳进那个 workspace 对话（= 你去指挥那个数字人）。
- MVP **不做**「从面板直接派活而不进去」——那条接近 Team v2，留 future。
- 数据落地：team 定义（成员工位清单）存为一个轻量 json（全局或某目录），**不引入 cross-session 运行时**。

**风险/待定：**

- ⚠️ team 定义存哪（全局 `~/.code-shell/teams/` vs 某个根目录）。
- ⚠️ 「同目录多间」的多个工位若指向同一 cwd，settings 的 `activeProfile` 只有一份 —— 面板切工位 = 切该 cwd 的 activeProfile，需明确「同 cwd 工位之间是互斥切换」。

---

## 7. Future（本期明确不做）

- **marketplace / 远程发布 / 一键安装**——本期先不考虑。等本地数字人体验、Team Board、经验三层跑通后，再处理公开分发、权限、版本、兼容性与降级 plugin 的完整链路。
- **Team v2：agent 当总指挥**——一个总指挥 agent 调度多个 workspace（各自不同 Profile），自动分发任务、汇总结果。codeshell 现无 cross-session 通道（曾删过 mailbox，见记忆），这是从零造的大特性，单列后续讨论稿。
- 从 Team 面板「不进入即派活」（接近 v2）。
- 同一 workspace 同时激活多个 Profile（MVP 只「可切换」不「可并存」）。
- Profile 之间的依赖 / 继承。

---

## 8. 决策记录 & 仍待拍板

**已决策（截至 v0.5）：**

- ✅ 命名：新名词 `WorkspaceProfile`（数字人），引用而非修改现有窄 `AgentPreset`。
- ✅ MVP 顺序：**marketplace 暂不纳入 MVP**，先做本地数字人闭环（本地安装/激活/切换/主指令/经验/Team Board）。
- ✅ MVP Profile 存放：只做全局 Profile 库 `~/.code-shell/profiles/`；workspace 只记录当前激活哪个 Profile。
- ✅ 项目定制边界：项目定制不通过 workspace profile 完成，而通过现有 `CLAUDE.md` / 项目指令叠加；一句话：**Profile 管数字人，`CLAUDE.md` 管项目**。
- ✅ 未来分发方向：Profile 可寄生于 plugin，可降级为纯 plugin（§5.6），但进入 P5 再实现。
- ✅ 指令优先级：本地 `CLAUDE.md` 最高。
- ✅ 单 workspace 同一时刻一个 Profile（**可切换**，§5.4）。
- ✅ **Team v1（人当总指挥）纳入 MVP**（§6.5）：team = 一组「cwd×数字人」工位 + 一个总览面板；**跨目录 + 同目录多间两种粒度都要**。
- ✅ 总指挥是人；agent 当总指挥（Team v2）留 future。
- ✅ 先做 P3：从 seedance 手动落地验证体验。
- ✅ P3 试验田：**单独新建一个目录**，不进 codeshell 主仓库。

**仍待拍板：**

1. 名词终稿：`WorkspaceProfile` 在 API/UI 上叫 "Profile / 数字人"？还是 "Studio / Crew / 工作间"？「team」一词确定保留。
2. 经验三层（§5.5）注入顺序：是否同意「越具体越靠近任务：① 全局垫底 → ② 数字人 → ③ 局部」？
3. team 定义存哪（§6.5 风险）：全局 `~/.code-shell/teams/` 还是别处？
4. P3 验证完：直接进 P0 固化抽象，还是先多手动养几个数字人（UI/PRD/代码）确认边界？
