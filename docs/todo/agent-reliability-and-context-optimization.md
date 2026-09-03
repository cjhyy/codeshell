# Agent 可靠性、缓存与上下文优化方案

> 状态：设计稿，待排期。2026-09-03 基于 Session `s-mtl8jf6s-57bdc5ab` 的日志、Transcript、当前安装包和源码交叉审计。
>
> 目标：同时解决 Prompt 缓存利用率低、Agent 初始负载偏大、能力选择错误、同类操作反复失败和外部写入缺少可靠验收的问题。

## 一、结论

本次事故不是单一模型质量问题，也不是单纯的缓存问题。缓存低命中和操作失误有共同的系统根因：

1. 每轮向模型暴露过多、过动态的工具和 Skill 信息；
2. 能力发现、账号选择、工具路由、重试、事务状态和业务验收主要由模型自行维护；
3. 系统已有权限、路径、重复读取、轮次上限和 Stop Hook 等保护，但缺少针对工具错误的分类重试、熔断、幂等执行和强制回读验收；
4. 已完成的缓存优化没有进入当前运行的安装包，导致日志仍表现为旧缓存策略。

因此，修复顺序必须是：

1. 先解决发布身份和缓存线上验收；
2. 再把能力解析、执行状态机、错误策略和验收下沉到宿主；
3. 然后缩减初始工具与 Skill 上下文；
4. 最后再评估 Responses API、模型和 reasoning effort。

不要先通过更换模型掩盖执行层缺陷。

## 二、事故证据

### 2.1 Session 指标

Session：`s-mtl8jf6s-57bdc5ab`

数据来源：

- `~/.code-shell/sessions/s-mtl8jf6s-57bdc5ab/transcript.jsonl`
- `~/.code-shell/logs/engine-2026-09-03.log`

最终统计：

| 指标                                |          结果 |
| ----------------------------------- | ------------: |
| 主模型调用                          |         91 次 |
| Prompt Tokens                       |     6,224,943 |
| Completion Tokens                   |        19,800 |
| Cache Read Tokens                   |     2,778,120 |
| Cache Write Tokens                  |     3,446,550 |
| 累计缓存命中率                      |        44.63% |
| 首轮 Prompt                         | 48,696 tokens |
| 最大 Prompt                         | 80,703 tokens |
| 工具调用                            |         92 次 |
| 工具失败                            |         11 次 |
| TaskGuard stale 提醒                |         27 次 |
| InvestigationGuard silent-turn 提醒 |          9 次 |

工具失败分布：

| 工具               | 失败次数 |
| ------------------ | -------: |
| `Bash`             |        4 |
| `browser_act`      |        4 |
| `browser_observe`  |        2 |
| `browser_navigate` |        1 |

浏览器调用量：

| 工具               | 调用次数 |
| ------------------ | -------: |
| `browser_act`      |       37 |
| `browser_observe`  |       21 |
| `browser_navigate` |        5 |

### 2.2 缓存异常

首轮缓存读取为 0；第二轮起，主模型的 `cacheReadTokens` 始终固定为 `30,868`，即使 Prompt 从约 49K 增长到约 80K，也没有继续增长。

同时，整个 Session 的下列指纹保持稳定：

- `cacheScopeHash`
- `systemHash`
- `toolsHash`
- `configHash`

这说明旧运行时只复用了固定前缀，新增历史不断进入 Cache Write。现有 `PromptCacheDiagnosticRecorder` 只检测缓存读取从较高值突然跌到接近 0，不能识别“缓存读取长期不增长”的平台期。

### 2.3 操作失误

本次事故包括：

