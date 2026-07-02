# Session 累计缓存 usage(命中率 + 落盘 + 回显 + 切模型清零)— 方案

> 状态:方案稿(已核实代码,未改生产代码)。2026-07-02。
> 需求:桌面端 token 圆圈 hover 现在显示的是**单轮**缓存命中率(单轮看了没用)。改成
> **本会话累计**命中率;累计数据**和 session 绑定落盘 + resume 回显**(后续要出统计面板,
> 故存原始累计量、非百分比、留扩展余地);**切换模型时清零**(不同模型缓存独立)。

## 一、已核实的关键现状(带出处)

- **没有真正的 session 级累计**。`modelFacade`/`llmClient` 每次 `engine.run()` 新建
  (`engine.ts:1779` / `1530` `createLLMClient`),`LLMClientBase.recordUsage` 在**一个 run 内**
  跨轮 `+=`(`client-base.ts:64-72`),但**跨 run 重置**(新实例)。
- `session.state.tokenUsage` 每个 turn-boundary 被**覆盖**成当前 run 的累计
  (`engine.ts:2003-2010`,run 结束 `2181-2185` 再写一次),所以它反映的是**最新一个 run**,
  不是整会话累加;且**只写 prompt/completion/total,漏了 cacheRead/cacheCreation**。
- `TokenUsage` 类型(`core/src/types.ts:244`)已有可选 `cacheReadTokens?`/`cacheCreationTokens?`;
  `LLMUsageTracker`(`llm/types.ts:33`)只累计 prompt/completion/total,**无 cache 累计**。
- `switchModel`(`engine.ts:2407`)只换 `config.llm`;下个 run 新 client 天然从零,但
  `session.state.tokenUsage` 不清 → 跨模型残留。
- **renderer 收不到切模型信号**:`protocol/server.ts:995-1008` 只回 response,不广播事件;
  StreamEvent 无 `model_changed`。
- `session_started`(`engine.ts:1509`)只带粗估 `promptTokens`,renderer reducer
  (`renderer/types.ts:418`)**不初始化 cache 字段** → 切会话/切模型后残留旧值。
- 回显范式参照:goal 异步 RPC 回灌(`App.tsx:760-782` `goalGet` → 合成事件);
  落盘原子写(`session-manager.ts:283-295`);读回(`readActiveGoal:200-214`)。

## 二、设计决策

1. **累加放 session 生命周期层(engine + `session.state`),不放 client**。client 是 per-run
   的,天生不适合承载 session 累计。
2. **落盘存原始累计量,不存百分比**(统计面板要能算多种指标)。累计量:cacheRead /
   cacheCreation / prompt / completion / total / requestCount(命中率是展示层临时算)。
3. **切模型清零当前累计口径**(跨模型缓存无意义)。结构上给"按模型分段"留余地(统计面板
   以后可能要看各模型分别省了多少),但本期只做"切模型后累计归零"。
4. **回显走 goal 范式**(异步 RPC 回灌),core 为权威源,无两层不一致。
5. **UI**:tooltip 只显示"本会话累计命中率"(去掉单轮)。

## 三、落地(全按已核实的接线)

**A. core 累计缓存量**
- `LLMUsageTracker` 加 `totalCacheReadTokens`/`totalCacheCreationTokens`;`recordUsage` 里
  `+=`(每次真实 LLM response 一次,不受同轮多次 estimate emit 影响 → 不重复累加)。
- 加 `LLMClientBase.resetUsage()`(为清零备用)。

**B. session 累计(真累加)+ 落盘**
- 新增 `SessionState.cumulativeUsage`(或扩 `tokenUsage` 语义为"会话累计"):在 turn-boundary
  把当前 run 的 `getUsage()` **累加**进 session 累计(而非覆盖),含 cacheRead/cacheCreation。
  ⚠️ 关键:因 client 每 run 重置,累加口径要"上个已落盘累计 + 本 run 增量",避免同一 run 的
  多次 turn-boundary 重复累加(记录 `lastRunAccountedUsage`,只加 delta)。
- 落盘补齐 cacheRead/cacheCreation 字段(`engine.ts:2006`/`2181`)。

**C. 切模型清零**
- `switchModel` 里把 session 累计缓存归零 + 落盘 + 广播 `model_changed`。

**D. renderer 信号 + 回显**
- 新增 `model_changed` StreamEvent;`server.ts` 切模型成功后广播;reducer 收到清零
  cache 累计。
- `session_started` reducer 初始化 cache 累计为 0(修残留)。
- 加载时 goal 范式异步 `usageGet` 回灌 session 累计。
- localStorage 持久化 renderer 侧累计(切会话重置)。

**E. UI**
- `ContextRing` tooltip 用 session 累计算命中率,文案"本会话累计命中率"(zh+en)。

## 四、风险
- **重复累加**(同 run 多次 turn-boundary / 同轮多次 usage_update):累加只认 LLM-response
  级增量,turn-boundary 用 delta 不用绝对值。这是最大坑(类比 replay 时长漂移)。
- **切模型时序**:清零要在下一个 run 的 usage_update 之前生效,否则闪旧值。
- **cache 字段 undefined**:切到不支持缓存的模型返回 undefined,别把 undefined 当 0 覆盖
  掉已清零状态(清零后保持 0,新值来了再累加)。
