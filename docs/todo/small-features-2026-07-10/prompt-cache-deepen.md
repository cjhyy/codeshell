# Prompt cache 深化：prefix hash、破坏归因与粘性审计

> 体量：M  
> 范围：在现有缓存断点与 usage 采集之上增加可诊断性，并完成会话内可变项审计；不改变 provider 计费语义或公共 StreamEvent。  
> 基线：2026-07-10 当前工作树。

## 1. 问题与现状

### 1.1 已落地能力

- 既有设计文档的步骤 1-3 已完成，步骤 4“静态/动态分离、粘性锁定、破坏检测”仍待整体实现（`docs/todo/prompt-cache-optimization.md:80-94`，其中待办锚点仍准确为 `:91`）。
- OpenAI/OpenRouter 的 `cached_tokens` 和 Anthropic 的 cache read/create 已进入统一 `TokenUsage`，`ModelFacade` 日志会输出 usage 与单请求 hit rate（`packages/core/src/engine/model-facade.ts:28-38`、`:113-123`、`:185-195`）。
- TurnLoop 把 provider usage 转成单轮与 session cumulative cache 指标（`packages/core/src/engine/turn-loop.ts:532-594`）；Engine heartbeat 持久化累计 usage（`packages/core/src/engine/engine.ts:2080-2118`）。
- native Anthropic 在 system、最后一个 tool、最后一条 history message 上放断点：system 在 `packages/core/src/llm/providers/anthropic.ts:167-205`/`:216-243`，history 在 `:439-474`，tools 在 `:477-491`。
- Anthropic-over-OpenRouter 会在 system 与 history tail 上加断点（`packages/core/src/llm/providers/openai.ts:246-260`、`:944-995`）；其他 OpenAI-compatible 模型依赖 provider 自动缓存。
- PromptComposer 已把 skills、git status、memory、goal-tool guidance 放进尾部 dynamic context（`packages/core/src/prompt/composer.ts:144-177`）。TurnLoop 在 compaction 前剥离它、模型调用前再追加（`packages/core/src/engine/turn-loop.ts:429-443`、`:724-776`）。Engine 在跨 run 的 compacted cache 中也删除 user/dynamic context（`packages/core/src/engine/engine.ts:2228-2234`、`:2949-2961`）。

### 1.2 当前告警无法归因

- `TurnLoopDeps.recordCacheReadDiagnostics` 的签名只有 `(usage: TokenUsage) => void`（`packages/core/src/engine/turn-loop.ts:151-154`），`recordResponseUsage()` 也只把 usage 传给 Engine（`packages/core/src/engine/turn-loop.ts:532-535`）。调用方没有当次 system、tools 或有效 request config 的身份信息。
- Engine 仅维护 `Map<sessionId, number>` 的上次 cache read（`packages/core/src/engine/engine.ts:380-381`），跌落时只比较 token 数和固定阈值（`:2963-2985`）。日志 hint 同时列出 prefix、dynamic context、tool/schema 和 provider eviction，不能判断哪一项真实变化。
- 当前阈值是 previous ≥100、current ≤64、current/previous ≤0.1（`packages/core/src/engine/engine.ts:121-124`），现有测试只验证“1200 → 0 会告警”和 map 上限 256（`packages/core/src/engine/engine.prompt-cache.test.ts:256-335`）。本项不顺便改阈值，避免把“归因”与“灵敏度调参”混在一个变更。

### 1.3 prefix 的真实组成会在 session 中变化

system prompt 由 `PromptComposer.getSections()` 组成，包含 model/cwd/platform/shell、custom system、工具摘要、preset behavior、append prompt、language/user profile（`packages/core/src/prompt/composer.ts:193-286`）。effective tools 则在每次 `Engine.run()` 中按以下顺序重建：project builtin override、session MCP owner、builtin guard、feature flag、dynamic tool def、plan-mode allowlist（`packages/core/src/engine/engine.ts:1631-1712`）。runtime config 可在下一消息热更新 preset/prompt/personalization/MCP（`packages/core/src/settings/disk-defaults.ts:6-37`；应用点 `packages/core/src/engine/engine.ts:2671-2756`）。

因此 cache_read 下降既可能是 bug，也可能是用户有意切换 model/plan/preset/MCP。告警必须同时回答：