1. 已存在 GitHub 登录能力，但 Agent 两次要求用户重新登录；
2. `LinkAction`、`UseCredential`、本地 `gh` 和浏览器登录态互相独立，模型需要手工推断哪条链路可用；
3. 截图识别错两个仓库名，执行后才通过搜索纠正；
4. Shell 使用 zsh 保留变量，命令在可能已产生部分副作用后失败；
5. GitHub CLI 搜索使用不支持的字段；
6. 浏览器 Snapshot、Vision、Act 和 Navigate 多次超时；
7. 飞书 Canvas 表格多次返回“Typed/Clicked”，但第 13 行没有真正落盘；
8. 未预检 macOS 辅助功能权限就调用 `osascript`，被系统拒绝；
9. 同一飞书写入目标连续尝试多种键盘策略，没有系统级错误预算和熔断；
10. 最终通过截图发现未写入，没有虚报完成；这部分验证行为应固化到系统，而不是依赖模型临场判断。

## 三、版本与发布状态

Prompt 缓存优化已经 Commit：

- Commit：`3d24a6d5 perf(core): unify model prompt caching`
- 当前本地 `main` 比 `origin/main` 超前 14 个提交；
- 远端分支不包含该缓存提交；
- 当前安装并运行的版本是 `0.9.3`；
- 当前 `/Applications/code-shell.app/Contents/Resources/app.asar` 早于该提交。

所以本次日志测试的是旧版，不能用来否定 `3d24a6d5` 的新缓存实现。当前准确状态是：

> 代码已 Commit，但尚未 Push、发布、安装和重启验收。

新缓存实现位置：

- `packages/core/src/llm/prompt-cache.ts`
- `packages/core/src/llm/providers/openai.ts`
- `docs/todo/prompt-cache-optimization.md`

## 四、问题清单与优先级

| 优先级 | 问题                                | 当前情况                                     | 目标状态                                           |
| ------ | ----------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| P0     | 发布身份不可验证                    | 日志不能证明运行的是哪个 Commit              | 每个 Session 记录版本、Git SHA、构建时间和缓存策略 |
| P0     | 新缓存未在线运行                    | 本地代码已改，安装包仍是 0.9.3               | 发布新包并用真实长会话验收                         |
| P0     | 能力和账号路由分裂                  | Link、Credential、CLI、Browser 各自发现      | 宿主统一解析并选定执行通道                         |
| P0     | 缺少错误类型熔断                    | 主要依赖最多 30 轮限制                       | 按错误类别决定重试、换策略或立即停止               |
| P0     | 外部写入没有事务                    | OCR、执行和验证混在模型循环                  | 固定的预检、验证、执行、回读状态机                 |
| P0     | 工具成功不等于业务成功              | `Typed`、`Clicked` 被当作阶段性成功          | 写工具必须返回独立验证结果                         |
| P1     | 初始工具负载过大                    | 单轮发送 61 个工具定义                       | 普通任务只暴露 8–15 个相关工具                     |
| P1     | Skill 索引没有预算                  | 109 个 Skill 描述全量进入动态上下文          | 预算化排序，低优先级只显示名称                     |
| P1     | 动态目录进入工具定义                | 会话 ID、标题、凭证名进入 description/schema | 改成按需目录查询，保持工具定义稳定                 |
| P1     | 工具描述重复                        | System Prompt 和 API `tools` 同时携带描述    | System Prompt 只保留分类/全局策略                  |
| P1     | UI 自动化承担语义写入               | GitHub Star、飞书表格依赖浏览器/键盘         | 优先使用幂等语义工具，浏览器只做兜底               |
| P1     | Todo 状态由模型维护                 | TaskGuard 每三轮重复催促                     | 宿主根据 Operation 状态自动投影进度                |
| P1     | 缺少事故回放评测                    | 只能人工看日志                               | 将本 Session 固化为 Replay Eval 和发布门禁         |
| P2     | GPT 工具工作流仍是 Chat Completions | 手工维护历史与工具循环                       | 稳定后迁移 Responses API 和 persisted reasoning    |

## 五、P0：发布身份与缓存验收

### 5.1 构建身份

每次应用启动和每个 Session 首次运行必须记录：

```ts
interface RuntimeBuildIdentity {
  appVersion: string;
  gitSha: string;
  builtAt: string;
  dirty: boolean;
  provider: string;
  model: string;
  cacheStrategy: string;
  cacheLayoutVersion: string;
}
```

