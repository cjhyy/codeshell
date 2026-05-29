# 第 1 章 · Engine 编排核心

> 覆盖:`engine/engine.ts`(2062 行)、`engine/runtime.ts`、`engine/query.ts`、`engine/turn-state.ts`
> Engine 是把所有组件接线在一起的 **facade**:一次 `run(task)` = 一条用户消息的完整生命周期。

---

## 1. 职责

`Engine` 持有一个 session 的全部"装配材料",并在每次 `run()` 时把它们组装成一个 `TurnLoop` 去跑。
它不实现代理循环本身(那是第 2 章 `TurnLoop`),而是负责:

- **输入预处理**:图片解析 / 视觉能力闸 / 图片体积策略 / 粘贴噪声检测。
- **会话装配**:cold-start vs resume、补孤儿 tool_use、注入 CLAUDE.md / hook reminder。
- **资源装配**:LLM client、permission、tool executor、context manager、prompt composer、MCP。
- **生命周期 hook 编排**:session_start / user_prompt_submit / agent_start / stop(goal)/ agent_end / session_end。
- **运行时控制面**:`switchModel` / `setPermissionMode` / `setPlanMode` / `forceCompact` / `injectContext`。
- **子代理派生**:`subAgentSpawner.spawn()` 新建一个子 `Engine`。

## 2. 关键类型 / 入口

- `EngineConfig`(99-176):构造期一次性配置。重点字段:
  - `llm`(纯模型身份,热切换时整体轮换) vs `clientDefaults`(跨模型旋钮 temperature/timeout/retry/imageDetail,切换时不动)。**这条分离是 §session-isolation §5 的修复落地** —— LLMConfig 去掉了 per-model 残留旋钮。
  - `runtime?: EngineRuntime` —— 共享资源适配器;给了就复用 worker 级单例,没给就自建。
  - `settingsScope`:默认 `'project'`(SDK 嵌入不偷读宿主 `~/.code-shell`),宿主入口传 `'full'`。
  - `isSubAgent`:贯穿全文的"减面"开关(跳过 plugin/settings hooks、跳过 activeKey resync、禁 goal、禁套娃)。
- `Engine.run(task, options)`(579):唯一主入口,返回 `EngineResult`。
- `EngineRuntime`(runtime.ts):worker 级共享只读资源 + sandbox backend 缓存 + `close()`。
- `query()`(query.ts):把 `TurnLoop` 包成 async generator 的**另一条**公共入口(不走 Engine,自带假 sid `"query"`)。
- `turn-state.ts`:`TurnState` / `initialTurnState` / `newTurnId`(turn 关联日志 ID)。

## 3. 逻辑主线(`run()` 走一遍)

```
run(task)
 ├─ 0. 包 onStream:截 task_update → latestTodos(给 TaskGuard 用)        [605]
 ├─ 1. 图片管线 parseTaskWithImages → 视觉能力闸 → image-policy
 │       (压缩 tryCompressImages → 超限丢弃 dropOversizedImages → 仍超限 refuse) [623-722]
 ├─ 2. 粘贴噪声 detectPastedNoise → 命中直接返回 completed(不开 turn)       [729]
 ├─ 3. 装 subAgentSpawner(闭包,spawn 时新建子 Engine,剥 Agent 套娃工具)  [748]
 ├─ 4. resolveSandbox(runtime 缓存 or 直算,显式模式 fail-closed)          [847]
 ├─ 5. 建 toolCtx(buildToolContext + sandbox/cwd/streamCallback)         [855]
 ├─ 6. session:exists? resume(补孤儿 tool_use + 恢复 costState) : create  [914-965]
 ├─ 7. setCurrentSid + runWithSid 包住后续全部(ALS 隔离 sid)             [981/990]
 ├─ 8. hooks: on_session_start / user_prompt_submit(可改写 prompt)        [1009-1044]
 ├─ 9. 种 ctx-bar 估算(每 process+sid 只种一次)+ emit session_started    [1054-1071]
 ├─ 10. 并行启动:createLLMClient(网络握手早启)                          [1088]
 ├─ 11. 建 permission(PermissionClassifier)+ toolExecutor + guards       [1091-1119]
 ├─ 12. contextManager + promptComposer(读 disabledSkills/Plugins)       [1121-1135]
 ├─ 13. MCP connectAll(优先 runtime.mcpPool)                            [1142-1150]
 ├─ 14. plan 模式过滤 toolDefs 到只读白名单                               [1159-1178]
 ├─ 15. Promise.all([llmClient, systemPrompt, systemContext])           [1180]
 ├─ 16. unshift CLAUDE.md userContext + splice hook reminder            [1188-1205]
 ├─ 17. modelFacade + 接 summarize/getOutputTokens + fileHistory hook    [1233-1287]
 ├─ 18. goal 模式:注册 on_stop GoalStopHook(run 结束 finally 注销)       [1301-1310]
 ├─ 19. new TurnLoop(...).run(messages)  ← 真正的循环在这里               [1323-1379]
 ├─ 20. 落 compactedMessagesBySession、recordSessionEnd、session_end hook  [1385-1411]
 ├─ 21. fire-and-forget runMemoryPipeline(≥8 msg 才跑)                   [1416]
 └─ 22. saveState(status=terminalReason)+ agent_end + turn_complete       [1423-1456]
```

**装配边界 = per-run**(印证 §session-isolation §2):每条用户消息重算 systemPrompt / tools 快照 / model / skills 开关。run 内所有 turn 复用同一份装配。

### 子代理派生(`subAgentSpawner.spawn`, 755)

