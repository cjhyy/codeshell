# CodeShell Session 隔离 & 上下文装配 — 现状调研

> 目的:盘清"一个 worker 进程多 session 共存"时,哪些状态是 **session 私有**、哪些是 **全局单例**,
> 以及上下文(model / tools / skills / MCP / system prompt)在什么生命周期被装配。
> 用于对照其他 agent 实现(Claude Code / Codex / Cline 等)如何做 session 隔离,再定修复方案。
>
> 触发问题:多 session 下切换模型,DeepSeek 的 `maxOutputTokens=384000` 残留到直连 OpenAI `gpt-5.5`,
> 报 400 `max_tokens is too large: 384000 ... at most 128000` → 重试耗尽 → `model_error`。

状态:**已诊断,未改动任何代码**(`git diff --stat` 对相关文件为空)。

---

## 1. 进程 / Session 拓扑

- 单个 worker 进程跑所有 session(`packages/core/src/cli/agent-server-stdio.ts`)。
- `ChatSessionManager`:`maxSessions: 16`,`idleTtlMs: 30min`,带 idle sweeper。
- 每个 session 一个 `Engine` 实例,但 Engine 通过 `config.runtime?.X ?? new X()` **优先复用全局单例**。

### 全局单例(seedEngine 抽出 → 塞进 runtime,所有 session 共享)

`agent-server-stdio.ts:75-111`:

| 单例 | 出处 | 共享范围 | 串台风险 |
|---|---|---|---|
| `modelPool`(含 `activeKey`) | `seedEngine.getModelPool()` (75) | 🔴 全 worker | **高 — 已确诊** |
| `toolRegistry` | `seedEngine.getToolRegistry()` (76) | 🔴 全 worker | 中 |
| `mcpPool`(MCP 连接池) | `new MCPManager(toolRegistry)` (96) | 🔴 全 worker | 中 |
| `costTracker` | `new CostTracker()` (102) | 🔴 全 worker | 低(代码注释已标 `Future work: per-session`) |

---

## 2. 上下文装配生命周期

统一边界是 **per-run**(= 一条用户消息 = `TurnLoop` 最多 100 turn 的循环,`turn-loop.ts:234`)。
**不是 per-turn,也不是 session 启动时定死。** 一条消息内部所有 turn 复用同一份装配。

| 成分 | 何时计算 | 代码 | 源是否全局 |
|---|---|---|---|
| system prompt | 每次 run 重算 | `engine.ts:1177` | session 私有 ✅ |
| system context(git/env) | 每次 run 重算 | `engine.ts:1178` | session 私有 ✅ |
| tools 列表 | 每次 run 快照 | `engine.ts:1151` `getToolDefinitions()` | 🔴 读全局 `toolRegistry` |
| skills(disabledSkills/Plugins) | 每次 run 重算 | `engine.ts:1121` `readDisabledLists()` (读 settings.json) | per-session 配置 + 磁盘 |
| model | run 入口锁定 | `engine.ts:1124` 读 `this.config.llm` | 🔴 派生自全局 `activeKey` |
| MCP 连接 | 首 run 连、之后复用 | `engine.ts:1138-1144` | 🔴 全局 `runtime.mcpPool` |
| `llmClient`(maxTokens 等) | run 入口建,`readonly` 锁死 | `engine.ts:1083` / `client-base.ts:13,47` | run 内固定 ✅ |

要点:**per-run 重算本身是好设计**(改 skills 开关 / 装新 MCP,下条消息即生效,无需重启 session)。
问题出在:重算时读取的若干"源"是 worker 全局的(`activeKey` / `toolRegistry` / `mcpPool`),于是 session 间串台。

---

## 3. configure 的 per-session vs 全局(关键发现)

`server.ts:450 handleConfigure`:

```
if (typeof params.sessionId === "string") {   // ← per-session 分支 (454)
    planMode      → s.engine.setPlanMode()        ✅ per-session
    permissionMode→ s.engine.setPermissionMode()  ✅ per-session
    // model ——  ❌ 这里没有！
}
// 否则 → Global configure 分支 (471)
    model → engine.switchModel()  // 作用于全局 modelPool ❌
```

**核心矛盾:planMode / permissionMode 已经做到 per-session,唯独 `model` 被遗留在全局分支。**
而前端切模型 `App.tsx:971` 调 `configure({ model: opt.key })` **不带 sessionId** → 必然落入全局分支
→ session A 切模型改全局 `activeKey` → 污染 session B。

