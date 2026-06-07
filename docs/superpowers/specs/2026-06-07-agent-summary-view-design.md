# Agent 结果汇总视图设计

> 2026-06-07 · desktop renderer · 三大功能第三项

## 背景

并行 fan-out 时一轮可能起多个子代理(Agent 工具支持并发 spawn)。现在每个子代理渲染成一张独立可折叠卡(`AgentMessageView`):名字/type/状态点/live 活动/工具数 + 展开看结果文本。**没有任何聚合**——5 个并行 agent = 5 张各自为政的卡,用户看不到"整体几个成/败、共花多久"。

数据已全在 `AgentMessage` 里:`name` / `agentType` / `done` / `error` / `startedAt`+`endedAt`(→ 耗时) / `toolCount` / `text`。所以这是**纯 renderer 活,不碰 core / 协议 / 数据模型**。

## 决策(已确认)

- **形态**:折叠汇总卡。一轮里 **≥2 个相邻 sibling agent** 时,在这组上方加一个汇总头;单 agent 不显(无意义)。
- **交互**:汇总头点击整组折叠/展开;每行 agent 显示 名字/type/状态点/耗时/工具数,点一行展开**复用现有 `AgentMessageView`** 看该 agent 结果。

## 范围(YAGNI)

**做**:
- 把**相邻 ≥2 个 agent 消息**折成一个 `AgentGroup`(派生项,不改 reducer 数据)。
- 汇总统计纯函数:总数 / 成功数 / 失败数 / 总工具数 / 总耗时(wall-clock = 最早 startedAt → 最晚 endedAt,体现并行而非求和)。
- `AgentGroupCard`:汇总头(✓X ✗Y · N tools · 耗时)+ 可折叠的成员列表,每员复用 `AgentMessageView`。

**不做**(留后):跨会话/跨轮聚合、独立面板 dock、汇总里再做富交互(排序/筛选)、对单 agent 也强行包卡。

## 架构:折叠 post-pass(不动现有两级 fold)

现有 `buildStreamItems` 是脆弱的两级折叠(memory 里有多条 stale-agent-card / reconcile 修复)。**不**往里塞第三级,改为在其**输出上做一个 post-pass**,隔离风险、可独立单测:

```
buildStreamItems(messages, {liveTurnActive})
  → reconcileStreamItems(...)
  → foldAgentGroups(items)        ← 新 post-pass
```

`foldAgentGroups(items: StreamItem[]): StreamItem[]`:
- 线性扫描;遇到连续 ≥2 个 `kind:"agent"` 的项 → 包成 `AgentGroup { kind:"agent_group", id, agents: AgentMessage[] }`;<2 个原样保留。
- **递归**:agent 也可能落在 `turn_process_group.items` 里(turn 卡 span 到最后一个 tool,中间的 agent 被纳入)。所以对 `turn_process_group` 的 `items` 也跑一遍 `foldAgentGroups`,把其内部的 agent 组也折起来。`tool_group` 内不会有 agent(agent 非 toolish),不必递归。

### reconcile / 稳定性

- `AgentGroup.id` 用首个成员的 id(`ag-<firstAgentId>`),React key 稳定。
- live agent 每 50ms mutate(已知:streamGroups 的 hashItem 对 live agent 用递增 token 强制不复用)。post-pass 在 reconcile **之后** 跑,直接读最新 AgentMessage 引用,不缓存——所以 live agent 的状态/耗时/工具数会随重建自然更新,不会冻结。汇总头的数字由成员实时算,天然跟随。

### 纯函数(可单测,DOM-free)

```ts
// messages/agentGroup.ts
interface AgentGroupStats {
  total: number; succeeded: number; failed: number; running: number;
  toolTotal: number; wallMs: number;   // 最早 start → 最晚 end;有未完成→0(用 live ticker)
}
function summarizeAgentGroup(agents: AgentMessage[]): AgentGroupStats
function foldAgentGroups(items: StreamItem[]): StreamItem[]   // 上面的扫描+递归
```

## UI(AgentGroupCard)

```
┌────────────────────────────────────────────┐
│ ▸  3 个子代理  ✓2 ✗1 · 12 tools · 8.4s       │   ← 汇总头,点击折叠/展开
├────────────────────────────────────────────┤   （展开后）
│   ● explorer    读取 schema…    4 tools 3.1s │   ← 每行 = AgentMessageView
│   ● reviewer    完成           5 tools 2.0s  │
│   ✗ tester      失败: timeout  3 tools 1.2s  │
└────────────────────────────────────────────┘
```

- 折叠默认态:若该组**有 running 成员 → 默认展开**(用户在看进度);全 done → 默认折叠(收敛噪声)。
- 状态点颜色复用现有 StatusDot(running/ok/err)。
- 耗时用 wall-clock(并行语义);有 running 成员时汇总头显示 live ticker 或"运行中",不显死数字。
- 成员行直接渲染现有 `AgentMessageView`(它本身已是可折叠卡),汇总卡只做外层分组容器,**不重写单 agent 卡**。

## 测试 / 验收

- **单测** `agentGroup.test.ts`:
  - `summarizeAgentGroup`:全成/有败/有 running 的 count;toolTotal 求和;wallMs = max(end)-min(start),有 running→0。
  - `foldAgentGroups`:2+ 相邻 agent → 1 个 agent_group;单 agent 不折;非 agent 打断分组;**递归**进 turn_process_group.items 折其中的 agent 组;空/无 agent 输入原样返回。
- **渲染 smoke**(renderToStaticMarkup):agent_group 渲染汇总头数字 + 成员名;单 agent 不出现汇总头。
- **回归**:现有 MessageStream / streamGroups 测试全绿;tsc + build:renderer。
- **手动 smoke(需人盯)**:真起 2+ 并行子代理,看汇总头数字对、运行中默认展开、点行展开结果、全完成后折叠收敛。

## 影响文件

- 新增:`messages/agentGroup.ts`(纯函数)+ `.test.ts`;`messages/AgentGroupCard.tsx` + 渲染 smoke。
- 改:`MessageStream.tsx`(items pipeline 末尾加 foldAgentGroups + 顶层渲染 agent_group → AgentGroupCard);`TurnProcessGroupCard.tsx`(其 items.map 的 kind switch 加 `agent_group` 分支——turn 卡内部的 agent 组也要能渲染);`reconcileStreamItems` 让 post-pass 在 reconcile 后跑以避开它(无需改)。
- AgentGroup 类型放 `agentGroup.ts` 并由 streamGroups 的 StreamItem 联合纳入(StreamItem 加 `| AgentGroup`)。
- core / 协议 / 数据模型:**不改**。
