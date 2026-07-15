# WorkspaceProfile（数字人）第一步 — 设计稿

> 日期：2026-07-15 ｜ 状态：已评审待实现
> 前置讨论：`docs/todo/workspace-profile-讨论稿.md`（v0.5）；本稿是其 MVP 第一步在 **10 包新架构**（core 去领域化 + extension 缝 + identity/dataRoot）下的落地设计。
> 范围拍板（用户已确认）：P0 定义 + P1 激活/切换 + P2 主指令注入 + P2.5 记忆三层 + 最小 desktop UI，一条实现计划完成；Team 面板不做（并入 Pet 后续）；MVP 单激活可切换 + **预留 session 级绑定缝**。

---

## 1. 一句话

给 workspace 装上一个 **WorkspaceProfile（数字人）**：带专业人设（主指令）、自带能力（plugins/skills/mcp/agents 批量 force-enable）、自带可移植经验（数字人记忆层）；激活即生效、关闭即消失、workspace 内可切换；同一时刻一个（解析层预留 per-session 绑定，后续与 Pet 缝合实现多数字人同 workspace 并行）。

## 2. 归属定位

**core 内的 harness 元机制**，新增 `packages/core/src/profile/`。

- 它与 plugins / presets / capability-control 同类（管理"哪些能力开着 + 注入什么指令 + 挂哪层记忆"），不是 pet 那种产品域，**不**新开包、**不**走 `CapabilityModule` 缝。
- 命名：类型名 `WorkspaceProfile`，UI 名"数字人"。与 pet 的 `RunBehaviorProfile`（行为剖面）、settings 的 `agent.userProfile`（用户画像）无冲突。
- 公共 API 经 core `index.ts` 导出；**同步更新导出契约测试**（`index.exports.test.ts`）。

```
packages/core/src/profile/
  types.ts        WorkspaceProfile zod schema + 类型
  store.ts        全局库读写 ~/.code-shell/profiles/<name>/profile.json
  activation.ts   激活/切换/关闭事务（写项目 settings 的 profile 子树）
  resolve.ts      resolveActiveProfile（session 级缝在此预留）
  memory.ts       数字人记忆层挂载辅助
  index.ts        模块出口
```

## 3. 数据结构

### 3.1 profile.json（全局库，`~/.code-shell/profiles/<name>/profile.json`）

```ts
interface WorkspaceProfile {
  name: string;              // 目录名一致，机器标识
  label: string;             // UI 显示名
  description?: string;
  basePreset: string;        // 引用现有窄 AgentPreset（如 "general"），不修改它
  plugins?: string[];        // 激活时 force-enable
  skills?: string[];
  mcp?: string[];
  agents?: string[];
  mainInstruction?: string;  // 注入系统提示的数字人主指令
  portableMemory?: boolean;  // 是否启用数字人记忆层 profiles/<name>/memory
  version?: string;
}
```

- 库路径经 `codeShellHome()` 解析 → identity dataRoot（`identities/<id>`）下 per-user worker **天然获得独立库**，零额外工作。
- core 不内置任何领域 profile；样例（seedance 形态）放 docs。

### 3.2 项目 settings：单一 profile 子树（原子性方案）

```jsonc
// ${cwd}/.code-shell/settings.json
{
  "profile": {                    // 整个子树由激活事务全量重写；关闭 = 删子树
    "active": "seedance",
    "preset": "general",          // = profile.basePreset 的快照
    "overrides": { "plugins": { "seedance-pack": "on" } }   // 由 profile 声明展开
  },
  "capabilityOverrides": { ... }  // 用户手写，profile 永不触碰
}
```

- **切换 A→B = 原子替换整个 `profile` 子树** + settings 原子写（tmp+rename）。没有半改状态；用户手写 override 与 profile 写入的完全分离，关闭时精确回滚（删子树即可）。
- `mainInstruction` **不落 settings**：settings 只记 `active` 名字，composer 时从库活读（讨论稿 v0.5 决策）。库文件事后被改 → 重新激活即刷新 overrides 快照；文档注明此语义。
- 生效粒度沿用现状：settingsBus 热重载，下一轮/下个 session 生效。

### 3.3 优先级（已决策）

- 能力：用户 `capabilityOverrides` > `profile.overrides` > 全局基线。**用户手动永远赢过数字人**。
- preset：`agent.preset`（用户显式）> `profile.preset` > capability 默认。
- 指令：本地 `CLAUDE.md`/项目指令 > `profile.mainInstruction` > `basePreset.promptSections`。

## 4. 解析层（session 级缝，本期只留口子）