`types.ts:136` 注释:`When present, configure that specific chat session. Otherwise worker-global.`
→ 协议层早已预留 per-session configure,model 只是没接上。

---

## 4. 已确诊 Bug 链

### 4.1 model 全局串台(根因)
- `configure({model})` 无 sessionId → 全局 `switchModel` → 改全局 `activeKey`。
- 日志实证(session `s-mppq7m94-ce0e2ba5`):同一时刻 `engine.run model: deepseek-v4-flash` 与
  `llm.request model: gpt-5.5` 并存 → 两 session 共享一个 activeKey,run 标签与实际 client 错位。

### 4.2 switchModel 无 run-state 防护
- `engine.ts:1684 switchModel` 内无 `isRunning/busy` 判断 → 切换可越过 run 边界。
- 决策:**run 进行中切换 → 等本 run 结束再生效**(挂起,不动正在跑的 client)。

### 4.3 maxTokens 残留 → 384000
- `client-base.ts:47`:`this.maxTokens = config.maxTokens ?? 8192`,且 `maxTokens` 为 `readonly`。
- `switchModel`(`engine.ts:1690`)只换 `this.config.llm`,**不重建已实例化的 `llmClient`**;
  `llmClient` 是 `run()` 的局部变量(`engine.ts:1083`),constructor 时把旧模型上限定死。
- `384000` 来源:DeepSeek V4(`data/deepseek-models.json`、`data/openrouter-models.json:421/433`
  `deepseek/deepseek-v4-pro|flash`)。gpt-5.5 自身在快照里是正确的 `128000`,且 entry 未填
  `maxOutputTokens`(`withBuiltinDefaults` 只填 context,不填 output)→ 本应解析为 8192/undefined。
- 结果:直连 OpenAI gpt-5.5 收到 `max_tokens: 384000` → 400 → 重试 3 次 `llm.exhausted` → `model_error`。
- 现有自愈分支(`openai.ts:690-696`)只处理"字段选错"(`max_tokens` vs `max_completion_tokens`),
  **不覆盖**"值太大"。
- 决策:**新模型查不到 maxOutputTokens → 不发 max_tokens 字段**(让端点用自身默认上限)。
  注意 anthropic 侧 `max_tokens` 必填,需保留保守默认。

### 4.4 前端 busy 信号不可靠(次要)
- `ChatView.tsx:566` `<ModelPill disabled={busy}>`,`busy = busyKeys.has(activeBucket)`(`App.tsx:188`)
  只反映前台 session;并发 / 跨 session / busy 漏清时药丸误解禁。
- `App.tsx:477-516` 一堆 `runningBucketRef` vs `bucket` 对账注释,印证并发 / 错位历史包袱。

---

## 5. 同模型上的其他 per-model 残留状态(同 4.3 机理,尚未爆出)

`llmClient` / OpenAI provider 上挂着的 per-model 状态,在"换 config 不换实例"时同样残留:

| 字段 | 应随模型切换重置 | 现状 |
|---|---|---|
| `maxTokens`(readonly, `client-base.ts:13`) | 是 | ❌ 残留 → 384000 |
| `_capability`(缓存, `openai.ts:143`) | 是(gpt-5.5 vs deepseek 请求 shape 不同) | ❌ 残留 |
| `_forceMaxCompletionTokens`(sticky, `openai.ts:115`) | 是(为某模型 400 学到的) | ❌ 残留 |
| `_client`(OpenAI SDK 实例, `openai.ts:110`) | baseUrl/apiKey 变则换 | ❌ 残留 |
| temperature/timeout/retryMaxAttempts/imageDetail | **否**(跨模型用户偏好) | ✅ 正确保留(在 clientDefaults) |

→ 印证"切换=全新模型"应**整体重建 client**,而非逐字段重置(易漏)。

---

## 6. 待定的修复方向(分层,供调研后定夺)

1. **架构层(治本)**:model 选择 per-session 化 —— `configure({model, sessionId})` 进 per-session 分支,
   activeKey 归 session 私有(planMode/permissionMode 的现成模式)。可保留全局默认供新 session 派生。
2. **后端闸**:`switchModel` 加 run-state 判断,run 进行中挂起(pending),run 结束 flush。
3. **请求兜底**:`maxTokens` 全链可缺省(去掉 `?? 8192`),缺省时省略 `max_tokens` 字段(anthropic 侧留默认);
   切换时整体重建 client 而非改字段。
4. **前端**:让 ModelPill 禁用更可靠 / 不只依赖前端 busy(后端已有闸时可降级为体验优化)。