1. 是否仍在同一个 provider/model/endpoint cache scope；
2. system、tools、config 三段中哪些 hash 变化；
3. 如果三段均未变化，则把原因收窄到 history/userContext/compaction、TTL/provider eviction 或服务端策略，而不是继续给泛化提示。

### 1.4 当前“粘性”并非空白，但不是 session 级缓存策略

- OpenAI client 有 `_forceMaxCompletionTokens` 与 `_dropReasoningEffort` 两个响应 400 后的 sticky override（`packages/core/src/llm/providers/openai.ts:192-202`、`:1024-1064`），生命周期是单个 client。
- 主 LLM client 在每次 `Engine.run()` 重新创建（`packages/core/src/engine/engine.ts:1521-1523`），所以这些 provider 自校正不会跨一次用户消息延续。
- CodeShell 当前没有可热切的 prompt-cache TTL、cache enable、breakpoint layout、fast/afk cache mode 等设置。也就是说，现阶段不能为了“粘性”把所有会影响 prefix 的语义开关冻结；plan mode、权限收紧、Goal/MCP/feature flag 变化必须及时生效。

## 2. 目标

1. 每个主模型请求记录三个不可逆短 hash：`systemHash`、`toolsHash`、`configHash`，并带独立的 `cacheScopeHash`。
2. cache read 暴跌时输出结构化差异：`changedPrefixes`、previous/current hashes、scope、token 数和针对性 hint。
3. 同 provider/model/endpoint scope 才比较跌落；切模型/endpoint 只重置 baseline，不产生伪告警。
4. hash 计算确定、无 secret、低开销；不把 system prompt、tool schema、API key、header、base URL 明文写入日志或 state.json。
5. 完成所有 cache-key 相关动态项的粘性分类：哪些必须热生效、哪些天然 run-sticky、哪些未来若引入必须 session-lock。
6. 保持现有 cache breakpoint 数量、StreamEvent、session usage 持久化格式和阈值不变。

## 3. 详细修改方案

### 3.1 新增 `packages/core/src/engine/prompt-cache-diagnostics.ts`

#### 数据结构

```ts
export interface PromptPrefixFingerprint {
  version: 1;
  cacheScopeHash: string;
  systemHash: string;
  toolsHash: string;
  configHash: string;
}

export interface PromptCacheDiagnosticSample {
  usage: TokenUsage;
  fingerprint: PromptPrefixFingerprint;
  requestKind: "primary" | "continuation";
}

export interface PromptCacheDiagnosticState {
  cacheReadTokens: number;
  fingerprint: PromptPrefixFingerprint;
  sampledAtMs: number;
}

export type PromptPrefixPart = "system" | "tools" | "config";

export interface PromptCacheDropAttribution {
  changedPrefixes: PromptPrefixPart[];
  cause:
    | "system_changed"
    | "tools_changed"
    | "config_changed"
    | "multiple_prefixes_changed"
    | "no_tracked_prefix_change";
}
```

#### 纯函数

```ts
export function hashSystemPrompt(systemPrompt: string): string;
export function hashToolDefinitions(tools: readonly ToolDefinition[]): string;
export function diffPromptPrefix(
  previous: PromptPrefixFingerprint,
  current: PromptPrefixFingerprint,
): PromptCacheDropAttribution;
```

- hash 使用 HMAC-SHA-256，key 为进程启动时生成、仅驻内存的随机 diagnostic key，日志值截为 16 或 24 个 hex 字符。这里只需要同一进程内做相等性比较，不需要跨进程复现；HMAC 可降低低熵 prompt/config 被离线字典反推的风险。测试通过显式注入固定 key 保持确定性。版本字段防止未来 canonicalization 改变时把所有 session 误判为真实 prefix 变化。
- tool 数组顺序必须保留，因为 provider wire order 会影响 cache key；每个 tool 内对象键递归排序，避免等价 schema 仅因对象插入顺序不同而 hash 漂移。
- `undefined` 字段显式省略，数字/布尔/null 使用稳定 JSON；遇到 function/symbol 直接写类型占位，不调用用户自定义 `toJSON()`。
- 模块只返回 attribution，不直接 log，便于阈值与日志策略留在 Engine/controller。

### 3.2 `packages/core/src/llm/client-base.ts`

增加只返回已筛选 identity 的公开只读方法，避免上层访问 protected `config`；真正的 HMAC 统一在 diagnostics 模块生成：

```ts
getPromptCacheConfigIdentity(): Readonly<Record<string, unknown>>;
getPromptCacheScopeIdentity(): Readonly<Record<string, unknown>>;
```