要求：

1. Desktop About、Session metadata 和引擎日志使用同一份构建身份；
2. 发布构建必须包含不可变 Git SHA；
3. Smoke Test 必须断言启动日志中的 SHA 与待发布 Commit 一致；
4. 不再通过文件时间或人工推断运行版本。

### 5.2 真实网关契约测试

对 GPT-5.6/OpenRouter 增加真实请求形状和兼容性验收：

1. 验证 `prompt_cache_key`；
2. 验证 `prompt_cache_options`；
3. 验证 system/stable-history/rolling-history 断点；
4. 验证网关 400 时的粘性降级；
5. 记录最终生效的是 `openai-explicit` 还是 fallback；
6. 验证相邻请求的缓存读取随历史增长。

### 5.3 缓存平台期检测

在现有 `engine.cache_read_drop` 之外增加 `engine.cache_read_plateau`：

```ts
interface CacheProgressSample {
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stablePrefixMessageCount: number;
  rollingBreakpointMessageIndex: number;
}
```

初始判定规则：

- 指纹和缓存作用域不变；
- Prompt 连续三轮累计增长超过 2,000 tokens；
- `cacheReadTokens` 连续三轮增长不超过 128 tokens；
- 记录当前策略、断点位置、网关和 fallback 状态。

该事件先作为诊断告警，不自动切换缓存策略。

## 六、P0：统一 Capability Resolver

### 6.1 问题

现在模型必须分别检查：

- `LinkAction`
- `UseCredential`
- 本地 CLI 认证状态
- MCP/App Connector
- Browser Runtime 登录态

这导致“浏览器未登录”被错误推导为“用户没有 GitHub 凭证”。

### 6.2 目标接口

新增宿主拥有的统一解析服务：

```ts
interface ResolveCapabilityRequest {
  service: string;
  intent: string;
  risk: "read" | "write";
}

interface ResolvedCapability {
  status: "ready" | "approval_required" | "unsupported" | "unhealthy";
  channel: "link" | "mcp" | "cli" | "browser";
  account?: string;
  supportedActions: string[];
  health?: string;
  reason?: string;
}
```

默认选择优先级：

1. 幂等语义 Link/本地 API；
2. 结构化 MCP/App Connector；
3. 有明确认证状态的 CLI；
4. Browser Runtime；
5. OS 级键鼠自动化只允许作为经过预检的最后兜底。

解析结果应在同一 Run 内保持粘性。只要目标服务和 Intent 不变，不允许模型反复发现账号或要求重新登录。

### 6.3 需要补齐的语义动作

GitHub：

- `get_repository`
- `get_starred`
- `set_starred({ owner, repo, starred, idempotencyKey })`
- `batch_set_starred(...)`

飞书表格：

- `resolve_table`
- `read_rows`
- `append_row`
- `update_cell`
- `verify_row`

所有 Write Action 必须继续走现有审批链，不能绕过 `ToolExecutor`、权限和 Hook。

## 七、P0：Operation Controller 与事务状态机

### 7.1 固定执行阶段

复杂外部操作统一使用以下阶段：

```text
DISCOVER
  → PREFLIGHT
  → VALIDATE
  → PLAN
  → EXECUTE
  → VERIFY
  → COMPLETE | BLOCKED
```

阶段职责：

- `DISCOVER`：解析账号、工具和目标；
- `PREFLIGHT`：检查认证、权限、命令、运行时和 OS 能力；
- `VALIDATE`：将 OCR/用户输入规范化并通过只读接口逐项确认；
- `PLAN`：生成明确的待执行目标和后置条件；
- `EXECUTE`：按幂等键执行；
- `VERIFY`：通过独立读取确认最终状态；
- `COMPLETE`：所有后置条件成立；
- `BLOCKED`：返回结构化阻塞原因，不继续碰运气。

### 7.2 操作账本