> 修复不能只靠前端 `disabled`:并发 / 跨 session / busy 漏清时前端信号不准,后端必须有独立防线。

---

## 7. 调研其他实现时关注点(对照清单)

- **Session 隔离粒度**:每 session 独立 model/tools/MCP,还是共享池 + per-session 视图(overlay)?
- **模型切换语义**:run 进行中切换 → 拒绝 / 挂起 / 即时重建?切换是 per-session 还是全局?
- **per-model 运行时状态**:换模型时整体重建 client,还是复用 + reset?如何避免 sticky flag / capability 残留?
- **max_tokens 处理**:不填时省略字段,还是按模型 cap 钳制?目录值与端点真实上限不一致时怎么兜底?
- **共享连接池(MCP / tools)**:多 session 如何共享底层连接又隔离"可用能力"视图?
- **上下文装配时机**:per-session 定死 / per-run 重算 / per-turn 实时?权衡是什么?

---

## 8. 对照调研结论:Codex / Claude Code / OpenCode

> 方法:对三个 agent 实现做源码级核对(Codex `openai/codex` Rust、OpenCode `sst/opencode` TS 均为开源逐字核验;
> Claude Code 取本地 bundle `…/claude-code-sourcemap/package/cli.js` v2.1.88,符号已逆向确认)。
> 标记:【高】= 源码/bundle 逐字 confirmed;逆向推测与未证实项见 §8.5。

### 8.1 对照矩阵

| 对照点 | OpenAI Codex (Rust) | Claude Code (闭源 bundle) | OpenCode (TS) |
|---|---|---|---|
| **1. 隔离粒度** | 每 session 独立持有 `ModelClient`(值类型)+ MCP manager;模型目录跨 session 共享【高】 | 单进程多 agent;进程级单例 `G8` + per-context overlay【高】 | 单进程多 session;model/SDK/MCP 全是进程级**共享池**,session 只存引用三元组【高】 |
| **2. 切换语义** | per-session 写 `collaboration_mode`,**turn 边界生效**,不打断当前 turn【高】 | 写 `mainLoopModelForSession`(per-session)+ `mainLoopModelOverride`(全局),下一查询生效【高】 | per-turn 重解析;切换=下轮生效;run 中并发新 run 被 `BusyError` 拒【高】 |
| **3. per-model 状态** | **不重建**;client 去模型化,状态外置到 per-turn `TurnContext.model_info`【高】 | **每次查询整体重建 client**(`eE()`),仅重试间复用【高】 | **不重建**;按 `providerID/modelID` 缓存不可变实例,换模型=换 key【高】 |
| **4. max_tokens** | 主请求体**根本无该字段** = 永远省略,交服务端默认【高】 | **从不省略**,落 per-model `default`;env 超限钳到 `upperLimit`;目录值覆盖硬编码上限【高】 | prepare 层**钳成具体值** `Math.min(limit.output, 32000)`;仅最底层全 undefined 才省略【高】 |
| **5. 共享池 / 视图** | MCP per-session 连接 + per-turn `ToolRouter` 过滤能力视图【高】 | MCP 进程级共享数组 `mcpClients`(按引用)+ per-agent `options.tools` 过滤【高】 | MCP 进程级共享 `s.clients` + per-turn `SessionTools.resolve` + 执行时 permission 隔离【中-高】 |
| **6. 装配时机** | per-turn 实时(`build_prompt`)【高】 | per-turn 实时(`YFK` 生成器),靠 prompt cache 抵消【高】 | per-turn 实时(`runLoop`),靠进程级资源缓存抵消【高】 |
| **7. 三方向判定** | A 正例 / B 反例(不必要) / C 正例 | A 部分支持 / **B 正例** / C 反例 | A 部分支持 / B 反例 / C 反例 |

### 8.2 三个关键发现(直接对应 §4 的 bug)

**① per-model 运行时状态 —— 三家都不做"复用 client + reset 字段",而本项目的 bug(§4.3/§5)正是这种模式的产物。** 三种根治法:
- **Codex:client 去模型化** —— `ModelClient` 不存 model_family/capability,`model`/`verbosity`/`reasoning` 每次请求从传入的 `model_info` 现取;`TurnContext` 根本不持有 client 字段,故"无从残留"。(`core/src/client.rs`、`turn_context.rs`)
- **Claude Code:整体重建** —— `eE({model,...})` 每次查询新建实例,只在重试间复用,无按 model 缓存 client 的 Map。(对应方向 B)
- **OpenCode:per-key 不可变实例** —— `getLanguage` 以 `${providerID}/${id}` 为 key 缓存,换模型=换 key 拿独立实例,永不原地改字段。(`provider/provider.ts`)