- `resolveChildToolScope`(250):有 allowlist → 用 allowlist 减套娃工具;无 → 继承父 enabled/disabled + 强制把 `Agent/AgentStatus/AgentCancel` 塞进 disabled。**双保险**:这里剥 + `agent.ts` 运行时再查一次。
- `resolveChildLlm`(205):子模型 key 命中 pool → 用该 entry;miss → 软回退父 llm(不报错,容忍过期 agent 定义)。
- 子 Engine 的 stream 过滤掉 `usage_update/session_started/context_compact`(890-825)—— 否则子代理那个全新小 sid 会把主对话的 ctx-bar 砸到 <1%。

### 内存管线(runMemoryPipeline / runDreamLoop, 1465-1674)

- session 结束后台跑:`MemoryOrchestrator` 抽取记忆 + dream loop 整合。
- dream loop 是个**离线小循环**(MAX_TURNS=8 / MAX_WRITES=10),只放 4 个 Memory 工具,且 `MemorySave/Delete` 只许 `scope=dream`(无交互 permission 后端,user scope 硬拒)。

## 4. 逻辑理顺问题

> ❓ = 读出来觉得别扭 / 需确认;⚠️ = 较确定的隐患。

- ⚠️ **`forceCompact` 用 `require()` 同步导入 ESM**(1809:`const { estimateTokens } = require("../context/compaction.js")`)。整个包是 ESM(`.js` 后缀 import),此处混入 CJS `require` —— 在纯 ESM 运行(`type:module` + bundler 外)下 `require` 未必存在。其它地方都用顶部 `import`。**疑似遗留,应改成静态 import。**

- ❓ **`switchModel` 无 run-state 防护**(1689)—— 正是 §session-isolation §4.2 点名的问题:run 进行中切模型会越过 run 边界改 `this.config.llm`,而当前 run 的 `llmClient` 是 `run()` 局部变量、构造时已锁死旧上限。本章读到的实现确认该闸**仍未加**。调研结论建议"挂起到 run 边界"。

- ❓ **`run()` 是巨型方法(~880 行)**,且 step 6 之后用 `return runWithSid(sid, async () => { ... })` 把后半段整体塞进闭包,缩进与 `try/finally(unregister goal hook)` 嵌在一起,可读性差。step 19 的 `turnLoop.run` 在 try 里,但 step 20-22 的 saveState/hook 在 try **之外** —— 若 `turnLoop.run` 抛错(非返回 reason),finally 只注销 goal hook,后面的 `recordSessionEnd / saveState(status) / session_end` **全部跳过**,session 的 on-disk status 会停留在 step 6 写的 `"active"`。❓ 确认 `turnLoop.run` 是否保证"永不抛、只返回 reason"?(若是,这点无害;注释 1377 用了 `let result` 但没兜 catch。)

- ❓ **`populateModelPoolFromSettings` 与 `reloadModelPool` 的 runtime 守卫不对称**:`reloadModelPool` 有 `if (!this.runtime)` 守卫(527),但构造函数里 `if (!config.runtime) this.populateModelPoolFromSettings()`(407)也守了 —— 一致。但 `autoPopulatePool`(537)直接 `this.modelPool.register` **不查 runtime**,若 runtime 共享池 + llm.apiKey 非空 + settings.models 空,会往共享池里写。❓ 这条路径在 runtime 模式下能否触发?(构造期只有 `!config.runtime` 才进 populate,所以应进不来 —— 但 `autoPopulatePool` 本身没自带守卫,属"靠调用点保护",脆。)

- ❓ **ctx-bar 估算 char/4 与真实 token 的偏差**(1056)。注释说只在首帧用,之后被真实 usage_update 覆盖。但 resume 跨进程时 `ctxSeedSent` 是新的 Set(per-process),会重新种一次粗估 —— 与注释"on subsequent turns UI already shows accurate ctx"在**跨进程 resume 首帧**下不成立(新进程没有上一帧)。这是设计接受的近似,记录备查。

- ❓ **`persistActiveModel` 写 `~/.code-shell/settings.json` 不经 SettingsManager**(1709),直接读改写文件,且**写死 home 级**(忽略 `settingsScope`)。而读取走 `getSettingsManager()`(尊重 scope)。写/读路径不对称:scope=`isolated`/`project` 的 Engine 切模型仍会污染 home settings.json。❓ 是否有意?(可能因为 activeKey 本就是"用户全局当前选择"。)

- ❓ **`query.ts` 默认 `maxTurns=30 / maxToolCallsPerTurn=20`,Engine.run 默认 `100 / 10`**(1347 vs query 73)。两条公共入口默认值不一致。query 是否仍被使用?index.ts 未 export `query`,可能是内部/测试残留。

- ❓ **`buildPermissionConfig` 里 `mode==="dontAsk"` 与 default 都映射到 `"deny-all"`**(1926)。三元 `mode === "dontAsk" ? "deny-all" : "deny-all"` 两支相同 —— 写法冗余,疑似本想给 dontAsk 不同语义(如 approve-all?)但写错或语义已变。**值得确认 dontAsk 的预期行为。**

- ❓ **`runDreamLoop` 与主 `TurnLoop` 各写了一套 tool-call 循环**(1579 手搓 assistant/tool_result 拼接)。逻辑与 TurnLoop 的 dispatch 重复,容易随主循环演进而漂移(如 tool_result 结构、orphan 处理)。记录为重复实现风险。

- ❓ **`maxContextTokens` 解析三处默认值 200_000**(319 / 786 子 Engine / 1122 间接)。散落硬编码,无单一常量。
