# 聊天标题 LLM 自动生成 — 设计

日期:2026-06-01

## 背景与问题

桌面端侧边栏的会话标题来自 renderer 的 localStorage `SessionSummary.title`。当前唯一的"自动标题"逻辑是把用户首条消息**截断到 60 字**(`packages/desktop/src/renderer/transcripts.ts:340`,`touchSession`):

```ts
if (firstUserText && s.title === "新对话") {
  out.title = firstUserText.slice(0, 60);
}
```

后果:用户发一条很长的 query,侧边栏标题就一直是那 60 字的截断,永不更新成简短概括。codeshell 从未有过"用 LLM 生成简短标题"的能力。

## 目标

第一轮问答(用户首条消息 + 助手首次回复)结束后,用**后台模型(auxModel)**异步生成一句话标题,通过 stream 事件回传 renderer,写入侧边栏 `SessionSummary.title`,替换 60 字截断。

非目标(YAGNI):
- 不做"每轮都更新标题"。
- 不做标题的 emoji/多语言装饰。
- 不动 `~/.code-shell/desktop/session-titles.json`(SessionsView 用的另一套,与侧边栏 localStorage 独立);本次只修侧边栏 localStorage 这一套。
- 不做配置热切换(用户已搁置)。

## 架构与数据流

```
用户首条消息 → engine.run() 跑完第一轮 turnLoop（已有）
    ↓ run() 收尾(turnLoop 之后,与 runMemoryPipeline 同段,fire-and-forget)
判定:刚结束的是不是第一轮?(transcript 里 user 角色消息数 == 1)
    ↓ 是
复用已 resolve 的 auxSummaryClient（engine.ts:1239 已构造,无需再 resolveAuxClient）
    ↓
固定 prompt 调 LLM(给定首条 user + 首次 assistant 文本)→ ≤ 约15字标题
    ↓
options.onStream({ type: "session_title", sessionId, title }) 推给 worker → renderer
    ↓
renderer onStream 收到 → 写 localStorage SessionSummary.title → 侧边栏重渲染
```

## 关键设计点

### 1. 生成位置:core engine 侧 `run()` 收尾段
挂在 turnLoop 跑完之后、与 `runMemoryPipeline`(engine.ts:1440,`void` fire-and-forget)同一段的 best-effort 收尾逻辑里。与主回复并行收尾,不阻塞用户看到回复。新增私有方法 `generateSessionTitle(...)`,同样以 `void` 方式调用。

### 2. 触发条件:仅第一轮
仅当本次 run 结束后 transcript 里 user 角色消息数 == 1。用 `session.transcript.getEvents()` / `toMessages()` 统计 user 消息条数。后续轮次不再生成。

### 3. 复用 auxModel,且复用已 resolve 的 client
`run()` 在 engine.ts:1239 已为 context 压缩 resolve 出 `auxSummaryClient`(`resolveAuxClient(llmClient)` 的结果,auxKey 未配时 fallback 主 client)。标题生成**直接复用这个已 resolve 的 client**,不再二次 resolve。标题调用参数沿用 summarize 的风格:`maxTokens` 小(如 64)、`thinking: "disabled"`、`tools: []`。

### 4. 回传通道:新增 `session_title` stream 事件
- 在 `packages/core/src/types.ts:241` 的 `StreamEvent` union 里新增:
  `| { type: "session_title"; sessionId: string; title: string }`
- core 侧通过 `options?.onStream?.({ type: "session_title", sessionId, title })` 发出(与 `session_started` 同款,engine.ts:1097)。
- 该事件经现有 protocol stream 管线(`chat-session.ts` → `client.ts` StreamEvent notification)自动透传到 renderer,无需新增协议方法。

### 5. renderer 接收并写回
- `packages/desktop/src/renderer/App.tsx` 的 `onStream` 处理器(现有 `session_started` case 在 642 行附近)新增 `session_title` case。
- 收到后写入对应 session 的 `SessionSummary.title`:复用 `renameSessionLocal`(transcripts.ts:310)或新增专用写回函数 + setState,触发 Sidebar 重渲染。
- sessionId 用事件里带的(engine 端的 session id);renderer 需用它映射到本地 session(localStorage 里 `engineSessionId` 字段已存在,用于对应)。

### 6. 不覆盖手动重命名
写回前检查:仅当当前标题仍是"自动值"(`"新对话"` 占位符,或等于首条消息 60 字截断)时才覆盖;若用户已手动重命名则跳过。沿用现有"标题非占位符就不动"的思路。

### 7. 错误处理:全程 best-effort
`generateSessionTitle` 整体 try/catch。auxModel 不可用 / LLM 报错 / 事件发送失败 → 静默回退,标题保持现有 60 字截断。绝不能因标题生成失败影响对话主流程。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/core/src/types.ts` | `StreamEvent` union 加 `session_title` |
| `packages/core/src/engine/engine.ts` | `run()` 收尾段 fire-and-forget 调 `generateSessionTitle`;新增该私有方法,复用 `auxSummaryClient` + 判第一轮 |
| `packages/desktop/src/renderer/App.tsx` | `onStream` 加 `session_title` case |
| `packages/desktop/src/renderer/transcripts.ts` | 写回标题(复用/新增函数),含手动重命名守卫 |

## 测试策略

- core 单测:`generateSessionTitle` 仅在 user 消息数==1 时触发;LLM 抛错时静默不抛;复用 auxSummaryClient。
- 触发条件单测:第二轮不再生成。
- 手动验证(desktop 有独立构建):发一条长 query,第一轮回复完后侧边栏标题变成短标题;手动改名后再发消息标题不被覆盖。

## 构建注意

desktop 有独立的 typecheck/build,根目录不覆盖它;core 改动后需 rebuild core 供 desktop dist 引用(见既有项目记忆)。