基础 config hash 输入只包含会改变请求/cache 行为的字段：

- provider、providerKind、model；
- maxTokens、reasoning、reasoningSummary、serviceTier、extraBody；
- effective temperature、imageDetail；
- provider cache strategy/layout version。

scope identity 只表示 cache 命名空间：provider、providerKind、model、endpoint identity。endpoint 先删除 userinfo、query、fragment，再规范化 scheme/host/port/path；原始 `baseUrl` 绝不能输出明文。以下字段明确排除：`apiKey`、`authCommand`、`httpHeaders` 的名字和值、timeout、retryMaxAttempts。timeout/retry 不改变 prompt，凭证也不应成为 fingerprint 输入。

如果担心 `extraBody` 里混入凭证，先用 allowlist 提取 catalog 支持的 request-shape 字段（temperature/top_p/thinking/reasoning 等），不要直接 hash 任意对象。

### 3.3 provider-specific config identity

#### `packages/core/src/llm/providers/anthropic.ts`

覆盖/补充 config identity：

- `cacheStrategy: "anthropic-explicit"`；
- `cacheLayoutVersion: "system-tools-history-v1"`；
- effective reasoning/thinking kind和 budget 规则；
- system/tools/history breakpoint count（当前正常为 3）。

这不改变 `cache_control` 的现有位置（当前 `anthropic.ts:183-191`、`:439-490`），只让 config hash 能解释策略改变。

#### `packages/core/src/llm/providers/openai.ts`

config identity 增加：

- `cacheStrategy: isOpenRouterAnthropic ? "openrouter-anthropic-explicit" : "provider-automatic"`；
- breakpoint layout version；
- capability 的 token field/reasoning shape/rejected params；
- `_forceMaxCompletionTokens`、`_dropReasoningEffort` 的当前值。

fingerprint 必须在成功响应后读取，因此如果一次 400 自校正让 sticky flag 翻转，记录的是实际成功请求的 config，而不是首个失败尝试前的旧 config。现有 `openai-reasoning-effort-drop.test.ts` 已覆盖 flag 会在同一 client 内修正和保持，可在其上加 hash 变化/稳定断言。

### 3.4 `packages/core/src/engine/model-facade.ts`

新增：

```ts
getPromptPrefixFingerprint(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): PromptPrefixFingerprint;
```

它把 system/tools 与 client 提供的已筛选 config/scope identity 交给同一个带进程 key 的 fingerprinter。流式与非流式响应日志都增加：

```ts
promptPrefix: {
  version,
  cacheScopeHash,
  systemHash,
  toolsHash,
  configHash,
}
```

只记 hash，不把原始 prompt/schema/config复制到普通 info log。`recordLLMRequest()` 现有详细录制仍遵循自身 sanitize 规则；prefix diagnostic 不改变 recorder 格式。

### 3.5 `packages/core/src/engine/turn-loop.ts`

扩展 callback：

```ts
recordCacheReadDiagnostics?: (sample: PromptCacheDiagnosticSample) => void;
```

修改 usage 路径：

```ts
private recordResponseUsage(
  usage: NonNullable<LLMResponse["usage"]>,
  requestKind: "primary" | "continuation" = "primary",
): void {
  // existing current/cumulative usage
  this.deps.recordCacheReadDiagnostics?.({
    usage,
    requestKind,
    fingerprint: this.deps.model.getPromptPrefixFingerprint(
      this.deps.systemPrompt,
      this.deps.tools,
    ),
  });
}
```

- 主响应调用点是当前 `packages/core/src/engine/turn-loop.ts:840`；max-output continuation 调用点是 `:915-918`，后者传 `"continuation"`。
- streaming fallback 最终仍从 `callModelWithFallback()` 返回一次成功 response（`packages/core/src/engine/turn-loop.ts:1419-1505`），因此只产生一个成功 sample，不把失败的首请求当作 cache_read=0。
- max-turn 最终 summary 使用空 tools（`packages/core/src/engine/turn-loop.ts:1381-1389`），不进入跌落 baseline；否则“正常 tools → summary 无 tools”会制造必然的 toolsHash 变化和伪告警。
- `stripVolatileContextMessages()` 保持现状。它证明 dynamic context 不进入 compaction durable history，但 fingerprint 不为 messages history 做全量 hash，避免每轮新增消息都必然显示变化。

