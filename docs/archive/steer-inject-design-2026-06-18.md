# 步间 Steering 注入 —— 通用通道设计 (2026-06-18)

## 问题

用户在一个 user turn 跑到一半(AI 正在多步 LLM+工具循环)想补一句提示。现状只有两条路:
- **等整轮自然完成**(非 relay dequeue)→ 太晚。
- **引导接力 relay**(`stop({relay:true})`)→ abort 当前 LLM run 立刻重发 → **打断**,丢掉进行中那一步。

缺 CC 的 Enter-排队语义:**不打断,在 turn-loop 的步与步之间(工具边界)把消息拼进下一步的 LLM 请求**。

> 注:LLM 请求一旦发出是单向流,无法"真·流内插入"。CC 的"中途注入"本质也是"在边界处把队列拼进下一次请求"。本设计做的就是这个边界注入,不是流内插入。

## 用户拍板的交互(两个入口并存)

| 入口 | 语义 | 实现 |
|---|---|---|
| **引导(默认)** | **不打断**,步间隙温和注入,AI 下一步看到 | **新:steer 通道** |
| **打断重发(点击强制)** | 立刻 abort + 合并重发 | **保留:现有 relay**(commit b6cd593b) |

## 设计:通用 steer 通道(「加入口,后续其他也能用」)

不是 UI 专用。做成 engine 的通用「往进行中的 run 注入 user 消息」入口,任何宿主路径(UI 引导 / 未来的 agent 协调 / 外部触发)都能用。**但只重建有真实消费者的最小机制**——不复活已删的 mailbox/agentCoordinator 死代码。

### 1. core 队列(engine 持有,按 sessionId)

- `Engine` 加 `private steerQueue = new Map<sessionId, string[]>()`(纯内存,关进程即忘,与会话 allow 集同模型 → 多 engine 互不干扰、可整块外移)。
- 公开方法 `enqueueSteer(sessionId: string, text: string): void` —— 追加一条待注入消息。
- 传给 `TurnLoop` 一个 `consumeSteer?: () => string[]`(取出并清空当前 session 的队列),镜像现有 `consumePendingCompactInfo` 的依赖注入风格。

### 2. turn-loop 步间消费点

`turn-loop.ts` while 循环顶部(第 393–408,`signal.aborted` 快速路径之后、`manageAsync` 之前):

```ts
// 步间 steering:把宿主在上一步执行期间排进来的用户消息拼进本步请求(不 abort)。
const steered = this.deps.consumeSteer?.() ?? [];
for (const text of steered) {
  const m = { role: "user" as const, content: text };
  messages.push(m);
  this.deps.transcript.push(m);   // 落 transcript,持久化+下次 resume 可见
  this.config.onStream?.({ type: "steer_injected", text }); // UI 标记"已注入"
}
```

落点理由:这里已是 user-role push 的成熟位置(turnStartInjection、turn-limit warning 都在此 push)。在 `manageAsync` 之前 push,保证注入内容参与本步的上下文管理与计数。

### 3. IPC + preload 入口(通用 RPC,镜像 cancel)

- main:`agent/steer` IPC,转给 worker(同 `agent/cancel` 的转发路径,agent-bridge)。worker → `engine.enqueueSteer(sid, text)`。
- preload:`window.codeshell.steer(sessionId, text): Promise<void>`。
- 不打断:与 `cancel` 并列的独立 RPC,**不**触发 abort。

### 4. renderer 接入

- **引导**`guideActiveQueuedInput` 改:不再 `stop({relay:true})`,而是 `steer(sid, mergedQueue)` —— busy 保持 true(不打断),消息排进 engine 步间队列,清空本地 queue + relay 标记。
- **打断重发**:保留一个显式入口走老的 `stop({relay:true})`(强制 abort)。
- 排队输入两态:`待注入`(引导,run 在跑、将在下一步插入)vs `将打断重发`(强制)。
- `steer_injected` stream 事件 → 把该条从"待注入"标记成"已注入"。

## 与既有机制共存

- **abort/relay**:steer 不碰 signal,纯加消息;relay 仍独立 abort。两入口并行不冲突。
- **goal mode**:goal 的 stop-hook 在 turn 末判定;steer 在 turn 顶注入,只是多喂一条 user 消息,不影响 goal 判定循环。
- **maxTurns**:注入不额外加 turn(在现有 turn 顶部拼消息)。
- **resume**:消息已 push 进 transcript → 落盘,resume 后可见(与普通消息一致)。
- **空闲态**:若 run 已结束(busy=false)再 steer,队列没有消费者——renderer 此时本就走正常 send,不该调 steer;core 侧 enqueue 到无活跃 run 的 session 是 no-op 风险 → 文档约定 steer 仅在 busy 时调,core 不为"无人消费"兜底(队列下次该 session 起 run 时会被消费,可接受)。

## 不做 / 边界

- 不复活 mailbox/agentCoordinator 死代码([[project_goal_maxturns_and_mailbox]])。只做有真实消费者的最小队列。
- 不做"真·流内插入"(LLM API 不支持)。
- sub-agent 是否可被 steer:本期只接 UI→主 run;sub-agent 的 sessionId 不暴露给 UI,天然不涉及。

## 改动清单

1. core `engine.ts`:steerQueue + enqueueSteer + 传 consumeSteer 给 TurnLoop。
2. core `turn-loop.ts`:deps 加 consumeSteer;while 顶部消费 + push + transcript + steer_injected 事件。
3. core stream 事件类型加 `steer_injected`。
4. main `index.ts`/agent-bridge:`agent/steer` IPC 转发。
5. preload `index.ts` + `types.d.ts`:`steer(sid, text)`。
6. renderer `App.tsx`:guide 改走 steer;保留 relay 强制入口;排队两态 + steer_injected 处理。
7. 测试:turn-loop 步间消费单测(队列有消息→下一步 messages 含它、不 abort);engine enqueueSteer 单测。

## 验证

- core build + turn-loop/engine 测试。
- desktop tsc + build。
- **真机冒烟**(必须):长任务(多工具步)中途引导一句 → 不打断、AI 下一步看到、内容不折叠;强制打断入口仍 abort 重发。