```ts
interface OperationRecord {
  operationId: string;
  idempotencyKey: string;
  target: string;
  action: string;
  status: "planned" | "running" | "succeeded" | "verified" | "failed";
  attempt: number;
  channel: string;
  errorClass?: string;
  verification?: unknown;
}
```

要求：

1. 写操作开始前落 `planned`；
2. 成功返回后只能进入 `succeeded`；
3. 独立回读通过后才能进入 `verified`；
4. 重试前查账本，禁止重复执行已 `verified` 的目标；
5. 最终回答只能把 `verified` 项列为完成；
6. 批量操作返回每个目标的独立状态，不能只返回整体布尔值。

## 八、P0：错误分类、重试与熔断

### 8.1 错误指纹

```ts
interface ToolErrorFingerprint {
  tool: string;
  operationClass: string;
  target?: string;
  errorClass: string;
  normalizedCode?: string;
  normalizedMessage: string;
}
```

### 8.2 错误类别

| 类别                   | 示例                     | 策略                                     |
| ---------------------- | ------------------------ | ---------------------------------------- |
| `transient`            | 网络抖动、一次性 5xx     | 同策略最多重试 2 次，指数退避            |
| `stale_reference`      | Browser ref 过期         | 重新 Observe 一次后重试                  |
| `validation`           | CLI 字段错误、目标不存在 | 不重试；修正输入或回到 VALIDATE          |
| `authentication`       | Token 失效               | 重新 ResolveCapability，不直接要求登录   |
| `permission`           | macOS 辅助功能拒绝       | 不重试同一通道；标记通道不可用           |
| `unsupported`          | Link 没有 Star 动作      | 不重试；选择下一语义通道                 |
| `postcondition_failed` | 工具称已输入但回读为空   | 不重复相同动作；换一次策略后停止         |
| `poll_pending`         | 后台任务仍在运行         | 使用声明式 Poll 策略，不参与普通重复熔断 |

### 8.3 默认预算

- 相同错误指纹最多出现 2 次；
- 同一目标最多切换 2 种执行策略；
- Browser Runtime 最多重启 1 次；
- 非 Poll 工具的重复调用不能只依赖 `maxTurns=30`；
- 达到预算后必须返回结构化 Blocker；
- Poll/Monitor 工具必须显式声明 `operationClass: "poll"` 和停止条件，避免误伤合法等待。

现有 `pre_tool_use`、`post_tool_use`、`on_tool_start`、`on_tool_end` 和 `on_stop` Hook 已可复用，不需要重新设计 Hook 框架。缺失的是建立在 Hook/Executor 上的错误控制器与操作账本。

## 九、P0：输入校验、幂等与强制验收

### 9.1 OCR/截图输入

截图解析结果必须输出结构化候选：

```ts
interface ExtractedRepositoryCandidate {
  rawText: string;
  owner?: string;
  repo?: string;
  confidence: number;
  sourceRegion?: string;
}
```

执行前：

1. 规范化空格、大小写、URL 和 owner/repo；
2. 通过只读 GitHub API 验证全部候选；
3. 对不匹配项执行搜索和描述比对；
4. 仍无法确认的目标必须留在 unresolved；
5. 批量中存在 unresolved 时默认零写入，除非产品明确支持部分执行并向用户展示清单。

### 9.2 Shell 兜底

只有没有语义工具时才使用 Shell。执行前必须完成：

- `command -v`/版本检查；
- 认证状态检查；
- 参数和字段能力检查；
- Shell 语法检查；
- 对外部写入生成幂等目标列表；
- 避免 zsh/bash 保留变量；
- 将读验证与写操作拆开。

### 9.3 强制后置条件

写工具统一返回：

```ts
interface VerifiedWriteResult<T = unknown> {
  status: "succeeded" | "failed";
  target: string;
  changed: boolean;
  verification: {
    ok: boolean;
    observed: T;
    checkedAt: string;
  };
}
```