**② max_tokens —— 本项目 384000 致命是因为用全局变量携带它。** Codex 是方向 C 直接正例(请求体连字段都没有);Claude Code / OpenCode 则用 per-model `{default, upperLimit}` 表 + `min(目录值, 该模型上限)`,目录缺失走该模型默认而非沿用上一个模型的值。**铁律:这个值必须 per-model 现算,绝不跨模型沿用一个全局变量。**

**③ 切换语义 —— 三家一致"切换=写一个 per-session 字段 + 下个请求读取",不去改正在用的 client。** 天然避免"切到一半、旧值残留",印证 §4.2 的"挂起到 run 边界"决策方向。

### 8.3 对 §6 三个修复方向的判定

- **方向 1 / A(model per-session 化)—— 正确,Codex 强正例。** 与本项目已有的 `planMode`/`permissionMode` per-session 模式(§3)完全对齐,直接把 `model`/`activeKey` 加进同一 per-session 状态容器。可学 Claude Code 保留全局默认兜底,但 session 值优先。
- **方向 3 / B(切换整体重建 client)—— 能解决但非唯一/最省解。** 三家中只有 Claude Code 是正例;Codex、OpenCode 都刻意**不重建**,而是把 per-model 状态从 client 上剥离。若 `llmClient` 重建成本低则重建最直接,成本高则"去模型化"(Codex)或"per-model 缓存实例"(OpenCode)更治本。
- **方向 3 / C(查不到就省略 max_tokens)—— 可行,Codex 直接正例。** 拿不到可信目录值时,省略比沿用错误全局值安全。更稳的变体是 per-model `{default, upperLimit}` 钳制表(Claude Code / OpenCode 共识)。

### 8.4 可落地建议(按优先级,对齐已有 per-session 模式)

1. **【立即止血】方向 C:max_tokens 查不到就省略字段** —— 消除当前 400 最快的改动(注意 anthropic 侧 `max_tokens` 必填,需保留保守默认,见 §4.3)。
2. **【根因】方向 A:`model`/`activeKey` 进现有 per-session 状态容器** —— 复用 `planMode`/`permissionMode` 实现路径(§3),让 model 不再是全局单例。
3. **【去毒】让 per-model 字段不再挂在长寿对象上** —— client 廉价则整体重建(B);昂贵则去模型化(Codex)或 per-(provider,model) 缓存实例(OpenCode)。**核心铁律:绝不原地修改正在复用的 client 的 per-model 字段**(=本 bug §4.3/§5 来源)。
4. **【装配时机】把 model / max_tokens 移到 per-turn 装配阶段现算** —— 三家一致 per-turn 装配,从结构上杜绝"装配过早 + 结果全局可变"。
5. **【长期】维护 per-model `{default, upperLimit}` 表,发送前 `min(目录值, 该模型上限)`** —— 第 1 条止血后的完整升级。
6. **【验证】加回归测试:DeepSeek(384000)→ gpt-5.5,断言请求里 max_tokens 要么省略、要么 ≤ gpt-5.5 上限** —— 对应 Codex `model_switching.rs` 测试范式。

### 8.5 证据可信度声明

- **可直接采信(confirmed)**:§8.1 所有【高】结构性论断。
- **逆向推测(非事实)**:Claude Code"run 中途切换不影响进行中请求""per-turn 装配的权衡" —— 基于代码结构推断。
- **审稿降级 / 未证实**:OpenCode 模型解析优先级的**确切顺序**(上下文相关,勿照搬固定链)、native registry 是否按 agent allowlist 过滤;Codex 非 `/responses` 第三方 provider 是否别处设 max_tokens(**若要覆盖非主路径 provider,方向 C 需对该 provider 另行核对**);Claude Code 完整 per-model max_tokens 表仅抽验 opus/sonnet 头部。

**核对用文件路径**:
- Claude Code bundle:`…/claude-code-sourcemap/package/cli.js`(符号 `eE`/`dk8`/`Z18`/`t86`/`GK6`/`G8`/`Vj7`)
- Codex:`openai/codex` → `codex-rs/core/src/client.rs`、`session/session.rs`、`codex-api/src/common.rs`、`protocol/src/openai_models.rs`
- OpenCode:`sst/opencode` → `packages/opencode/src/provider/provider.ts`、`provider/transform.ts`、`session/llm/request.ts`、`session/session.ts`
