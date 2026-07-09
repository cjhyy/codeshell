# TODO Batch Plan - 2026-07

只读调研记录。未修改源码；本文档是本次唯一写入文件。

## 项1：[压缩] 无真实 usage anchor 时初始估算走启发式

### 现状

- `estimateTokens()` 仍是 message/block 启发式外再加 33% padding：`Math.ceil(estimateMessagesTokens(messages) * (4 / 3))`，见 `packages/core/src/context/compaction.ts:17`、`packages/core/src/context/compaction.ts:21`、`packages/core/src/context/compaction.ts:22`。
- `estimateMessagesTokens()` 自身也是字符比例估算，按 english/code/json/mixed/cjk 几组比例和 per-message/block overhead 计算，见 `packages/core/src/context/token-counter.ts:14`、`packages/core/src/context/token-counter.ts:25`、`packages/core/src/context/token-counter.ts:53`、`packages/core/src/context/token-counter.ts:56`。
- `ContextManager.recordActualUsage()` 会保存 provider 的真实 `promptTokens`、messageCount 和当时 heuristic anchor，见 `packages/core/src/context/manager.ts:141`、`packages/core/src/context/manager.ts:144`。
- `estimateTokensHybrid()` 有 actual usage 时会用“actual + 新增消息估算”或按 anchor 比例缩放；没有 actual/anchor 时直接回退 `currentEstimate`，见 `packages/core/src/context/manager.ts:151`、`packages/core/src/context/manager.ts:157`、`packages/core/src/context/manager.ts:163`、`packages/core/src/context/manager.ts:169`。
- actual anchor 的来源在 turn-loop 响应后写回：`response.usage.promptTokens` -> `recordActualUsage(..., messages.length, messages)`，见 `packages/core/src/engine/turn-loop.ts:731`、`packages/core/src/engine/turn-loop.ts:737`、`packages/core/src/engine/turn-loop.ts:740`。
- resume/冷启动首帧 UI 仍有另一套粗略 `char/4` 估算，只作为 `session_started.promptTokens` 首帧显示，见 `packages/core/src/engine/engine.ts:1580`、`packages/core/src/engine/engine.ts:1590`、`packages/core/src/engine/engine.ts:1601`。
- core 已有 `gpt-tokenizer` 依赖，见 `packages/core/package.json:33`；并已有 `packages/core/src/llm/token-counter.ts` 用动态导入封装 `countTokens()`，见 `packages/core/src/llm/token-counter.ts:4`、`packages/core/src/llm/token-counter.ts:17`、`packages/core/src/llm/token-counter.ts:44`。
- session state 持久化的是累计/窗口 usage，不是“某个 messageCount 的 promptTokens anchor”：初始 `tokenUsage` 在 `packages/core/src/session/session-manager.ts:175`，cumulative normalize/update 在 `packages/core/src/engine/engine.ts:1881`、`packages/core/src/engine/engine.ts:1885`，返回 usage 也是 run 总量 `packages/core/src/engine/engine.ts:2345`。

### 可选方案

1. 复用现有 `gpt-tokenizer` 做 message 文本计数
   - 优点：无需新增依赖；比字符比例更准，尤其是混合符号、CJK、代码片段。
   - 缺点：仍不是 provider 的完整 prompt 计数，工具定义、system prompt、不同 provider tokenizer、图片 token 都只能近似；`countTokens()` 首次冷启动可能 fallback `chars/4`。
   - 适合：把无 anchor 的消息区估算误差收窄，不追求精确账单级别。

2. 调整启发式倍率或按内容类型更保守
   - 优点：改动最小；不引入同步 tokenizer 行为变化。
   - 缺点：只是整体偏保守，无法解决不同语言/代码/JSON 的相对误差；倍率过高会导致过早 compaction。
   - 适合：只想降低超窗风险，不在意多压缩。

3. 持久化并在 resume 恢复 actual anchor
   - 优点：resume 首轮能延续上次真实 provider 读数，理论上最贴近当前窗口。
   - 缺点：现有 state 没有 `lastActualTokens + messageCount + anchorEstimate` 这组三元组；需要新增 state schema/兼容、在每次 response 后保存，并处理 compaction 后 message 数变化。
   - 适合：长期追求 context manager 行为稳定，但不是小修。

### 推荐

