# 子代理续接(send_input)设计稿

状态:已拍板,实现中(TDD) · 2026-06-23 · worktree `subagent-skill-plugin-namespace`

拍板决策:(1) spawn 返回改签名 `{text,sessionId}`;(2) **v1 就要跨重启续接** —— 用 agent_id 直接作为子代理 sid(§4.4),session 落盘即映射,零额外持久化;(3) 走 transcript replay(学 CC),不做活体 thread。

## 1. 要解决什么

主 agent 把活交给子代理,拿到一截结果后,想让**同一个子代理带着完整记忆继续**(回应反馈、改稿、追问),而不是重新 spawn 一个新子代理 + 手工把上下文重发一遍(fat packet,有损且费 token)。

当前 codeshell 子代理是 **spawn → run → 丢弃**,无任何续接通道(工具描述原话:"report is the ONLY thing returned to you — it is stateless")。这导致:
- mimi-video 那套 `Resume agent <id>` 流程在 codeshell 完全空转(`.agent-state.json` 死文件)。
- 用户中途打断子代理后,没有文件兜底就丢 context。

## 2. 选型:transcript replay,不做活体 thread

调研(2026,带 openai/codex 源码级 issue + CC 官方 SDK 文档)结论:

| | Codex | Claude Code | codeshell 选型 |
|---|---|---|---|
| 子代理模型 | 常驻活体 thread(`AgentRegistry`) | 无状态 + transcript replay | **学 CC:replay** |
| 续接机制 | `send_input` 注入活体 thread,可 mid-task steer | `resume: sessionId` 重放落盘 transcript | resume 落盘 session |
| 代价/坑 | slot 泄漏 bug(完成不 close 漏槽) | 无活体、无槽位、重启可续 | 无槽位类 bug |

**关键依据**:CC 是存在证明 —— 无活体 thread 也能给"续接后带完整记忆"的 UX,靠的是独立持久化每个子代理的 transcript、按需 replay。codeshell 的 session 模型与 CC 同构,地基已具备:

- `Engine.run({ sessionId })` 已支持 resume 已有落盘 session(engine.ts:1403-1420 → `sessionManager.resume(sid)` 载入完整 transcript,含所有 tool results)。
- `Engine.run` 返回对象已带 `sessionId`(engine.ts:1523 等)。
- 子代理 spawn 时本就建带 sid 的独立落盘 session(独立于父对话,父 compaction 不污染它)。

**放弃的能力**:mid-task steering(子代理跑一半插话改方向)。需要活体 thread,小众,等真实需求再说。本设计覆盖 turn-之间续接,即用户最初要的"打断后带记忆继续"。

## 3. 现状缺口(已核实)

1. `SubAgentSpawner.spawn()` 返回 `Promise<string>`(只有 text)——**子代理 sid 没透出来**。(context.ts:109)
2. `asyncAgentRegistry` 的 `AsyncAgentEntry.sessionId` 存的是**父 session id**(用于 `hasRunningForSession` 过滤),**不是子代理自己的 sid**。(agent-registry.ts:44)
3. registry 只在 **background/async** 路径 register(agent.ts:403 / 706);**同步子代理不进 registry**,跑完即弃,无从追溯。
4. `child.run(req.prompt)` 未传 sessionId → 每次 cold-start 新 sid。

## 4. 改造方案

### 4.1 透出子代理 sid

`SubAgentSpawner.spawn` 返回值从 `Promise<string>` 改为 `Promise<{ text: string; sessionId: string }>`(spawn 内部 `child.run` 的 result 本就有 sessionId,只是没 return)。所有现有 caller 取 `.text`。

新增:`SubAgentSpawnRequest.resumeSessionId?: string`。spawn 内 `child.run(prompt, { sessionId: req.resumeSessionId })` —— 有则 resume,无则 cold-start(现行为)。

### 4.2 registry 存子代理自己的 sid

`AsyncAgentEntry` 新增 `childSessionId?: string`(子代理自己的 sid,区别于父 `sessionId`)。

**同步子代理也要登记**:这是关键改动。同步子代理跑完后,把 `{ agentId, childSessionId, status: "completed" }` 写进 registry(轻量条目,不带 transcript 流)。这样 send_input 才能找回它。注意不要破坏现有"同步子代理不刷 dock"的行为——登记一个 `kind: completed` 的静默条目即可,不 enqueue 通知。

### 4.3 新工具 `AgentSendInput`

```
AgentSendInput(agent_id: string, prompt: string) -> string
```

执行:
1. `asyncAgentRegistry.get(agent_id)` → 取 `childSessionId`。找不到 / 无 sid → 返回明确错误("no resumable sub-agent with id X; it may have been cleaned up — re-spawn with a Handoff Packet")。
2. 走与同步 spawn 相同的路径,但带 `resumeSessionId: childSessionId`:`spawner.spawn({ ..., prompt, resumeSessionId })`。
3. 同步等待,返回新一轮 finalText(与现有同步子代理返回语义一致)。
4. 更新 registry 该条目(刷新 finishedAt 等)。