### 3.6 `packages/core/src/engine/engine.ts`

把：

```ts
private lastCacheReadBySid = new Map<string, number>();
```

替换为：

```ts
private promptCacheDiagnostics =
  new Map<string, PromptCacheDiagnosticState>();
```

`recordCacheReadDiagnostics(sessionId, sample)` 的逻辑：

1. cacheReadTokens 缺失/非有限值：忽略，不更新 baseline。
2. 取同 sid previous；若 `cacheScopeHash` 改变，写入新 baseline，并 debug 记录 `engine.cache_scope_changed`，不发 drop warning。
3. 同 scope 下更新 LRU；保持当前最多 256 session 的边界。
4. 使用现有阈值判断是否暴跌。
5. 暴跌时调用 `diffPromptPrefix()`，输出：

```ts
logger.warn("engine.cache_read_drop", {
  sessionId,
  previousCacheReadTokens,
  currentCacheReadTokens,
  dropRatio,
  cause,
  changedPrefixes,
  previousPrefix: previous.fingerprint,
  currentPrefix: sample.fingerprint,
  hint: specificHint(cause),
});
```

针对性 hint：

- `system_changed`：检查 cwd/model runtime header、preset、custom/append prompt、language/profile；
- `tools_changed`：检查 plan mode、builtin override、feature flag、MCP owner set、credential guard、dynamic schema/order；
- `config_changed`：检查 model reasoning/request-shape/provider cache strategy；
- `multiple_prefixes_changed`：列出实际变化段，不再猜单因；
- `no_tracked_prefix_change`：优先检查 provider TTL/eviction、history compaction、重新注入的 userContext/date/instructions，而不是 system/tools/config。

Engine 接线点（当前 `packages/core/src/engine/engine.ts:2023-2026`）把 sample 原样加 sid 后记录。若后续先实施 `split-engine-ts.md`，该 map/class 应直接放进 `prompt-cache-diagnostics.ts` 的有状态 recorder，由 Engine facade 持有实例，避免再把逻辑塞回门面。

### 3.7 `packages/core/src/prompt/composer.ts` 与 history 边界

本项不改变 `buildDynamicContextMessage()`；增加/强化注释与测试，明确：

- dynamicContext 不参与 systemHash，也不应留在下一 run history；
- `buildUserContextMessage()` 中的日期与 CODESHELL/CLAUDE/AGENTS 指令（`packages/core/src/prompt/composer.ts:75-100`）位于 messages 头部而非 wire system。它变化时三段 hash 可能都不变，但 history breakpoint 命中仍可能下降，因此归因必须使用 `no_tracked_prefix_change`，不能误报“provider eviction 已确定”。

若线上数据证明 userContext 是主要未归因来源，再单独增加 `historyHeadHash`；不要在第一版 hash 全量 messages，因为正常对话增长会令其每轮改变，失去诊断价值。

### 3.8 会话内动态开关粘性审计

#### 3.8.1 审计结论

| 可变项 | 进入哪一段 | 当前变化时机 | 是否 session 锁定 | 结论 |
|---|---|---|---|---|
| preset/custom/append/language/profile | system | settings hot reload 后下一消息 | 否 | 用户明确配置，必须热生效；hash 归因即可 |
| cwd/model runtime header | system | workspace/model 改变 | 否 | 语义上下文真实改变；model/endpoint 另开 scope |
| plan mode | tools | tool/host 可即时切换 | 否 | 安全与能力边界，冻结会让模型看见不该见的写工具 |
| permission mode | 间接影响 plan/tools、执行 gate | 可即时切换 | 否 | 权限收紧必须立即生效 |
| Goal active state | tools guard + volatile context | goal set/clear/met | 否 | 功能正确性要求及时显示/隐藏 complete/cancel tool |
| builtin capability override / feature flag | tools | 下一消息 | 否 | 用户显式能力开关；变化应归因为 tools |
| MCP server set / plugin disable | tools | reconcile 后下一消息 | 否 | 权限/数据源边界，不能为 cache 命中冻结 |
| credential/tool availability guard | tools | 凭证配置后下一消息 | 否 | 工具真实可用性变化，允许 prefix invalidation |
| skills/git/memory | trailing dynamic context | 每 run | 不适用 | 已放在缓存尾部并从 durable history 剥离 |
| Anthropic/OpenRouter cache strategy | config | 由 providerKind/model 决定 | 天然锁定到 client/scope | 当前无动态 UI 开关，无需新增锁 |
| `_forceMaxCompletionTokens` / `_dropReasoningEffort` | config request shape | provider 400 后 | 已 client-sticky | 纳入 config hash；是否跨 run 持久化属于 provider compatibility 优化，不在本项扩大 |
| future cache TTL/cache enable/layout experiment | config | 尚不存在 | **必须** | 一旦引入，首次 primary request 后锁到 `(sessionId, cacheScopeHash)`，只能在 scope 切换或新 session 重建 |