推荐暂不做“resume 从磁盘恢复 anchor”的方案；优先做方案 1，且只替换/增强消息文本估算，不改变 actual-anchor 逻辑。理由：仓库已经有 tokenizer 依赖和同步 fallback 包装，收益/风险比最好；持久化 anchor 要新增状态合同，收益只覆盖 resume 首轮，且状态含义容易和累计 usage 混淆。

若本批次目标是低风险收尾，也可以建议“不做”：当前 actual usage 在第一轮模型响应后会校准，问题窗口主要是 resume/冷启动首轮压缩判断；除非已有超窗误判证据，否则收益有限。

### 量级

- 方案 1：S-M。
- 方案 2：S。
- 方案 3：M。

### 涉及文件清单 + 需要测试

- 可能涉及：
  - `packages/core/src/context/token-counter.ts`
  - `packages/core/src/context/compaction.ts`
  - `packages/core/src/llm/token-counter.ts`
  - 如做 anchor 持久化：`packages/core/src/session/session-manager.ts`、`packages/core/src/types.ts` 或 session state 类型、`packages/core/src/engine/turn-loop.ts`
- 测试：
  - `packages/core/src/context/manager-hybrid.test.ts` 增加无 anchor 场景的估算稳定性测试。
  - `packages/core/src/context/token-counter.test.ts` 或新测：CJK、代码、JSON、tool_result nested content。
  - 如做 anchor 持久化：resume 后第一次 `checkLimits()` 使用恢复 anchor；旧 state 无字段时 fallback。

## 项2：[前端] /compact 进行中无 UI 反馈 + 不禁用输入（有竞态）

### 现状

- App 已有 per-bucket `busyKeys` 和 `relayingBuckets`，但没有 compacting 状态，见 `packages/desktop/src/renderer/App.tsx:238`、`packages/desktop/src/renderer/App.tsx:245`。
- `compactActiveSession()` 只在触发前检查 `busyKeys.has(activeBucket)`；Promise 飞行中没有设置状态、没有 finally 清理、没有重复触发保护，见 `packages/desktop/src/renderer/App.tsx:2431`、`packages/desktop/src/renderer/App.tsx:2432`、`packages/desktop/src/renderer/App.tsx:2442`、`packages/desktop/src/renderer/App.tsx:2461`。
- compact 成功只 dispatch `usage_update` 并在 noop 时 toast；普通成功反馈主要依赖 stream/event side effect，见 `packages/desktop/src/renderer/App.tsx:2444`、`packages/desktop/src/renderer/App.tsx:2446`、`packages/desktop/src/renderer/App.tsx:2454`。
- `ChatView` 只接收 `busy`，没有 `compacting` prop，见 `packages/desktop/src/renderer/ChatView.tsx:66`、`packages/desktop/src/renderer/ChatView.tsx:68`。
- busy 被明确设计为“不禁用 textarea；Enter 会排队下一轮输入”，见 `packages/desktop/src/renderer/ChatView.tsx:466`、`packages/desktop/src/renderer/ChatView.tsx:468`、`packages/desktop/src/renderer/ChatView.tsx:592`。
- textarea 现在硬编码 `disabled={false}`，见 `packages/desktop/src/renderer/ChatView.tsx:1188`、`packages/desktop/src/renderer/ChatView.tsx:1229`。
- `/compact` 命令在 slash 选择和 submit 路径都会直接调用 `onCompactCommand`，见 `packages/desktop/src/renderer/ChatView.tsx:560`、`packages/desktop/src/renderer/ChatView.tsx:576`。
- 现有 i18n 已有 `chat.compact.running/noSession/done/unchanged/failed` 和 slash 文案，但没有“压缩中”文案，见 `packages/desktop/src/renderer/i18n/ns/chat.ts:37`、`packages/desktop/src/renderer/i18n/ns/chat.ts:52`、`packages/desktop/src/renderer/i18n/ns/chat.ts:236`、`packages/desktop/src/renderer/i18n/ns/chat.ts:252`。

### 可选方案

1. App 增加 per-bucket `compactingBuckets`，ChatView 增加 `compacting` prop
   - App：在 `compactActiveSession()` 解析出 `bucket` 后检查 `compactingBuckets.has(bucket)`，若已有则 toast/return；发起前加入 set，`.finally()` 删除。
   - ChatView：`compacting` 时 textarea disabled、submit/`/compact` early return、send button disabled；busy 仍保留排队语义。
   - UI：composer 下方加一行带 spinner 的 `chat.compact.inProgress` 或 `chat.composer.compactingStatus`。