```ts
// resolve.ts
function resolveActiveProfile(input: {
  sessionProfile?: string;   // 本期恒为 undefined；后续 RunParams 可带（同 pet 的 behaviorMode 模式）
  cwd: string;               // 读 ${cwd}/.code-shell/settings.json 的 profile.active
}): WorkspaceProfile | undefined
// 语义：sessionProfile ?? workspace 默认；查无此 profile（库里被删）→ 返回 undefined 并告警，运行时按未激活处理。
```

后续第二阶段（与 Pet 缝合，不在本期）：Mimi 派活时指定"workspace × 数字人"，session 级绑定落地 → 多数字人同 workspace 并行、人/Mimi 当总指挥。

**分工界线**：`profile.overrides` 的能力折叠读 settings 里的持久化快照（§3.2 设计使然，worker 折叠 settings 时无需库在场）；而"当前激活的是谁 + 它的活字段（mainInstruction / 记忆目录）"必须经 `resolveActiveProfile` 取得，**禁止**其他代码自行读 `profile.active` 拼路径——这样后续加 session 维度时只改解析函数一处。

## 5. 引擎折叠与主指令注入

- **能力折叠**：engine 现有折叠 `capabilityOverrides` 处，加一层 `profile.overrides`（按 §3.3 优先级夹在全局基线与用户 override 之间）。
- **composer**：`PromptComposerOptions` 新增 `profileMainInstruction?: string`；engine 构建 composer（`engine.ts:1911` 附近）时经 `resolveActiveProfile` 解析并传入。作为独立 section 排在 preset promptSections 之后、项目指令（CLAUDE.md）之前——越靠后越具体越优先，自然实现 §3.3 指令优先级。

## 6. 记忆三层（本期含）

现有 `MemoryManager.buildInjectionIndex` 合并 global + project 两层；扩展支持第三层：

```
① 全局   ~/.code-shell/memory                 （现有）
② 数字人 ~/.code-shell/profiles/<name>/memory （新增，portableMemory=true 时挂载）
③ 局部   projects/<hash>/memory               （现有）
```

- 注入顺序（已决策）：**① → ② → ③**，越具体越靠后。
- 实现：`buildInjectionIndex` 增可选 `profileDir`；复用 `MemoryManager` 已有 `baseDir` 支持。
- 本期只做**注入 + MemoryRead 可读**；MemoryWrite 默认仍写现有层。"项目经验提升为数字人经验"、dream 按数字人分桶 → 后续阶段。**明确不做记忆自动反哺/自改 skill（守"非自进化"边界）**。

## 7. 最小 desktop UI（复用现有通道）

- **settings 页新增"数字人"区块**（与 Capabilities 区块并列）：列全局库 profile、显示当前激活、激活/切换/关闭。写入走现有 settings-patch IPC（`main/index.ts:3302` 通道加认 `profile` 子树）；列库加一个小 IPC（main 读全局库目录）。
- **TopBar** workspace 指示器旁显示激活数字人 label，点击跳 settings 区块。
- 遵循 desktop CLAUDE.md：shadcn/ui + Tailwind，`bun run typecheck` + `build` 在 packages/desktop 单独跑。
- Profile Builder / Memory Studio / Team 面板：后置。

## 8. 测试

- profile schema 校验（非法 name/缺字段/未知 preset 引用）。
- store：list/read/write、库不存在、identity dataRoot 下路径解析。
- 激活事务：激活→settings 子树正确；切换→原子替换；关闭→子树删除；用户 override 优先于 profile.overrides；`agent.preset` 优先于 `profile.preset`。
- resolveActiveProfile：workspace 默认、sessionProfile 口子、库中缺失时的降级。
- composer：mainInstruction section 存在性与排序（preset 之后、instructions 之前）。
- 记忆：三层注入顺序、portableMemory=false 不挂载。
- engine 折叠集成测试；desktop 区块 smoke；**导出契约测试更新**。

## 9. 实施顺序

types/schema → store → settings schema（profile 子树）+ 激活事务 → resolve → engine 折叠 → composer 注入 → 记忆三层 → desktop IPC + settings 区块 + TopBar → 样例 profile 文档 → 全量回归（bun test + 双 typecheck + lint）。

## 10. 决策记录（本轮新增，接讨论稿 §8）

- ✅ 起步：直接 P0+P1+P2+P2.5+最小 UI 一条计划完成（不先做 P3 手动样板）。
- ✅ 原子性：profile 专属 settings 子树 + 全量重写 + 原子写。
- ✅ 记忆注入顺序：全局 → 数字人 → 局部。
- ✅ Team v1 不做独立面板，并入 Pet（后续让 Pet 认识 Profile）。
- ✅ 多 profile 同 workspace：MVP 单激活可切换；解析层预留 session 级绑定缝；session 级绑定与 Pet 缝合时落地（同会话叠加多人设**永不做**）。
- ✅ 用户手写 capabilityOverrides 永远优先于 profile.overrides。