#### 3.8.2 本期是否新增 `SessionCachePolicyLock`

本期不新增无实际消费者的 lock。理由：现有所有会动态变化的 prefix 项都是语义/权限配置，强行锁定会产生错误或安全风险；真正只为缓存服务的 TTL/cache mode/layout toggle 目前不存在。以“审计表 + config identity + 测试”锁定这个结论，避免把“粘性”误实现成冻结整个 system/tools。

为未来预留接口规则：若新增缓存专用选项，必须先定义：

```ts
interface SessionPromptCachePolicy {
  strategy: "automatic" | "explicit";
  ttl?: "5m" | "1h";
  layoutVersion: string;
}
```

首次 primary request 后按 `(sessionId, cacheScopeHash)` 保存；后续同 scope 忽略 cache-only option 的热翻转并告警，model/provider/endpoint 变化则建立新 policy。该 policy 绝不能包含 plan mode、permission、MCP、Goal 或 tool visibility。

## 4. 分阶段实施顺序

1. **纯 fingerprint/attribution**：新增 diagnostics 模块和 canonical hash 单测，不接生产日志。
2. **LLM config/scope identity**：在 base/provider 实现无 secret 的 config/scope hash；覆盖 OpenAI sticky flags 与 Anthropic layout version。
3. **ModelFacade/TurnLoop 透传**：成功响应后生成 fingerprint，扩展 `recordCacheReadDiagnostics` sample；区分 primary/continuation，排除 max-turn summary。
4. **Engine recorder**：map value 改为 state，接 scope reset、LRU、差异归因和 specific hint；保留旧阈值。
5. **集成场景**：分别制造 system、tools、config、无追踪段变化，验证日志 cause；验证 model switch 不告警。
6. **粘性审计落文档/测试**：钉住 plan/permission/MCP/Goal 不得锁，cache-only future option 才使用 session policy。
7. **观察后调参**：上线日志观察 unknown 比例、hash 计算耗时和 warning 频率；阈值或 `historyHeadHash` 另开变更，不混入第一版。

## 5. 测试策略

### 5.1 新增 `packages/core/src/engine/prompt-cache-diagnostics.test.ts`

1. 相同 system 得到相同 hash，单字符变化得到不同 hash。
2. 等价 tool schema 的对象键顺序不同，toolsHash 相同。
3. tools 数组顺序变化，toolsHash 不同。
4. config 中 apiKey/httpHeaders/authCommand 不影响 configHash，也不出现在任何序列化中。
5. model/provider/endpoint identity 改变 cacheScopeHash。
6. `diffPromptPrefix` 分别返回 system/tools/config/multiple/none 五类。
7. cacheReadTokens 缺失不更新 baseline。
8. 同 scope 1200 → 0 触发归因；scope 变化 1200 → 0 只重置不告警。
9. LRU 超过 256 删除最老 sid。
10. hash version 变化视为诊断 schema reset，不误报真实 prefix change。

### 5.2 扩充 `packages/core/src/engine/cache-hit-rate.test.ts`

保留现有 hit-rate 数学用例（`packages/core/src/engine/cache-hit-rate.test.ts:8-48`）；新增仅需确认 fingerprint 字段不参与 usage 公式，避免 diagnostics 改写计费指标。

### 5.3 扩充 `packages/core/src/engine/turn-loop-usage-cache.test.ts`

1. primary response 的 callback 收到 usage + 三 hash + scope hash。
2. continuation 标为 `continuation` 且使用相同 system/tools/config fingerprint。
3. streaming fallback 只记录成功 fallback sample。
4. provider 未报告 cache token 时仍可写 `llm.request` hashes，但 Engine recorder不建立 cache-read baseline。
5. max-turn no-tools summary 不覆盖正常 primary baseline。

### 5.4 扩充 `packages/core/src/engine/engine.prompt-cache.test.ts`

在现有 hygiene 与 1200→0 告警测试（`:125-335`）上增加：