2. 只在 App 内用 ref 做防重复 + toast，不禁用输入
   - 优点：改动小。
   - 缺点：用户仍不知道压缩中，也能继续发消息；只能解决重复点击，不能解决竞态感知。

3. 把 compact 当作 busy 的一种，复用 `busyKeys`
   - 优点：少一个状态源。
   - 缺点：会破坏当前 busy=模型运行、textarea 可排队输入的语义；Stop/relay/queued input 都会被混淆。

### 推荐

推荐方案 1。新增 `compactingBuckets` 是最小且语义正确的落点：compact 是 session 级后台 mutation，不等同于模型 turn 的 busy。ChatView 只在 `compacting` 时禁用输入；busy 期间继续允许排队，避免回归现有交互。

### 量级

S-M。

### 涉及文件清单 + 需要测试

- 涉及：
  - `packages/desktop/src/renderer/App.tsx`
  - `packages/desktop/src/renderer/ChatView.tsx`
  - `packages/desktop/src/renderer/i18n/ns/chat.ts`
- 新增/建议 i18n key：
  - `chat.compact.inProgress`: `正在压缩上下文…` / `Compacting context…`
  - `chat.compact.alreadyRunning`: `上下文正在压缩，请稍候。` / `Context compaction is already running.`
  - 可选 `chat.composer.placeholderCompacting`: `正在压缩上下文…` / `Compacting context…`
- 测试：
  - renderer/App 或抽离 helper 测试：同一 bucket 连续触发只调用一次 `window.codeshell.compactSession`。
  - ChatView 组件测试：`compacting` 时 textarea/send disabled，busy-only 时 textarea 仍可输入/排队。
  - Promise reject 后 `compactingBuckets` 清理并显示 `chat.compact.failed`。

## 项3：[前端] CC/外部 agent 面板缺「来源 session」标识

### 现状

- 面板实际文件是 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`。它只接收当前 `sessionId`，见 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:24`。
- 面板通过 `window.codeshell.listBackgroundWork(sessionId)` 拉取当前 session 的 background work，见 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:45`、`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:51`。
- PanelArea 给它传的是 active UI session 映射出的 engine sessionId，见 `packages/desktop/src/renderer/App.tsx:3194`、`packages/desktop/src/renderer/App.tsx:3299`、`packages/desktop/src/renderer/panels/PanelArea.tsx:435`、`packages/desktop/src/renderer/panels/PanelArea.tsx:436`。
- UI 行目前只显示描述、agentType/status、job status，没有 source session tag，见 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:260`、`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:265`、`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:299`、`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:312`、`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:320`。
- core 的 UI entry 类型没有给 subagent/job 暴露 parent sessionId：`BackgroundWorkEntry` 的 subagent/job 分支只含 agentId/jobId/description/status/timing 等，见 `packages/core/src/tool-system/builtin/background-work.ts:72`、`packages/core/src/tool-system/builtin/background-work.ts:80`、`packages/core/src/tool-system/builtin/background-work.ts:90`。
- 数据内部已有来源 session：
  - subagent registry entry 有 `sessionId?: string`，见 `packages/core/src/tool-system/builtin/agent-registry.ts:40`、`packages/core/src/tool-system/builtin/agent-registry.ts:44`。
  - background job entry 有 `sessionId: string`，jobId -> entry map 存在，见 `packages/core/src/tool-system/builtin/background-jobs.ts:39`、`packages/core/src/tool-system/builtin/background-jobs.ts:41`、`packages/core/src/tool-system/builtin/background-jobs.ts:73`。
  - shell public shape已有 `sessionId`，见 `packages/core/src/runtime/background-shell.ts:68`、`packages/core/src/runtime/background-shell.ts:70`。
- 但 `listBackgroundWorkForUI(sessionId)` 先按 session 过滤，再映射时对 subagent/job 丢掉 `a.sessionId`/`j.sessionId`，见 `packages/core/src/tool-system/builtin/background-work.ts:118`、`packages/core/src/tool-system/builtin/background-work.ts:123`、`packages/core/src/tool-system/builtin/background-work.ts:135`、`packages/core/src/tool-system/builtin/background-work.ts:136`。
- RPC 也是 session-scoped，缺 `sessionId` 参数会报错，见 `packages/core/src/protocol/server.ts:936`、`packages/core/src/protocol/server.ts:937`、`packages/core/src/protocol/server.ts:945`。