继承现有约束:
- **不能起孙代理**:resume 进来的子代理同样 strip Agent/AgentSendInput(防嵌套,复用 resolveChildToolScope)。
- **abort 级联**:父打断 → 子 abort(复用现有 syncController/parentSignal 机制)。
- **auto-background**:send_input 的子代理跑太久 → 同样 handoff 到后台(复用现路径),完成后走 notification 唤醒。

### 4.4 跨重启续接:用 agent_id 作为子代理 sid(无需额外映射)

**核实**:`agent_id = nanoid(8)`(agent.ts:378),子代理 `sid = nanoid(16)`(session-manager.ts:105)—— 现在是两个独立 id。`SessionManager.create` 已支持 `explicitSessionId`(create.ts:105 `explicitSessionId ?? nanoid(16)`)和 `parentSessionId`(写进 state.json)。

**方案**:spawn 子代理时,**把 agent_id 直接作为 child 的 sessionId**(`child.run(prompt, { sessionId: agentId })`,cold-start 路径传 explicit sid)。于是 `agent_id === childSid`,子代理 session 落在 `~/.code-shell/sessions/<agent_id>/state.json`(带 `parentSessionId`)。

收益:
- **跨重启续接零额外持久化**:`AgentSendInput(agent_id)` → 直接 `sessionManager.resume(agent_id)`,session 文件本就在盘上。registry 内存条目丢了也不影响(它只是个 fast-path 缓存)。
- registry 的 `childSessionId` 退化成"等于 agentId",可不新增字段(但保留语义注释)。
- `AgentSendInput` 查找顺序:先查内存 registry(同进程,带 status);miss 再探盘 `sessionManager.exists(agent_id)`(跨重启)。两者都 miss → 明确错误。

约束:agent_id 必须满足 `assertSafeSessionId`(nanoid(8) 是 url-safe 字母数字,天然满足;加一道断言防御)。

### 4.5 生命周期 / 清理语义

- 子代理"完成"后 transcript **保留**(本就落盘),可被多次 `AgentSendInput`。
- **无需 close**(replay 模型无槽位,不存在 Codex 的泄漏类 bug)。
- 清理 = 跟随 session 清理(子代理 session 即普通 session,同一套清理 / 留存策略)。

### 4.6 与 Handoff Packet 的配合(mimi-video 落地形态)

- **首次 spawn**:`Agent(director, prompt=<完整 Handoff Packet>)` —— 全量 context。
- **后续续接**:`AgentSendInput(agent_id, prompt=<增量指令>)` —— 如"业务审核 FAIL,按以下意见改:…",子代理 resume 后带着自己刚写的分析记忆改稿,不用重发全文。
- CLAUDE.md 据此把死的 `Resume agent <id>` 流程改成真能跑的 `AgentSendInput`。

## 5. 要改的文件

| 文件 | 改动 |
|---|---|
| `tool-system/context.ts` | `SubAgentSpawner.spawn` 返回 `{text,sessionId}`;`SubAgentSpawnRequest` 加 `resumeSessionId?` |
| `engine/engine.ts` | spawn 闭包:`child.run(prompt, {sessionId: req.resumeSessionId})`,return `{text, sessionId: result.sessionId}` |
| `tool-system/builtin/agent-registry.ts` | `AsyncAgentEntry` 加 `childSessionId?`;同步子代理登记静默条目 |
| `tool-system/builtin/agent.ts` | 同步路径取 spawn 返回的 sid 存 registry;新增 `agentSendInputToolDef` + `agentSendInputTool` |
| `tool-system/builtin/index.ts` | 注册 AgentSendInput;子代理工具池 strip 它(防嵌套) |
| `engine/engine.ts` resolveChildToolScope | nested-disallowed 列表加 AgentSendInput |

## 6. 测试计划(TDD)

1. **spawn 返回 sid**:spawn 一个同步子代理,返回值含非空 sessionId;registry 有 `childSessionId`。
2. **resume 接续记忆**:spawn(让子代理"记住数字 7")→ AgentSendInput("我刚让你记的数字是?")→ 子代理答 7(证明 transcript replay 带回了记忆)。用 fake spawner / 真 Engine 集成各一。
3. **未知 agent_id**:AgentSendInput 一个不存在的 id → 明确错误串,不崩。
4. **防嵌套**:resume 进来的子代理工具池不含 Agent/AgentSendInput。
5. **abort 级联**:父 abort → send_input 子代理收到 abort,返回 "aborted"。
6. **同步子代理登记不污染 dock**:登记的静默条目不触发 notification enqueue。
7. **回归**:现有所有 agent.* 测试 + 全 core 套件绿。

## 7. 不在本设计范围(显式搁置)

- mid-task steering(活体 thread)
- 跨进程重启续接(需 agent_id→sid 落盘映射,v2)
- Agent teams / dynamic workflows / worktree isolation(更上层,等真实用例)
- `AgentList`(列可续子代理)—— 可选小工具,看 mimi-video 实际需不需要再加
