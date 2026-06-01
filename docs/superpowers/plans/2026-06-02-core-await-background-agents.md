# core 端:主 agent 等待后台子代理并自动续轮

> 日期：2026-06-02
> 状态：设计待确认
> 关联 bug：session `s-mpvf4rsj-bb6e4639` —— 后台子代理结果回来了，但主 agent 没有被唤醒去汇总。

## 问题

模型用 `run_in_background: true` 派生子代理时，`Engine.run` 的 turn loop 一结束就 resolve，
主 run 完成、busy 释放。子代理在后台继续跑，完成时只发了一个 `background_agent_completed`
stream event 给 UI，**没有任何机制把结果回灌主 agent 并发起新一轮**。

历史设计（agent-notifications.ts 注释）把"主 agent idle 时 drain 队列发 follow-up"
定为 **UI 的职责**，但 desktop 端从未实现 → 主 agent 永久卡死，结果烂在队列里。

## 决策（用户拍板）

1. **唤醒机制放 core，UI 只是 UI** —— core 闭环，desktop/TUI 行为一致。
2. **主 agent 一直等** —— 主 turn 结束后，若本 run 派生了仍在跑的后台子代理，
   就阻塞等待；**每完成一个，drain 一条结果、续一个 turn** 让主 agent 处理；
   直到没有在跑的后台 agent 且队列空，才真正 resolve。
3. 不做"等一会就 dead 再重唤醒"的混合方案（实现复杂、要处理 run 重启/会话恢复；
   而且阻塞等待几乎不增加内存——子代理 Engine 无论主 agent 等不等都已存在，
   等待只是 `await` 一个 Promise，不轮询不占 CPU）。

## 改动点

仅 `packages/core/src/engine/engine.ts`，在 `await turnLoop.run(messages)`（~1418）
之后、finalization（~1424）之前插入一个等待-续轮循环。**只在顶层 engine 生效**
（`this.config.isSubAgent !== true`）——子代理不等自己的孙代理（且嵌套 agent 已禁用）。

### 追踪"本 run 派生的后台 agent"

`notificationQueue` 已按 sessionId 分桶（enqueue 用 `ctx.sessionId`）。
判定"是否还要等"用：**该 session 是否还有 running 的后台 agent**。

`asyncAgentRegistry` 是进程全局、entry 不带 sessionId。两种实现：
- (A) 给 `AsyncAgentEntry` 加 `sessionId`，registry 加 `hasRunningForSession(sid)`。
- (B) `Engine.run` 本地记录本 run enqueue 过的 agentId 集合，配合队列判断。

选 **(A)**：更准（区分本会话 vs 其他会话的后台 agent），且 `runningCount` 的并发
上限本就是全局的，加 sessionId 不破坏现有语义。注入点：`agentTool` 的 background 分支
`asyncAgentRegistry.register({ ..., sessionId: ctx.sessionId })`。

### 等待-续轮循环（伪码）

```ts
// after: result = await turnLoop.run(messages)
const isTop = this.config.isSubAgent !== true;
const sid = session.state.sessionId;
while (isTop && !options?.signal?.aborted) {
  const pending = notificationQueue.drainAll(sid);          // 已完成、待处理
  if (pending.length === 0) {
    if (!asyncAgentRegistry.hasRunningForSession(sid)) break; // 没在跑也没待处理 → 收工
    await waitForNextCompletion(sid, options?.signal);        // 挂起等下一个完成/abort
    continue;
  }
  // 每完成一个唤醒一轮：注入 pending 里最早一条的结果，续一个 turn
  const item = pending[0];
  // 其余 pending 留到下一轮 drain（drainAll 已清空，需放回 or 改用单条 dequeue）
  requeueRest(pending.slice(1), sid);
  messages = [...result.messages, buildAgentResultMessage(item)];
  result = await turnLoop.run(messages);                      // turnCount 继续累加，受 maxTurns 约束
}
```

注：`drainAll` 是"取全部并清空"。"每完成一个唤醒一轮"需要单条出队，
故新增 `dequeueOne(sid)`（取最早一条），避免 drain 全部又放回的别扭。

### 注入消息形态

把子代理结果包成一条 user 角色的 `<system-reminder>` 消息（复用现有 wrapHookMessages
风格），内容：agent 名/description + finalText（或 error）。让主 agent 知道"X 号子代理
完成了，结果如下，请据此继续/汇总"。

### 安全性

- **abort**：`options.signal` abort → 跳出循环，按 abort reason 收尾。父 abort 已通过
  spawn 的 signal 级联到子代理。
- **不死循环**：每轮要么消费≥1 条 pending，要么挂起等一个真实完成事件；后台 agent 有限
  （≤6）、各只完成一次。续轮中新派生的后台 agent 也会被等（链式委派，符合预期）。
- **maxTurns**：续轮共享 `turnLoop.currentTurn`，到上限自然停（避免无限汇总）。
- **wait 原语**：`notificationQueue.subscribe(cb)` + 一个 Promise，abort 时 reject/resolve。

### 测试

- 单测：派 2 个后台 agent，先后完成 → 主 agent 续 2 轮、各看到一条结果，最后 resolve。
- 单测：abort 在等待期间触发 → 立即收尾，不再续轮。
- 单测：sub-agent（isSubAgent）不进入等待循环。
- 回归：无后台 agent 的普通 run，行为不变（循环第一轮即 break）。

## 不做

- 不动 UI（desktop 的 `runningAgents` 指示器已提交，保留；它纯显示，不负责唤醒）。
- 不做跨进程持久化（进程崩溃丢后台 agent，沿用现有契约）。