### 可选方案

1. 给 UI entry 补 `sourceSessionId`，面板行显示 tag
   - core 映射时给 shell/subagent/job 都带 `sourceSessionId`。
   - preload/types 同步字段。
   - UI 在 row 右侧显示：等于当前 sessionId 时显示 `本会话`，否则显示 `sid.slice(0, 8)`。
   - 保持 RPC session-scoped，不扩大列表范围。

2. 只在 renderer 侧根据当前 prop sessionId 显示固定 `本会话`
   - 优点：只改 UI/i18n。
   - 缺点：没有真实数据字段，未来跨 session/同 cwd 面板仍不可用；对 jobId->sessionId 调研结论没有落地。

3. 新增跨 session/cwd background work 查询
   - RPC 支持 `{ cwd, allSessions }` 或新 endpoint；返回所有相关 work 并带 sourceSessionId。
   - 优点：真正解决“外部 agent/CC 面板混合来源”。
   - 缺点：需要定义隔离边界、权限和排序；UI 也要区分“本会话/其他会话”并可能跳转来源 session。

### 推荐

推荐方案 1。内部数据已经有 parent sessionId，只是 UI entry 丢字段；补 `sourceSessionId` 是最小的正确合同。当前列表仍是本会话 scoped，因此 tag 初期多半显示“本会话”，但不会阻塞后续跨 session 查询。

如果产品真实需求是“同项目所有 CC/外部 agent 混在一个面板”，再做方案 3；不要先用 renderer 固定文案假装有来源数据。

### 量级

- 方案 1：S。
- 方案 2：S。
- 方案 3：M。

### 涉及文件清单 + 需要测试

- 涉及：
  - `packages/core/src/tool-system/builtin/background-work.ts`
  - `packages/core/src/protocol/server.backgroundwork.test.ts`
  - `packages/desktop/src/preload/types.d.ts`
  - `packages/desktop/src/preload/index.ts`（本地 mirror type 也应同步）
  - `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`
  - `packages/desktop/src/renderer/i18n/ns/panels.ts`
- 测试：
  - core protocol test 断言 subagent/job entry 带 `sourceSessionId`，且仍不泄露其他 session work。
  - renderer row 测试：当前 session 显示“本会话”，不同 session 显示短 id。

## 项4：[记忆] dream/user 区不对称（需方向决策）

### 现状

