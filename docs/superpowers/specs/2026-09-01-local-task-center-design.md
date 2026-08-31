# 本地任务中心 PRD / 设计稿

> 日期：2026-09-01
> 状态：设计完成，待按独立实施计划开发
> 前置：通知闭环 N1–N3 与可靠性批次 R1–R4 已完成
> 范围：仅本地桌面端；不含托管云与沙箱

## 1. 背景

CodeShell 已经有多套可以独立工作的任务系统：

- 原生 Session / Goal 与会话执行状态；
- `FileRunStore` 中的历史 Run；
- Cron 自动化及其实际执行 Session；
- Mimi long-task ledger；
- 子 Agent、后台 shell、视频等后台 job；
- Codex / Claude external runtime。

问题不是“没有任务能力”，而是每套能力有自己的入口、状态词、历史页和控制方式。用户很难回答三个最基本的问题：现在什么在跑、什么在等我、刚才的结果在哪里。

本阶段在通知必达地基之上增加一个统一的**本地读模型**。它只聚合和路由，不迁移、不替代各来源的权威存储。

## 2. 方案推演（brainstorming）

### 方案 A：把五套数据迁入一个新 TaskStore

优点是查询简单，缺点是要双写或迁移所有成熟 schema；一旦投影和来源分歧，还会出现两个“真相”。仓库已有严格校验导致旧数据清空的历史教训，因此否决。

### 方案 B：UI 每次临时查询所有来源

不新增持久数据，但启动后才能看见内存来源，跨重启的完成/等待状态难以稳定排序；每个 renderer 还会重复实现映射与去重，因此否决。

### 方案 C：持久读模型 + 启动对账（采用）

主进程订阅现有事件 seam，把各来源规范化到一个 bounded projection；应用启动和窗口重连时，再从权威存储重建/对账。读模型坏了可以删掉重建，不影响真实任务。

## 3. 产品目标

1. 一个页面看见“运行中、等待处理、失败、已完成”的本地工作。
2. 每条任务能打开其原始 Session、Mimi 委派或自动化详情。
3. 只展示来源真实支持的动作，并把动作路由回权威控制器。
4. 重启后不丢活跃项和最近终态；重复事件不生成重复卡片。
5. Mimi 使用同一读模型回答“有哪些任务”“哪些需要我处理”。

### 非目标

- 不合并或迁移 Session、Run、Cron、long-task 等存储。
- 不提供云同步、远程队列、多人分配或团队 RBAC。
- 不把历史 `FileRunStore` 伪装成可取消的 live RunManager。
- 不在本阶段重做聊天、自动化详情页或 Mimi 世界 UI。
- 不以桌面通知作为任务状态真相。

## 4. 用户故事

- 我打开任务中心，先看到所有等待审批/输入的任务，再看到运行中的任务。
- 我点击一条任务，可以回到其原聊天或来源详情，而不是只看到一段摘要。
- Mimi 委派被保守标为 `interrupted` 时，我能选择“验证/继续”或“重试”。
- 应用崩溃重启后，已结束任务不会重新变成运行中，同一完成事件不会出现两张卡。
- 某来源当前不支持取消时，UI 明确显示“仅查看”，不发送假操作。

## 5. 信息架构与交互

任务中心作为全屏页面注册到 `PageRegistry`，不挤占聊天右侧 Panel。

默认视图按优先级分四组：

1. **等待处理**：审批、AskUser、paused/interrupted/blocked；
2. **运行中**：queued/running/finalizing；
3. **失败**：failed 及需要验证的保守终态；
4. **已完成**：completed/cancelled，默认只保留最近记录。

卡片显示：标题、来源、项目/工作区、状态、最近更新时间、结果摘要、可用动作。支持按来源、项目、状态筛选和标题搜索。

打开行为按优先级：`sessionId` → 原 Session；Mimi long task → Mimi 详情并选中任务；automation → 自动化详情；legacy run → Runs 详情。

## 6. 统一读模型

```ts
type TaskSource =
  | "session"
  | "legacy-run"
  | "automation"
  | "mimi-delegation"
  | "subagent"
  | "background-shell"
  | "background-job"
  | "external-runtime";

type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

interface TaskInboxRecordV1 {
  schemaVersion: 1;
  taskKey: string;              // `${source}:${authoritativeId[:attempt]}`
  source: TaskSource;
  sourceId: string;
  attempt?: number;
  title: string;
  status: TaskStatus;
  sessionId?: string;
  parentSessionId?: string;
  automationId?: string;
  projectId?: string;
  workspacePath?: string;
  summary?: string;
  error?: string;
  artifacts: Array<{ kind: string; label: string; uri: string }>;
  capabilities: Array<"open" | "cancel" | "pause" | "resume" | "retry" | "verify">;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  sourceRevision?: string;
}
```

`capabilities` 是主进程根据当前权威来源计算出的快照，renderer 不自行猜测。所有写操作仍在执行时再次校验当前来源状态，避免旧卡片越权。

