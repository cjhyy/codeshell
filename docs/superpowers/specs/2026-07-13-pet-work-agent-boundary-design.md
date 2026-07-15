# Mimi / Work Agent 边界设计

> 状态：已接受
> 日期：2026-07-13
> 决策：用户可见的顶层 Agent 只有 Mimi 与 Work Session；Research、Review、Test 等能力是 Work Session 内部的临时角色，不是新的会话类型。协议和代码内部继续使用 `pet` 作为兼容类型名。

## 1. 为什么要这样分

Mimi 解决的是「我有哪些工作还没完成、哪些需要我决定、哪些值得继续优化」；Work Session 解决的是「在某个 Workspace 里读取上下文并执行工作」。两者生命周期、权限和界面目标不同，不能把 Mimi 当成当前聊天页上的浮层，也不能把每一种执行能力都暴露成一种会话。

如果把 Research / Review / Test 做成用户可见的顶层 Agent，会产生三个问题：

- 用户需要先理解内部编排方式，才能决定应该开什么会话。
- 同一项工作会散落为多个近似会话，Mimi 又退化成工作会话列表。
- 长上下文被不同角色的原始过程重复污染，难以知道最终结论和未完成项。

## 2. 产品模型

### 2.1 Mimi

Mimi 是跨 Workspace 的长期协调者，但不是代码执行器。

- 独立的 `pet` 主页面，与 `chat` 互斥渲染，不覆盖在 Session 页面上。
- 独立的 Mimi 对话历史，不计入普通工作会话列表。
- 页面只呈现工作树：未完成、待用户处理、可优化、最近完成。
- 桌面宠物是 Mimi 页的快捷入口和轻量提醒，不是第二份 Mimi 状态。
- Mimi 可以澄清、汇总和路由；需要读项目、改文件或运行命令时，自动选择 Workspace 并创建普通 Work Session。

### 2.2 Work Session

Work Session 是用户可进入、可恢复、绑定 Workspace 的执行单元。

- 持有项目上下文、权限、模型、工具执行记录和最终交付。
- 需要 Research / Review / Test 时，由 Core 在本次工作内部组装临时角色。
- 临时角色共享明确的任务边界，产出结构化结果后结束，不增加侧边栏会话。
- Work Session 向 Mimi 发布工作结论和后续项，不把完整逐 token 对话复制给 Mimi。

## 3. Core 编排边界

Core 应提供可组合的 Agent runtime，而不是硬编码多个产品人格。产品层只选择两个稳定入口：

```text
Mimi profile
  └─ clarify / summarize / route

Work profile
  ├─ optional Research role
  ├─ optional Review role
  ├─ optional Test role
  └─ workspace tools + permissions
```

Research / Review / Test 是运行期 role 或 capability：由任务需要触发，可以并行或串行，结束后只保留引用、发现、验证结果和未解决风险。它们不能拥有独立的用户可见会话生命周期。

## 4. Mimi 与 Work 的通信

当前自动派活可以保留兼容协议，但目标接口应是 Core/host 可验证的结构化工具调用：

```ts
interface DelegateWork {
  workspaceId: string | null;
  /** 只能取 host 为本轮提供的可复用 Session 闭集；省略表示新建。 */
  sessionId?: string;
  objective: string;
  contextRefs?: string[];
}

interface WorkReceipt {
  workId: string;
  sessionId: string;
  workspaceId: string | null;
  status: "running" | "needs_user" | "unfinished" | "optimization" | "completed";
  summary: string;
  nextActions: string[];
  evidenceRefs?: string[];
  updatedAt: number;
}
```

Host 每轮最多提供一个有界的可复用 Session 闭集，只包含能确定 Workspace、当前未运行且没有待处理决定的普通 Work Session。Mimi 只有在新目标明确延续同一工作线程时才选择其中一个；跨 Workspace、任意模型生成的 Session id 或已退出闭集的条目必须被 host 拒绝。

数据流：

```text
用户 → Mimi
  ├─ 可直接回答 → 留在 Mimi
  └─ 需要执行 → DelegateWork → 新建普通 Work Session
                                   ↓
                            执行 / 临时角色协作
                                   ↓
                              WorkReceipt
                                   ↓
                       Mimi 工作树增量更新与提醒
```

Mimi 的长期上下文主要由 WorkReceipt、用户偏好和仍有效的工作节点组成。原始工具日志和完整 Session transcript 留在 Work Session，需要追溯时通过引用按需读取。

## 5. 页面与导航约束

- `ViewMode` 必须包含正式的 `pet` 页面状态。
- Mimi 和 Chat 不能通过 `display: none` 互相覆盖；路由分支只挂载当前主页面。
- 点击侧边栏 Mimi 或桌面 Mimi 的「完整页面」进入 `pet`。
- 点击普通 Session 或新建对话进入 `chat`。
- Mimi 页面不显示当前 Session 的 lifecycle、任务、Goal 或右侧 Session 面板。
- Mimi 的投影、对话和提醒由页面与桌面宠物共享同一 Provider；页面是否打开不属于 Mimi 数据状态。

## 6. 长上下文原则

- 先结构化、再压缩：保留稳定事实、决策、未完成项、风险和证据引用。
- 工具结果大对象留在外部存储，Session/Mimi 上下文只保存摘要与引用。
- 压缩前做 checkpoint，压缩后仍能回答「做了什么、为什么这样做、还缺什么」。
- Mimi 只接收跨会话有价值的结论，不持续吞入每个 Work Session 的原始对话。

## 7. 非目标

- 不新增 Research Session、Review Session 或 Test Session 类型。
- 不让 Mimi 直接持有 Workspace 写权限。
- 不在 Mimi 页面重建一份普通工作会话列表。
- 本阶段不改完整的会话存储架构；先稳定页面、工作树和 Mimi/Work 边界。