`on_stop` Finalizer 必须检查 Operation Ledger：如果仍有 `succeeded` 但未 `verified` 的关键操作，则禁止以 completed 结束。

## 十、P1：初始上下文和工具面治理

### 10.1 当前膨胀来源

1. 主模型每轮携带 61 个工具定义；
2. System Prompt 又生成一份工具名称和描述，而 Provider 的原生 `tools` 字段已经包含 description/schema；
3. `ToolSearch` 目前主要只为 MCP 工具做 Deferred Discovery；
4. Skill Listing 将所有 Skill 的完整 description 全量渲染，没有字符或 Token 预算；
5. `SendMessageToSession` 把所有目标 Session 的 ID 和标题同时写进 description 和 enum；
6. `UseCredential` 把实时凭证名称写进工具 description；
7. Agent 类型、图片/视频 Provider 等动态数据也会重写工具定义；
8. 动态定义变化会扩大初始 Prompt，并可能改变工具前缀哈希。

### 10.2 目标架构

#### Task Capability Router

在 Run 开始前根据用户意图选择一个稳定的工具 Profile，复用当前已有的 `EngineRunOptions.toolAllowlist` / `RunBehaviorProfile.allowedToolNames`：

- 普通 Run 初始暴露 8–15 个相关工具；
- 3–5 个跨任务核心工具始终可用；
- 其余工具通过 ToolSearch 按需加载；
- 本 Run 内已加载工具集保持稳定，避免每轮工具前缀变化；
- 安全 Gate 仍保留在 Executor，不能只靠隐藏工具实现权限控制。

#### Generalized Deferred Tools

将 Deferred Discovery 从 MCP 扩展到：

- 非当前任务的 Builtin；
- 插件工具；
- App/Connector 工具；
- 跨 Session 管理工具；
- 重型媒体工具。

ToolSearch 搜索结果应返回紧凑的名称、用途和 schema 引用。只有明确 `select:` 后，工具完整定义才进入本 Run 的活动集合。

#### Skill Listing Budget

建议默认 Skill Listing 预算为上下文窗口的约 1%，同时设置绝对上限。排序信号：

1. 项目显式声明/allowlist；
2. 当前 Workspace/Profile；
3. 用户最近使用；
4. 当前任务语义相似度；
5. 插件默认优先级。

超过预算后：

- 高优先级 Skill：名称 + description；
- 中优先级 Skill：名称 + 短摘要；
- 低优先级 Skill：仅名称；
- Skill 正文继续按需读取，当前这一点已具备。

#### 稳定动态目录

以下目录不能进入原生工具 description/schema：

- Session ID/标题目录；
- Credential ID 目录；
- 实时账号状态；
- 大型 Provider/Model 列表。

改成紧凑的只读目录工具或 Capability Resolver 查询。工具 schema 只表达参数契约，不承载实时数据。

### 10.3 System Prompt 去重

`PromptComposer` 中的 `# Available Tools` 不再复制每个工具的长 description。可保留：

- 工具分类；
- 全局调用策略；
- 与多个工具共同相关的安全规则。

单个工具的参数、返回结构和错误行为只保留在原生 Tool Definition。

## 十一、P1：Browser Runtime 降级为兜底通道

### 11.1 优先级

```text
Semantic Link/API
  > Structured MCP/App tool
  > Authenticated CLI
  > Browser accessibility/DOM action
  > OS keyboard/mouse automation
```

### 11.2 Browser Macro

每个关键动作由宿主封装：

```text
OBSERVE
  → ASSERT_PRECONDITION
  → ACT
  → WAIT
  → OBSERVE
  → ASSERT_POSTCONDITION
```

要求：

- Snapshot 带页面 revision；
- Ref 与 revision 绑定；
- stale ref 自动 Observe 一次；
- `click/type` 成功只代表事件送达；
- 关键动作必须提供可观察的成功谓词；
- Canvas/虚拟表格优先使用应用 API，不用像素坐标或键盘猜测；
- Runtime 连续两次超时后重启一次，再失败则熔断；
- OS 自动化必须先检查辅助功能权限，失败后不得继续调用同类命令。