- memory 设计明确隔离 user/dream：user 是用户拥有、需要 permission gate；dream 是自动整理 workspace；dream 对 user 只读，见 `packages/core/src/session/memory.ts:10`、`packages/core/src/session/memory.ts:14`、`packages/core/src/session/memory.ts:15`。
- prompt 注入会同时包含 user 和 dream，并标记来源，见 `packages/core/src/session/memory.ts:456`、`packages/core/src/session/memory.ts:463`、`packages/core/src/session/memory.ts:484`、`packages/core/src/session/memory.ts:490`。
- Memory tools 暴露 user/dream 两个 scope；user save/delete 需要权限，dream save/delete 自动，见 `packages/core/src/tool-system/builtin/memory.ts:5`、`packages/core/src/tool-system/builtin/memory.ts:8`、`packages/core/src/tool-system/builtin/memory.ts:175`、`packages/core/src/tool-system/builtin/memory.ts:256`。
- Engine permission rules 永久 allow dream scope 的 MemorySave/MemoryDelete；user scope 走默认 ask，见 `packages/core/src/engine/engine.ts:2977`、`packages/core/src/engine/engine.ts:2982`、`packages/core/src/engine/engine.ts:2988`。
- dream consolidation 注释和代码都硬拒非 dream 写入：加载 user/dream 后，user 作为 read-only context，见 `packages/core/src/services/dream-consolidation.ts:88`、`packages/core/src/services/dream-consolidation.ts:91`；写工具检查 `scope !== "dream"` 直接返回错误，见 `packages/core/src/services/dream-consolidation.ts:183`、`packages/core/src/services/dream-consolidation.ts:186`。
- auto-dream cadence 只看 enabled/session count/time，不看 rate-limit，见 `packages/core/src/services/auto-dream.ts:58`、`packages/core/src/services/auto-dream.ts:63`、`packages/core/src/services/auto-dream.ts:67`、`packages/core/src/services/auto-dream.ts:72`。
- memory orchestrator 每次 session 结束都会 `recordSession()`，然后 `shouldAutoDream()` 通过才 runDream，见 `packages/core/src/services/memory-orchestrator.ts:214`、`packages/core/src/services/memory-orchestrator.ts:226`。
- 自动提取会把 project 级记忆直接存入 project user store，把 global 候选放入 pending 等用户审批，见 `packages/core/src/services/memory-orchestrator.ts:118`、`packages/core/src/services/memory-orchestrator.ts:125`、`packages/core/src/services/memory-orchestrator.ts:127`、`packages/core/src/services/memory-orchestrator.ts:140`。
- extraction prompt 已经要求不要提取 ephemeral/progress/done research products，见 `packages/core/src/services/extract-memories.ts:64`、`packages/core/src/services/extract-memories.ts:65`、`packages/core/src/services/extract-memories.ts:66`。
- 设置页已有 memory scope tab 和 Dream 手动整理按钮；pending 审批门也已存在，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:47`、`packages/desktop/src/renderer/settings/MemorySection.tsx:160`、`packages/desktop/src/renderer/settings/MemorySection.tsx:163`、`packages/desktop/src/renderer/settings/MemorySection.tsx:467`。
- pending 目前用于“global 自动提取候选 -> 用户批准/降级/拒绝”，不是 user 清理建议，见 `packages/core/src/session/memory.ts:39`、`packages/core/src/session/memory.ts:383`、`packages/core/src/session/memory.ts:391`、`packages/desktop/src/renderer/settings/MemorySection.tsx:509`。
- quota 模块已有 Codex rate-limit 查询，返回 `usedPercent`，见 `packages/core/src/quota/index.ts:53`、`packages/core/src/quota/index.ts:95`、`packages/core/src/quota/types.ts:15`、`packages/core/src/quota/types.ts:19`；但它是 async，并且当前 `shouldAutoDream()` 是 sync。

### 可选方案

#### 方向一：dream 能对 user 区提议清理，但不自动删

方案 A：新增 cleanup proposal store
- dream loop final summary 之外，允许输出结构化候选：`{location, scope:"user", name, reason, action:"delete"|"merge_into_dream"}`。
- core 写到 `memory-cleanup-proposals/*.json` 或 memory root 下独立目录，不触碰 user。
- Settings MemorySection 增加“清理建议”区，用户可逐条或批量批准；批准时复用 `deleteMemory(level, "user", name, cwd)` 走 main memory-service。
- 优点：权限模型干净；建议和真实 memory entry 分离；可审计。
- 缺点：新增一套小型数据模型和 UI。
- 量级：M。

方案 B：复用 pending scope 承载“清理建议”
- 把清理建议保存成 pending entry 的 content，由 UI 解析并执行。
- 优点：最少新存储。
- 缺点：pending 语义现在是“候选记忆入 user”，强行塞删除建议会混淆 approve/demote/reject；`MemoryEntry` 也没有 action 字段。
- 量级：S-M，但技术债高。

方案 C：不让 dream 生成结构化建议，只在 summary 里提示用户
- 优点：几乎无代码。
- 缺点：不可批量批准，不满足“设置里一次性批准”。
- 量级：S。

推荐：方向一选方案 A。它最契合现有“user 修改必须用户拍板”的权限架构，又能让 dream 帮忙发现 stale/duplicate。

#### 方向二：changelog/过程类记忆默认存 dream，user 只留耐用事实

方案 A：扩展 extraction schema，增加 `targetScope: "user" | "dream"`
- 继续保留现有 `scope: "global" | "project"` 表示位置；新增 `targetScope` 表示 memory 区。
- prompt 明确：耐用事实/用户偏好 -> user；过程记录、完成状态、changelog、低置信度候选 -> dream。
- `MemoryOrchestrator` 根据 `targetScope` 路由：`new MemoryManager({ projectDir, scope:"dream" })` 或现有 user/pending。
- 优点：从源头减少 user 区噪声；dream 已有自动整理能力。
- 缺点：要改 prompt、parser、orchestrator、测试；还要处理 global+dream 是否允许。
- 量级：M。

方案 B：保持 extraction 不变，增加事后分类/迁移 pass
- 提取仍写 user/pending；随后用规则或 LLM 把 `origin:auto` 且过程类条目移动到 dream。
- 优点：对 extraction schema 影响小。
- 缺点：先污染再清理，迁移误判会影响 user store；多一次后台 LLM/规则复杂度。
- 量级：M-L。

方案 C：只加强 extraction prompt 和 maxCount，不迁移
- prompt 已有禁止进度/过程的规则，继续收紧并加测试。
- 优点：S，风险小。
- 缺点：不能解决已经进入 user 区的历史噪声；模型仍可能误提取。
- 量级：S。

### 推荐

推荐：如果只选一个更契合当前架构的近期方向，选方向一方案 A；它不改变 user/dream 存储语义，只补“建议 -> 用户批准”的缺口。方向二方案 A更契合长期信息分层，但会改变提取合同，建议作为后续架构项执行。

### `shouldAutoDream` 加 Codex rate-limit 阈值跳过

可行，但不建议直接塞进当前 sync `shouldAutoDream()`。推荐把 cadence 判断保持纯同步，在 `MemoryOrchestrator.run()` 的 `shouldAutoDream() && runDream` 之后、真正 `runDream` 之前增加 async quota gate：

- 新增配置，如 `memories.autoDreamSkipWhenCodexUsedPercentGte`，默认关闭或默认 90/95。
- Engine/host 注入 `quotaGate` 或 `getCodexQuota`，内部复用 `queryCodexQuota()`。
- 任一窗口 `usedPercent >= threshold` 时跳过本次 dream，但不要 `recordDreamComplete()`，避免吞掉下次机会。
- 查询失败应 fail-open（继续 dream）或 fail-closed 需要产品决策；我建议 fail-open 并打 log，因为 auto-dream 已有 session/time cadence。

量级：S-M。测试用 fake quota result 覆盖低于阈值运行、高于阈值跳过、查询失败策略。

### 量级

- 方向一方案 A：M。
- 方向二方案 A：M。
- 历史迁移：L。
- rate-limit gate：S-M。

### 涉及文件清单 + 需要测试

- 方向一涉及：
  - `packages/core/src/services/dream-consolidation.ts`
  - `packages/core/src/services/auto-dream.ts`
  - 新 proposal service/model 文件
  - `packages/desktop/src/main/memory-service.ts`
  - `packages/desktop/src/preload/index.ts`
  - `packages/desktop/src/preload/types.d.ts`
  - `packages/desktop/src/renderer/settings/MemorySection.tsx`
  - `packages/desktop/src/renderer/i18n/ns/settings.ts`
- 方向二涉及：
  - `packages/core/src/services/extract-memories.ts`
  - `packages/core/src/services/memory-orchestrator.ts`
  - `packages/core/src/session/memory.ts`（如迁移/metadata 需要）
  - `packages/desktop/src/renderer/settings/MemorySection.tsx`（如展示/迁移入口）
- 测试：
  - dream 不自动删除 user，只生成 proposal。
  - proposal 批量批准会 soft-delete user 条目；拒绝不动 user。
  - extraction `targetScope:"dream"` 路由到 dream，耐用事实仍到 user/pending。
  - rate-limit 高水位跳过 dream，且不调用 `recordDreamComplete()`。

## 项5：[会话] TodoWrite resume — 只缺测试

### 现状

- TodoWrite 设计说明明确“transcript 是 task store；resume 扫最近 TodoWrite tool_use”，见 `packages/core/src/tool-system/builtin/task.ts:8`、`packages/core/src/tool-system/builtin/task.ts:11`。
- live tool 会把 all-completed 转为空列表并 emit `task_update`，见 `packages/core/src/tool-system/builtin/task.ts:101`、`packages/core/src/tool-system/builtin/task.ts:105`、`packages/core/src/tool-system/builtin/task.ts:108`。
- `readLastTodoSnapshot()` newest-first 找 `tool_use` + `toolName === "TodoWrite"`，解析 `args.todos`，并同样 all-done -> `[]`，见 `packages/core/src/tool-system/builtin/task.ts:154`、`packages/core/src/tool-system/builtin/task.ts:157`、`packages/core/src/tool-system/builtin/task.ts:159`、`packages/core/src/tool-system/builtin/task.ts:167`。
- Engine resume 路径在 `options.sessionId` 存在时扫描 transcript 并发 `task_update`，见 `packages/core/src/engine/engine.ts:1424`、`packages/core/src/engine/engine.ts:1426`、`packages/core/src/engine/engine.ts:1613`、`packages/core/src/engine/engine.ts:1617`。
- 注意：Engine 当前只在 `snap && snap.length > 0` 时 emit，所以 all-completed 的 `[]` 在 Engine resume 层不会发空 `task_update`，见 `packages/core/src/engine/engine.ts:1615`。如果“末次全 completed -> 清空”要求通过 resume event 显式清空已有 UI，这个测试会暴露一个小缺口；如果只要求新 hydrate 为空面板，则 desktop reader 已覆盖。
- desktop transcript-reader 已有 TodoWrite disk hydrate 测试：普通 TodoWrite -> synthetic `task_update`，all-completed -> `tasks: []`，见 `packages/desktop/src/main/transcript-reader.ts:163`、`packages/desktop/src/main/transcript-reader.ts:170`、`packages/desktop/src/main/transcript-reader.test.ts:115`、`packages/desktop/src/main/transcript-reader.test.ts:159`。
- `rg` 未见 core 层专门测试 `readLastTodoSnapshot` 或 Engine resume 的 `task_update` 重放。

### 可选方案

1. 只补纯函数测试
   - 新建 `packages/core/src/tool-system/builtin/task.test.ts`。
   - 覆盖：最近 TodoWrite 胜出、all completed -> `[]`、无 TodoWrite -> `null`、非法 todos 跳过。
   - 优点：快、稳定。
   - 缺点：不验证 Engine resume 是否真的发 stream event。

2. 补 Engine resume 集成测试
   - 新建 `packages/core/src/engine/engine.todo-resume.test.ts`。
   - 用 temp `sessionStorageDir` + fake provider；先 `engine.getSessionManager().create(..., sid)` 并 `transcript.appendToolUse("TodoWrite", ...)`，再 `engine.run("resume", { sessionId: sid, onStream })`。
   - 断言 `onStream` 收到 `task_update`。
   - 优点：覆盖用户实际路径。
   - 缺点：fake provider/Engine 启动稍重。

3. 两层都补
   - 纯函数保证 edge case，Engine 集成保证 wiring。
   - 量级仍可控。

### 推荐

推荐方案 3。核心风险不在 parser，而在 resume wiring；但 all-completed/无 TodoWrite 这种边界用纯函数测更清晰。Engine 集成至少覆盖“有 TodoWrite -> resume 重放为 task_update”。

### 量级

S。

### 涉及文件清单 + 需要测试

- 涉及：
  - `packages/core/src/tool-system/builtin/task.ts`（只读调研；实现不一定要改）
  - `packages/core/src/engine/engine.ts`（若决定 all-completed resume 要显式清空，需改 `snap.length > 0` 守卫）
  - 新测 `packages/core/src/tool-system/builtin/task.test.ts`
  - 新测 `packages/core/src/engine/engine.todo-resume.test.ts`
- 测试用例：
  - TodoWrite snapshot 含 pending/in_progress -> `task_update` tasks 带 position id、subject、activeForm、status。
  - 最近一次 TodoWrite 全 completed -> 纯函数返回 `[]`；若产品要求 resume 显式清空，则 Engine test 也应期待 `task_update: []`。
  - 无 TodoWrite -> `readLastTodoSnapshot()` 返回 `null`，Engine resume 不发 task_update。
  - mock resume 路径：用 `SessionManager.create(..., explicitSessionId)` 预置 transcript，再 `Engine.run(..., { sessionId })` 触发 `resume()`。

## 项6：[前端] 乐观气泡 — 只剩 announce 缺 key

### 现状

- reducer action 已支持 `clientMessageId`，见 `packages/desktop/src/renderer/transcriptsReducer.ts:17`、`packages/desktop/src/renderer/transcriptsReducer.ts:25`。
- hydrate 保护会保留带 `steerId` 或 `clientMessageId` 的本地 user intent，并用 snapshot 里的同 key 去重，见 `packages/desktop/src/renderer/transcriptsReducer.ts:56`、`packages/desktop/src/renderer/transcriptsReducer.ts:66`、`packages/desktop/src/renderer/transcriptsReducer.ts:73`、`packages/desktop/src/renderer/transcriptsReducer.ts:79`。
- `appendUserMessage()` 收到同一 `clientMessageId` 会替换现有 user message，不追加，见 `packages/desktop/src/renderer/types.ts:1134`、`packages/desktop/src/renderer/types.ts:1137`、`packages/desktop/src/renderer/types.ts:1152`。
- normal send 会生成并 dispatch/pass through `clientMessageId`，见 `packages/desktop/src/renderer/App.tsx:1977`、`packages/desktop/src/renderer/App.tsx:2020`、`packages/desktop/src/renderer/App.tsx:2050`。
- queue/steer 也生成/携带 `clientMessageId`，见 `packages/desktop/src/renderer/App.tsx:2266`、`packages/desktop/src/renderer/App.tsx:2267`、`packages/desktop/src/renderer/App.tsx:2254`。
- automation announce 的 opening user bubble 没带 key，见 `packages/desktop/src/renderer/App.tsx:1670`、`packages/desktop/src/renderer/App.tsx:1671`。
- mobile announce 同样没带 key，见 `packages/desktop/src/renderer/App.tsx:1737`、`packages/desktop/src/renderer/App.tsx:1740`。
- reducer 已有 `clientMessageId` 去重测试，见 `packages/desktop/src/renderer/transcriptsReducer.test.ts:163`、`packages/desktop/src/renderer/transcriptsReducer.test.ts:181`。

### 可选方案

1. renderer-only 给 announce dispatch 稳定 key
   - automation：`clientMessageId: \`automation:${meta.sessionId}:prompt\``。
   - mobile：`clientMessageId: \`mobile:${meta.sessionId}:prompt\``。
   - 优点：最小；重复 announce 会被 `appendUserMessage()` 替换而不是追加。
   - 限制：如果后续 hydrate 的磁盘 user message 没有同一个 `clientMessageId`，hydrate 不能靠 key 与磁盘副本去重。

2. 端到端持久化同一个 key
   - main automation/mobile host 启动 Engine.run 时也传同一 `clientMessageId`，renderer announce 用相同 key。
   - 优点：local duplicate 和 hydrate duplicate 都解决。
   - 缺点：要改 main/automation/mobile 启动链路，确认后台 run API 都支持传递。

3. reducer 对 announce 做文本/session heuristic 去重
   - 优点：无需跨进程传 key。
   - 缺点：同文案不同 intent 会误去重；不如稳定 key 可解释。

### 推荐

推荐先做方案 1：在 `App.tsx` 两个 announce dispatch 落点加稳定 `clientMessageId`。现有 reducer 能直接吃这个 key：重复 `user_message` 同 key会替换，hydrate 若 snapshot 也有同 key会去重。

风险点要写进实现说明：renderer-only key 不会自动进入 core transcript。如果观测到的是 hydrate 后重复，而不是重复 announce dispatch，则需要升级到方案 2，让 automation/mobile 的 Engine.run 也持久化同一 key。

### 量级

S。

### 涉及文件清单 + 需要测试

- 涉及：
  - `packages/desktop/src/renderer/App.tsx`
  - 可选补测：`packages/desktop/src/renderer/transcriptsReducer.test.ts`
  - 若做端到端：`packages/desktop/src/main/automation-host.ts`、`packages/desktop/src/main/mobile-remote/**` 相关启动链路
- 测试：
  - reducer 层：同一 `automation:sid:prompt` 连续 `user_message` 只保留一条。
  - hydrate 层：snapshot 带相同 clientMessageId 时不重复。
  - 如仅 renderer-only：记录一个测试/注释说明 snapshot 不带 key 时 reducer 不会误删文本相同但无 key 的服务端消息。

## 总表

| 项 | 推荐方案 | 量级 | 是否需先做方向决策 | 建议执行顺序 |
|---|---|---:|---|---:|
| 1 压缩估算 | 复用现有 `gpt-tokenizer` 改善无 anchor 消息估算；不急于持久化 anchor | S-M | 否 | 5 |
| 2 compact UI 反馈 | App 增加 per-bucket `compactingBuckets`，ChatView 禁用 compacting 输入并显示状态 | S-M | 否 | 1 |
| 3 背景面板来源 session | core UI entry 补 `sourceSessionId`，renderer row 显示“本会话/短 id” | S | 否 | 3 |
| 4 memory dream/user | 近期做“dream 生成 user 清理 proposal，用户批量批准”；长期再改 extraction 路由 | M | 是 | 6 |
| 5 TodoWrite resume 测试 | 补纯函数 + Engine resume 集成测试；确认 all-completed 是否需 Engine 显式 emit `[]` | S | 否 | 2 |
| 6 announce 乐观气泡 key | 两处 announce dispatch 加稳定 `clientMessageId`；必要时再端到端持久化 | S | 否 | 4 |