### 去重与关联

- `taskKey` 只由稳定来源 ID 和 attempt 组成；事件重放是 upsert，不 append。
- 自动化定义与每次执行分为“父定义”和“执行记录”；执行记录通过 `automationId` 关联，不能与 Session 重复显示成两个并列任务。
- Mimi long task 与其 agent Session 以 long task 为主卡，Session 作为关联目标；普通 Session 才单独显示。
- 子 Agent 使用 agentId/childSessionId 关联父 Session。
- 新 attempt 保留旧 attempt 终态，当前 attempt 成为默认卡。

## 7. 数据与生命周期

新目录：`packages/desktop/src/main/task-inbox/`。

- `task-inbox-types.ts`：schema、状态映射、能力计算；
- `task-inbox-store.ts`：`<userData>/task-inbox/v1.json`；
- `task-inbox-projector.ts`：事件摄入和权威快照对账；
- `task-inbox-actions.ts`：动作路由；
- `task-inbox-ipc.ts`：窗口绑定的只读查询与命令入口。

Store 使用 `mutateJsonFile` / `writeFileAtomic`，文件权限 `0600`。保留全部非终态 + 最近 2,000 条终态；永不驱逐活跃/等待项。文件损坏时隔离 `.corrupt` 并从来源重建，不能覆盖无法解析的原文件。

启动过程：

1. 读 projection，立即提供上次可见状态；
2. 扫描 Session、long-task ledger、Cron、legacy RunStore；
3. 接入 live registry / external runtime 快照；
4. 以 `sourceRevision`/更新时间对账，权威终态覆盖陈旧活跃状态；
5. 广播单个 versioned snapshot。

事件订阅包括：`onTaskClosed` 与 long-task changed、`agentNotificationBus`、Cron `onJobEvent`、Session lifecycle、后台 registry、external runtime service。事件只是加速器，启动扫描才是完整性兜底。

## 8. 动作能力矩阵

| 来源 | 打开 | 取消 | 暂停/继续 | 重试/验证 |
| --- | --- | --- | --- | --- |
| 原生 Session | 原聊天 | live worker 可用时 | 由 Session/Goal 能力决定 | 新 turn 或 Goal resume |
| legacy Run | Runs 详情 | 不支持（只读历史） | 不支持 | 仅有真实 RunManager 时才开放 |
| 自动化定义 | 自动化详情 | 暂停 schedule，不等同取消执行 | pause/resume schedule | run-now |
| Mimi 委派 | Mimi 任务详情/原 Session | coordinator cancel | coordinator pause/resume | retry；interrupted 支持 verify/resume |
| 子 Agent | child/parent Session | AgentCancel 可达时 | resume 仅终态且持久子 Session 可用时 | AgentSendInput/重启 attempt |
| 后台 shell/job | 原 Session | registry/manager 支持时 | 来源支持时 | 默认不支持 |
| external runtime | 原 Session/外部 transcript | live service 可达时 | 不支持伪恢复 | 新 turn |

删除历史不属于首版主动作；现有 Runs 删除能力保留在 Runs 详情页。

## 9. IPC 与安全边界

- `taskInbox:list({status?, source?, projectId?, cursor?, limit?})`
- `taskInbox:get(taskKey)`
- `taskInbox:act({taskKey, action, expectedRevision})`
- `taskInbox:onChanged(version)` 后 renderer 重新拉取或接收 bounded snapshot。

所有输入做长度、枚举和路径校验。renderer 只能传 `taskKey + action`，不能传 cwd、sessionId 或任意命令。主进程从读模型解析权威 ID，再向来源控制器发命令。破坏性动作（取消、重试）复用现有确认交互。

## 10. 可观测性与失败语义

- projector 记录 `source`, `taskKey`, `eventKind`, `revision`，不记录 prompt/secret 全文。
- 对账失败不清空旧投影；卡片标 `stale` 并提供刷新。
- 一个来源失败不阻断其他来源；UI 显示局部错误。
- 动作返回结构化结果：`ok | stale | unavailable | rejected | failed`。
- 写投影失败不阻断真实任务，只记录错误并在下次对账恢复。

## 11. 验收标准

- 五类主要来源同时存在时只出现一个统一列表，关联的 Mimi/Session/automation 不重复成卡。
- 等待审批项固定排在运行项之前，状态变化无须重启页面。
- 杀掉应用再启动，活跃项被权威扫描恢复；已完成项不会回滚到 running。
- 同一完成事件重放 10 次只保留一个 `taskKey`。
- 每个操作都由来源二次校验；legacy Run 不显示取消。
- Mimi 查询任务时和任务中心列表使用同一 projector 结果。
- 2,000 条终态 + 多个活跃项下查询和筛选保持可用；活跃项永不被容量淘汰。

## 12. 发布策略

先以设置开关 `taskInboxV1` 灰度，只读列表先上线；动作路由逐来源启用。投影可随时删除重建，因此回滚只需隐藏入口并停止订阅，不触碰任何权威任务数据。