## 十二、P1：Todo 与任务状态

当前 `TaskGuard` 在 Todo 进入 `in_progress` 三轮后提醒，并每隔三轮重复提醒，导致长工具循环中产生大量无业务价值的上下文。

建议：

1. Operation Controller 成为任务进度的权威来源；
2. UI Todo 从 Operation 阶段自动投影；
3. `TodoWrite` 保留给模型显式规划，但不再承担 UI 状态一致性的唯一责任；
4. 正在产生工具进展时不触发 stale nag；
5. 只在最终回答前或 Operation 长时间无状态变化时提醒一次；
6. Guard reminder 不应永久进入可重复计费的历史。

## 十三、可观测性与 Replay Eval

### 13.1 结构化 Telemetry

每次 Run/Operation 记录：

- `appVersion`
- `gitSha`
- `provider/model/route`
- `cacheStrategy/cacheLayoutVersion`
- `operationId/idempotencyKey`
- `capabilityChannel/account`
- `tool/attempt/errorClass`
- `strategyChangeCount`
- `verification.ok`
- `userCorrectionCount`
- `todoNagCount`

### 13.2 本事故回放断言

将 `s-mtl8jf6s-57bdc5ab` 脱敏后固化为测试夹具，至少断言：

1. 有可用 GitHub 能力时，不要求用户重新登录；
2. OCR 仓库名在 Star 前全部通过只读 API 验证；
3. 无语义 Star 工具时才允许回退 CLI；
4. Shell 脚本不使用保留变量；
5. CLI 字段/参数错误不进行相同重试；
6. 未预检辅助功能权限时不调用 `osascript`；
7. 相同写入后置条件失败两次后熔断；
8. 飞书行为空时不能宣告回填完成；
9. 已验证的 GitHub Star 不会因飞书失败而重复执行；
10. 新版本 Cache Read 随追加历史增长，不出现固定 `30,868` 平台期。

### 13.3 核心 SLO

| 指标                       |          初始目标 |
| -------------------------- | ----------------: |
| 普通任务初始工具数         |               ≤15 |
| 初始 Prompt                | 约 25K–30K tokens |
| 缓存预热后的稳态命中率     |              ≥80% |
| 相同非瞬态错误重复次数     |                ≤2 |
| 工具失败率                 |               <3% |
| 本事故同类任务主模型轮次   |               ≤15 |
| 已有凭证时错误登录提示     |                 0 |
| 未验证外部写入被报告为完成 |                 0 |
| 单任务 Todo stale nag      |                ≤1 |

具体阈值应在多模型真实 Replay Eval 中校准；资源下降只有在任务正确率和最终证据不退化时才算优化。

## 十四、实施顺序

### Phase 0：发布和基线（P0）

- [ ] 发布包含 `3d24a6d5` 或后续 Commit 的安装包；
- [ ] 启动/Session 日志加入 Runtime Build Identity；
- [ ] 增加真实 OpenRouter/GPT-5.6 Cache Contract Test；
- [ ] 增加 Cache Plateau Detector；
- [ ] 用固定 20+ 轮长会话建立新缓存基线；
- [ ] 建立本事故的脱敏 Replay Fixture。

### Phase 1：可靠执行层（P0）

- [ ] 新增 Capability Resolver；
- [ ] 为 GitHub 增加幂等 Star Actions；
- [ ] 为飞书表格增加结构化读写和验证 Actions；
- [ ] 新增 Operation Controller 和 Ledger；
- [ ] 在 ToolExecutor/Hook 上增加错误分类与熔断；
- [ ] 外部写工具统一返回 VerifiedWriteResult；
- [ ] on_stop 检查关键 Operation 全部 verified。

### Phase 2：上下文治理（P1）