1. 修改 `customSystemPrompt` 后跌落，`changedPrefixes=["system"]`。
2. 切 plan mode或 builtin override 导致 tool list 变化后跌落，归因为 tools。
3. reasoning/request-shape 变化后跌落，归因为 config。
4. system + tools 同时变化，归因为 multiple。
5. 三 hash 相同的跌落，归因为 `no_tracked_prefix_change`，hint 提及 TTL/eviction/history/userContext。
6. 同 sid 切 model/endpoint，首次新 scope 不发 `engine.cache_read_drop`。
7. 日志对象不包含 prompt/tool schema/API key/header/baseUrl 明文。

### 5.5 provider 测试

- `anthropic-tools-cache.test.ts`、`anthropic-history-cache.test.ts`：继续验证断点位置，并新增 layout config hash 在相同 client 中稳定。
- `openai-reasoning-effort-drop.test.ts`：400 修正前后有效 config hash 变化，成功后后续调用保持同一 hash。
- `openai-openrouter-anthropic-cache.test.ts`：Anthropic slug 为 explicit strategy，普通 OpenAI/OpenRouter model 为 automatic strategy；二者 scope/config hash 不同。

### 5.6 PromptComposer 粘性/动态边界测试

扩充 `packages/core/src/prompt/composer-dynamic-context.test.ts`：

1. skills/git/memory/goal guidance 变化不改变 `buildSystemPrompt()` 输出 hash。
2. responseLanguage/userProfile/preset 变化会改变 system hash。
3. dynamic context 变化不被误标成 config change。
4. userContext/date/instruction 变化保持 system/tools/config hash不变，并由文档化的 unknown/history 分支处理。

实施完成后的建议定向命令（本文阶段不执行）：

```bash
bun test packages/core/src/engine/prompt-cache-diagnostics.test.ts
bun test packages/core/src/engine/turn-loop-usage-cache.test.ts
bun test packages/core/src/engine/engine.prompt-cache.test.ts
bun test packages/core/src/llm/providers/anthropic-tools-cache.test.ts
bun test packages/core/src/llm/providers/anthropic-history-cache.test.ts
bun test packages/core/src/llm/providers/openai-openrouter-anthropic-cache.test.ts
bun test packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts
```

## 6. 风险与兼容性注意

- **不要 hash secret**：HMAC 只是第二道保险。凭证字段仍应在 fingerprint identity 阶段完全排除，不是“先 HMAC 再认为安全”；进程 key 不落盘、不输出日志。
- **canonicalization 必须版本化**：算法变化会让所有 hash 变化。`version` 不同应重置 baseline，不应报三段同时破坏。
- **tools 顺序是语义**：对象键可排序，tools 数组不能排序。为了“稳定 hash”排序 tools 会掩盖真实 wire prefix 变化，也可能改变模型工具选择行为。
- **成功请求的 effective config**：provider sticky flag 可能在 retry 中翻转。读取过早会把失败 attempt 的 config 记到成功 usage，归因错误。
- **比较范围**：aux judge/tool summary/memory/compaction 请求不应与主 TurnLoop baseline 混用；requestKind 与 `recordUsage:false` 要继续隔离。
- **messages 未全量 hash**：这是有意选择。history 每轮增长，hash 它会总是变化。三段均不变只能说明“未发现 tracked prefix 变化”，不能断言 provider eviction。
- **userContext 仍可能破坏 history cache**：当前日期和项目指令在 messages 前部，且每 run 重建。第一版通过 unknown hint 暴露；不要误归为 systemHash。
- **权限优先于缓存**：plan、permission、tool disable、MCP/credential/Goal 变化不得被 session lock；一次 cache miss 比暴露错误工具或沿用过期指令更可接受。
- **scope 切换**：model 名相同但 endpoint/providerKind 不同也应视为新 scope；baseUrl 只参与 hash，不写日志明文。
- **内存边界**：继续限制 256 sid，state 只存数值和短 hash。无需写入 session state.json；进程重启后重新 warm baseline 即可。
- **日志兼容**：保留 `engine.cache_read_drop` 事件名与已有字段，新增字段为 additive；现有日志消费方不会因字段增加失效。
- **性能**：system/tool schema 通常每个 TurnLoop 固定，可在 TurnLoop 构造时预计算 system/tools hash；每响应只读取 config hash和拼 sample。不要每轮深拷贝 tools。