- [ ] 使用现有 tool allowlist 实现 Task Capability Router；
- [ ] Deferred Tools 从 MCP 扩展到全部非核心工具；
- [ ] 删除 System Prompt 的逐工具重复 description；
- [ ] 为 Skill Listing 增加预算、排序和 name-only 降级；
- [ ] Session/Credential/Provider 目录移出工具定义；
- [ ] 为活动工具集增加本 Run 粘性和变更原因日志。

### Phase 3：Browser 和任务投影（P1）

- [ ] Browser Observe/Act/Postcondition 宏；
- [ ] Runtime 超时恢复与一次重启预算；
- [ ] OS 自动化权限预检；
- [ ] Operation 状态自动投影 Todo；
- [ ] 降低 TaskGuard re-nag 频率并避免持久化噪声。

### Phase 4：协议与模型实验（P2）

- [ ] 评估 GPT-5.6 Responses API；
- [ ] 评估 `previous_response_id` 和 persisted reasoning；
- [ ] 在同一 Replay Suite 上比较模型、reasoning effort、缓存和成本；
- [ ] 只有 Eval 证明有收益时才调整默认模型或 effort。

## 十五、主要修改入口

| 方向                    | 现有入口                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| 缓存策略                | `packages/core/src/llm/prompt-cache.ts`                            |
| OpenAI Wire Translation | `packages/core/src/llm/providers/openai.ts`                        |
| 缓存诊断                | `packages/core/src/engine/prompt-cache-diagnostics.ts`             |
| 动态上下文/工具描述     | `packages/core/src/prompt/composer.ts`                             |
| Skill Listing           | `packages/core/src/tool-system/builtin/skill-prompt.ts`            |
| ToolSearch              | `packages/core/src/tool-system/builtin/tool-search.ts`             |
| Run Tool Allowlist      | `packages/core/src/engine/run-tooling.ts`                          |
| 动态工具定义            | `packages/core/src/engine/dynamic-tool-defs.ts`                    |
| 跨 Session 动态目录     | `packages/core/src/tool-system/builtin/send-message-to-session.ts` |
| Credential 目录         | `packages/core/src/credentials/use-credential-tool.ts`             |
| Link Action             | `packages/core/src/links/link-action-tool.ts`                      |
| GitHub Provider Actions | `packages/core/src/links/providers.ts`                             |
| Tool Hook/权限/执行     | `packages/core/src/tool-system/executor.ts`                        |
| 重复调用行为            | `packages/core/src/engine/turn-loop-tool-cap.test.ts`              |
| Browser Tools           | `packages/core/src/tool-system/builtin/browser-tools.ts`           |
| Todo stale nag          | `packages/core/src/tool-system/task-guard.ts`                      |

## 十六、外部对标结论

Claude Code 的初始提示词也可能较大，但其可接受的前提是：稳定前缀缓存、工具延迟加载和有预算的 Skill 索引。初始负载大本身不是 P0；未治理的工具面会同时增加成本和错误工具选择概率。

参考：

- Anthropic Tool Search：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool>
- Claude Code Skills：<https://code.claude.com/docs/en/skills>
- Anthropic Prompt Caching：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI GPT-5.6 Model Guidance：<https://developers.openai.com/api/docs/guides/latest-model>
- Codex Config Basics：<https://learn.chatgpt.com/docs/config-file/config-basic>

OpenAI 的公开建议同样强调：精简 System Prompt、只暴露任务相关工具、明确重试和停止条件、不要重复已完成的写操作，并把最终验证作为独立步骤。CodeShell 应将这些约束实现为宿主执行机制，而不是继续增加 Prompt 提醒。

## 十七、非目标

本方案不包含：

- 立即替换主模型；
- 仅靠扩大上下文窗口解决成本问题；
- 通过禁止所有重复调用误伤合法 Poll；
- 绕过现有权限、审批、路径和沙箱链；
- 用更多 Prompt 规则替代 Capability Resolver、Operation Ledger 和 Postcondition；
- 在新版本尚未发布前，用旧日志评价 `3d24a6d5` 的实际缓存效果。
