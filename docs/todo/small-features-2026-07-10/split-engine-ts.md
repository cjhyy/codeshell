# 拆分 `engine.ts` 本体

> 体量：M  
> 策略：一次只抽一个有清晰输入/输出的模块，每一步保持 public `Engine` 行为与导出路径不变。  
> 基线：2026-07-10 当前 `packages/core/src/engine/engine.ts` 共 3,627 行。

## 1. 问题与现状

### 1.1 已完成的前置抽取

- `EngineConfig`、`EngineHookConfig`、`EngineResult` 已移到 `packages/core/src/engine/types.ts:1-190`，`engine.ts` 只做兼容 re-export（`packages/core/src/engine/engine.ts:166-172`）。
- 图片输入解析/校验/Message 组装已在 `packages/core/src/engine/run-image-input.ts`，`engine.ts` 仅导入 `prepareRunImageInput` 和 `buildRunUserMessageContent`（`packages/core/src/engine/engine.ts:116`）。
- 通用 `extractJSON` 已在 `packages/core/src/utils/json.ts:11`，对应测试在 `packages/core/src/utils/json.test.ts`。
- 工具层已经用 `ToolRuntimeHost` 窄接口取代具体 `Engine` 依赖（`packages/core/src/tool-system/context.ts:24-49`）；`ToolContext.engine` 的类型是该接口（`packages/core/src/tool-system/context.ts:264-267`）。当前 `tool-system` 生产代码没有反向导入 `engine/engine.ts`，说明早期的 `core → tool-system → engine` 直接环已拆掉。

### 1.2 仍然集中在门面中的职责

- `Engine.run()` 从 `packages/core/src/engine/engine.ts:928` 一直延伸到 `:2335`，约 1,408 行。它同时处理 workspace/cwd、输入拒绝、subagent factory、sandbox、session create/resume、hooks、权限、MCP、PromptComposer、工具可见性、LLM client、Goal、TurnLoop、headless drain、持久化和后台 memory/title。
- 子 agent 创建闭包位于 `packages/core/src/engine/engine.ts:1060-1177`。它既算 child config，又 new `Engine`、过滤 stream event、决定 resume sid、写 parent transcript anchor。
- sandbox 的“本轮解析”位于 `packages/core/src/engine/engine.ts:1179-1233`，而无 runtime cache、scope 合并、shell env/worktree setup 又散在 `:3292-3459`。
- TurnLoop 装配位于 `packages/core/src/engine/engine.ts:1969-2121`，把 compaction、steer、usage、goal 清理、context anchor、heartbeat 等十余个闭包塞进 constructor。
- runtime config 热刷新位于 `packages/core/src/engine/engine.ts:2671-2756`，同时依赖 preset、hooks、MCP 和 config version；相关 hook/model/settings 实现又散在 `:487-765`、`:2988-3019`。
- 其他大块还有 prompt/tool/runtime component 初始化（`:1446-1825`）、Goal 生命周期（`:1874-1967`、`:2034-2149`）、headless background drain（`:2156-2216`、`:3161-3225`）、memory/aux 管线（`:2354-2540`、`:3563-3615`）和 ToolContext/settings 环境解析（`:3232-3562`）。

### 1.3 当前锚点校正

TODO 中四个锚点目前仍准确：

- `engine.ts:928`：`Engine.run()` 起点；
- `engine.ts:1179`：sandbox config/backend 解析起点；
- `engine.ts:1980`：`new TurnLoop(...)`；
- `engine.ts:2706`：`refreshRuntimeConfig(...)`。

但仓库说明里“EngineConfig 仍需先提取、tool-system 仍反向依赖具体 Engine”的文字已经过时；这两项现在是可利用的既有边界，而不是本拆分的阻塞项。

## 2. 目标

1. `Engine` 最终只保留：资源所有权、生命周期状态、public facade 方法和模块装配；业务流程通过内部 service/coordinator 完成。
2. `Engine.run()` 收敛到约 100-180 行：创建 run-scoped services → 调用 coordinator → 更新门面可观察状态 → 返回结果。
3. 每次 PR 只抽一个模块，保持 public import `engine/engine.js`、`Engine` 构造参数、`Engine.run()` 返回值与 StreamEvent 顺序兼容。
4. 新模块不能导入 `./engine.js`；工具层不能重新依赖 engine 实现。创建 child Engine 必须使用注入回调。
5. 抽出的模块以显式输入/输出和窄 port 表达依赖，不通过 `as any` 访问 Engine private 字段。
6. 每一块都有纯单测或 fake-service 测试；现有 Engine 集成测试作为行为锁，不能只靠最终全量回归。

## 3. 详细修改方案：目标模块清单

下表中的“当前范围”按本次核查的 3,627 行文件计，后续行号会随前序抽取漂移；实施时应按符号定位。

| 优先级 | 当前范围（约 LOC） | 目标文件 | 职责与目标边界 |
|---|---:|---|---|
| 1 | `:197-207`、`:263-302`、`:1060-1177`（约 165） | `engine/subagent-spawner.ts` | child LLM/tool scope、child config、parent anchor、stream 过滤、resume sid；不直接 import/new `Engine` |
| 2 | `:1179-1233`、`:3292-3333`、`:3365-3459`（约 220） | `engine/run-environment.ts` | scope-aware sandbox config、backend cache、network policy、shell env、worktree setup 环境 |
| 3 | `:957-1055`、`:1245-1444`（约 300） | `engine/run-session.ts` | workspace/cwd preflight、输入 early return、session create/resume、clientMessageId claim、用户消息落盘、run sid 建立 |
| 4 | `:1446-1825`（约 380） | `engine/run-components.ts` | ContextManager、permission/executor/guards、MCP connect、PromptComposer、effective tools、LLM/aux client、ModelFacade、usage baseline |
| 5 | `:1827-1865`（约 39） | `engine/file-history-hook.ts` | 创建 run-scoped file backup hook，返回 handler + dispose，覆盖 Write/Edit/ApplyPatch |
| 6 | `:1874-1967`、`:2034-2149`、`:2776-2815`、`:3124-3132`（约 250） | `engine/goal-run-controller.ts` | resolve/persist active goal、注册/注销 stop hook、clear/termination/tombstone、active loop extension |
| 7 | `:1969-2121`（约 153） | `engine/turn-loop-factory.ts` | 从已构建组件和 callback ports 生成 `TurnLoopDeps`/`TurnLoopConfig`，不含 run 执行 |
| 8 | `:2151-2227`、`:3161-3225`（约 142） | `engine/run-loop-driver.ts` | 执行 TurnLoop、headless subagent drain、notification backfill、abort race、run-scoped disposer |
| 9 | `:2228-2334`（约 107） | `engine/run-finalizer.ts` | 消息 cache 清理、session_end/agent_end、usage/status 保存、title/memory dispatch、最终 EngineResult |
| 10 | `:2354-2540`、`:3563-3615`（约 240） | `engine/auxiliary-pipeline.ts` | aux client、compaction summarizer、memory extraction、dream loop、extraction model选择 |
| 11 | `:487-551`、`:630-765`、`:2542-2756`、`:2988-3019`（约 510） | `engine/runtime-config-controller.ts` | SettingsManager cache、settings/plugin hooks reload、model pool/persist/switch、版本化 config patch、MCP reconcile |
| 12 | `:3021-3160`（约 140） | `engine/permission-controller.ts` | permission rules/backend 构造、live reconfigure、plan mode；Engine public 方法仅委托 |
| 13 | `:3232-3291`、`:3462-3562`（约 160） | `engine/tool-context-factory.ts` | agent definitions、capability disabled lists/flags、base ToolContext；依赖 `ToolRuntimeHost` 而非 Engine |
| 收尾 | `:126-303` 中剩余兼容 helper、constructor 与 public delegate | `engine/run-types.ts` + 保留 `engine.ts` | 内部 DTO/ports 移出；`engine.ts` 保留 `Engine`、兼容 re-export 和资源装配 |

说明：`runtime-config-controller.ts` 是目标逻辑模块，不要求一次搬完 500 行。应按“settings/hook reload → model pool → versioned refresh”三次小提交迁移，但最终落在同一 controller，避免再形成多个互相回调的配置管理器。

### 3.1 内部合同：`packages/core/src/engine/run-types.ts`

先定义内部 DTO，防止每个提取模块自创相似结构：

```ts
export interface EngineRunOptions {
  cwd?: string;
  onStream?: StreamCallback;
  signal?: AbortSignal;
  sessionId?: string;
  goal?: string | GoalConfig;
  injected?: boolean;
  clientMessageId?: string;
  attachments?: InputAttachmentMeta[];
}

export interface ChildEngineRunner {
  runChild(
    config: EngineConfig,
    task: string,
    options: Pick<EngineRunOptions, "signal" | "onStream" | "sessionId">,
  ): Promise<Pick<EngineResult, "text" | "sessionId">>;
}

export interface RunScopedDisposer {
  dispose(): void | Promise<void>;
}
```

这些类型只在 `engine/**` 内导入，不从 core root index 导出。`Engine.run()` 可以把匿名 options 改成 `options?: EngineRunOptions`，但对调用方是结构兼容的。

### 3.2 `subagent-spawner.ts`

建议签名：

```ts
export interface CreateSubAgentSpawnerDeps {
  parentConfig: EngineConfig;
  presetName: AgentPresetName;
  cwd: string;
  modelPool: ModelPool;
  parentTranscript: Transcript;
  sessionExists: (sid: string) => boolean;
  childRunner: ChildEngineRunner;
  parentStream?: StreamCallback;
}

export function createSubAgentSpawner(
  deps: CreateSubAgentSpawnerDeps,
): SubAgentSpawner;
```

关键变化：

- 把当前 `new Engine(...).run(...)` 留在 `engine.ts` 注入的 `childRunner` 实现中；目标文件绝不 import `Engine`。
- `resolveChildLlm()`、`resolveChildToolScope()` 与 `NESTED_AGENT_TOOLS` 同步移入本模块；`engine.ts` 继续兼容 re-export 现有纯 helper，避免测试/潜在深层 import 立即断裂。
- 把 stream event 过滤规则封装成可测试的 `wrapChildStream()`：过滤 `usage_update`、`session_started`、`context_compact`，其他事件补 `agentId`。
- parent transcript anchor 失败仍 best-effort；resume 不重复写 anchor；child sid 仍为 `resumeSessionId ?? agentId`。

### 3.3 `run-environment.ts`

建议用有状态 resolver 管理无 runtime sandbox cache：

```ts
export class RunEnvironmentResolver {
  constructor(private readonly deps: {
    runtime?: Pick<EngineRuntime, "resolveSandbox">;
    settings: () => SettingsManager;
    credentialAccess: Pick<CredentialAccess, "envExposures">;
    config: () => EngineConfig;
  });

  resolve(cwd: string): Promise<{
    sandbox: SandboxBackend;
    sandboxConfig: SandboxConfig;
    shellEnv?: Record<string, string>;
  }>;

  resolveWorktreeSetup(cwd: string): Promise<{
    sandbox?: SandboxBackend;
    shellEnv?: Record<string, string>;
    scripts?: WorktreeSetupScripts;
    branchPrefix?: string;
  }>;
}
```

保留以下不变量：explicit seatbelt/bwrap fail-closed；`auto` 才可降级；rejected promise 不进 cache；backend spread 后再加 network，不能修改共享 cached backend；env 优先级与 credential exposure 语义不变。

### 3.4 `run-session.ts`

建议返回 discriminated union，消除 `run()` 中多处分散 early return：

```ts
export type PrepareRunSessionResult =
  | { ok: false; result: EngineResult }
  | {
      ok: true;
      cwd: string;
      session: SessionBundle;
      messages: Message[];
      userMessage: Message;
      freshImageMessage?: Message;
      resumedFromDisk: boolean;
      claimClientMessageId: (...args: ...) => boolean;
    };
```

模块负责 workspace resume 错误、legacy cwd precedence、已有/显式新/自动 sid 三种 session 形状、orphan tool patch、cost state restore、turnSeq、用户消息/summary/status 落盘。它不创建 PromptComposer、ToolExecutor 或 TurnLoop。

`wrappedOnStream` 中 goal_progress 写 Transcript 需要 session 已解析；不要照搬当前“闭包先声明、稍后赋 session”的隐式时序。改为 `createRunStream(session, userOnStream, taskSnapshot)`，在 session 准备完成后显式创建。

### 3.5 `run-components.ts`

该模块输入 `PreparedRunSession + RunEnvironment + config snapshot`，输出一个 run-scoped bundle：

```ts
export interface RunComponents {
  contextManager: ContextManager;
  toolContext: ToolContext;
  toolExecutor: ToolExecutor;
  promptComposer: PromptComposer;
  toolDefs: ToolDefinition[];
  systemPrompt: string;
  userContextMessage: Message | null;
  dynamicContextMessage: Message | null;
  llmClient: LLMClientBase;
  auxClient: LLMClientBase;
  modelFacade: ModelFacade;
  usageBaseline: TokenUsage;
  recordCumulativeUsage(usage: TokenUsage): CumulativeUsageCounters;
}
```

工具可见性必须维持当前顺序：ctor registry → project builtin override → session MCP owner filter → builtin guard → feature flag → dynamic tool def → plan-mode allowlist（当前 `engine.ts:1631-1712`）。顺序改变可能让隐藏工具仍可执行或改变 tools prefix；单测应把顺序视为合同。

### 3.6 `file-history-hook.ts`

提供 `registerFileHistoryHook(hooks, session, cwd): RunScopedDisposer`。注册和注销由一个对象拥有，避免 Engine finally 忘记 handler identity。ApplyPatch 的 cwd 使用本次 run cwd，不再回读可能已变化的 `this.config.cwd`。

### 3.7 `goal-run-controller.ts`

建议每次 run 创建实例：

```ts
export class GoalRunController implements RunScopedDisposer {
  readonly goal?: GoalConfig;
  readonly persistedRunGoal?: GoalConfig;
  readonly hook?: HookHandler;

  static create(deps: GoalRunDeps): GoalRunController;
  clearPersistedGoal(): void;
  applyTermination(reason?: GoalTerminationReason): void;
  attachTurnLoop(loop: TurnLoop): void;
  extend(opts: GoalExtension): GoalExtensionResult | null;
  dispose(): void;
}
```

它只通过 `SessionManager`、`SessionBundle`、HookRegistry 和 stream callback 操作状态。Engine 的 `getGoal/clearGoal/extendGoalRun` 保留 public 签名，但委托 controller/manager。`onMet`、replacement goal、tombstone identity 和 mid-run clear 的比较必须仍用 `isSameGoalInstance()`。

### 3.8 `turn-loop-factory.ts`

建议签名：

```ts
export function createTurnLoop(input: {
  components: RunComponents;
  session: SessionBundle;
  config: EngineConfig;
  options: EngineRunOptions;
  callbacks: TurnLoopPorts;
  goal: GoalRunController;
  freshImageMessage?: Message;
}): TurnLoop;
```

`TurnLoopPorts` 显式列出 steer、usage、cache diagnostics、context anchor、heartbeat 等 callback。禁止传整个 Engine 或 `this`。compaction pending buffer可封装为 `createPendingCompactBuffer(onStream)`，避免 factory 中可变局部散落。

### 3.9 `run-loop-driver.ts` 与 `run-finalizer.ts`

- driver 只控制 `turnLoop.run()`、goal termination、headless subagent drain 和 disposer 的 `try/finally`。后台等待函数改成模块内纯依赖注入（registry/queue/timer），不读取 Engine private 字段。
- finalizer 接收 driver result 与 `RunComponents`，执行 message cache 清理、session recorder、hooks、title/memory dispatch、state/usage 落盘和最终结果映射。
- `stripInjectedContextMessages()`（当前 `engine.ts:2949-2961`）移到 finalizer，作为纯函数单测，确保 dynamic/user context 不污染下一 run 的 compacted cache。

### 3.10 `runtime-config-controller.ts`

建议 controller 持有 `lastAppliedVersion`、settings hook handles、aux client cache/model pool配置状态。Engine public 方法 `reloadHooks/reloadModelPool/switchModel/refreshRuntimeConfig/updateConfig/readSetting` 原签名不变，内部委托。

```ts
export interface RefreshRuntimeConfigResult {
  applied: boolean;
  nextConfig: EngineConfig;
  nextPreset: AgentPreset;
  toolSetRestartRequired: boolean;
}

refresh(patch: Partial<EngineConfig>, version: number): RefreshRuntimeConfigResult;
```

MCP reconcile 继续 fire-and-forget + catch/log；旧 version 必须在任何副作用前返回；preset prompt 可热更新但 ctor-frozen tool set 只告警、不得偷偷重建共享 registry。

### 3.11 `permission-controller.ts` 与 `tool-context-factory.ts`

- PermissionController 拥有当前 mode、planMode、active classifier，提供 `build/reconfigure/getRules`；避免 `Engine.permissionMode`、`Engine.planMode`、`activePermission` 三处状态漂移。为 `ToolRuntimeHost.planMode` 提供 getter/delegate。
- ToolContextFactory 读取 disabled skills/plugins/agents、feature flags、agent definitions，并接收 `host: ToolRuntimeHost`。它可以 import tool-system 类型，tool-system 绝不 import 它。

## 4. 分阶段实施顺序与依赖边界

### 阶段 A：先抽低耦合、已有测试的叶子

1. **subagent-spawner**：边界最清楚，现有 helper 已是纯函数；通过 childRunner callback 可一次切断 `new Engine` 自引用。
2. **run-environment**：sandbox config/cache 已有独立模块和测试，抽取失败影响面可控。
3. **file-history-hook**：小块、run-scoped disposer 明确，可先建立统一资源清理模式。

### 阶段 B：把 `run()` 切成准备、装配、执行、收尾

4. **run-session**：先固定所有 early return 和 session shape。
5. **run-components**：抽 ContextManager/permission/MCP/prompt/tools/model 的构造。
6. **goal-run-controller**：把 hook/persistence/termination 从 TurnLoop wiring 周围拿走。
7. **turn-loop-factory**：在前述 bundle 稳定后再抽，避免 factory 接收几十个散参。
8. **run-loop-driver**：抽 headless drain 和 finally disposal。
9. **run-finalizer**：最后移出落盘/事件/后台 pipeline dispatch；此时 `Engine.run()` 收敛为四段编排。

### 阶段 C：拆长期控制面

10. **permission-controller/tool-context-factory**：将 public delegate 背后的运行状态集中。
11. **runtime-config-controller**：按 hooks → model pool → versioned patch 三个小步骤迁移；这是跨 session 状态最多的一块，放在 run 链稳定之后。
12. **auxiliary-pipeline**：memory/dream/summary 从 Engine 移出。
13. **收尾 facade**：移动内部 DTO/剩余 pure helper，保留 `Engine` 构造、资源所有权、public 方法、back-compat re-export；更新文件头与架构说明。

每一步都应是“移动 + 接线 + 对应测试”，不要在同一提交顺便改变权限、缓存、Goal 或 sandbox 语义。

### 4.1 依赖边界与防循环规则

#### 4.1.1 允许的方向

```text
engine/engine.ts (facade)
  -> engine/* controllers/coordinators
      -> session / prompt / context / hooks / llm / tool-system

tool-system
  -> tool-system/context.ts::ToolRuntimeHost
  -X-> engine/engine.ts
```

#### 4.1.2 强制规则

1. 新增的 `engine/*.ts` 不得 import `./engine.js`；需要 child Engine 时注入 `ChildEngineRunner`。
2. `tool-system/**` 不得 import `engine/engine.ts` 或任何 coordinator。工具回调只能扩展 `ToolRuntimeHost`，扩展前先证明确有工具需要。
3. DTO/port 放 `engine/run-types.ts` 或各模块自身，且只依赖 `types.ts`、`engine/types.ts` 等类型文件；不要让 `engine/types.ts` runtime-import controller。
4. `engine.ts` 可兼容 re-export 被迁移的 pure helper，但 root `packages/core/src/index.ts` 不新增 coordinator 导出。
5. controller 之间通过结果对象通信，不互相拿实例再回调 private 方法。例如 RunComponents 输出 `recordCumulativeUsage`，TurnLoopFactory 不 import RuntimeConfigController。
6. shared `EngineRuntime` 仍只拥有跨 session 资源（ModelPool/ToolRegistry/MCP/Sandbox cache）；run-scoped controller 不存入 Runtime。
7. 新增一个架构守卫测试或 lint 脚本，扫描 `packages/core/src/tool-system/**/*.ts` 的生产 import，遇到 `/engine/engine` 失败；测试文件可显式排除。

## 5. 测试策略

### 5.1 subagent-spawner

复用/保留：

- `packages/core/src/engine/resolve-child-tool-scope.test.ts`
- `packages/core/src/engine/__tests__/subagent-inherits-personalization.test.ts`
- `packages/core/src/engine/engine-sid-isolation.test.ts`
- `packages/core/src/tool-system/builtin/agent.send-input.llm.test.ts`

新增 `subagent-spawner.test.ts`：childRunner 收到完整继承配置；nested tools 被移除；role model 选择正确；resume 不写新 anchor；cold sid=`agentId`；三类 ctx event 被过滤；其他 event 带 agentId；child error 透传且不污染 parent sid。

### 5.2 run-environment

复用：`sandbox-config.test.ts`、`sandbox-cache-key.test.ts`、`runtime.sandbox-cache.test.ts`、`engine.shell-env.test.ts`。

新增：config/project/user/default 优先级；explicit backend unavailable 抛错；auto downgrade；rejected promise 被移出 cache；network shallow copy 不修改共享 backend；credential env 与 settings env 优先级；subagent policy seam；worktree setup 使用新 cwd。

### 5.3 run-session

复用：`engine.resolve-cwd.test.ts`、`engine.workspace-cwd.test.ts`、`engine-client-message-id.test.ts`、`patch-orphaned-tools.test.ts`、`engine.todo-resume.test.ts`、`input-attachments.test.ts`。

新增：existing sid resume、fresh explicit sid create、no sid create；workspace missing early result；duplicate clientMessageId 不追加 transcript；cost state restore；turnSeq 单次增长；goal_progress stream wrapper 写入正确 session。

### 5.4 run-components / tool-context-factory

复用：`dynamic-tool-defs.test.ts`、`__tests__/builtin-override-per-turn.test.ts`、`__tests__/builtin-override-removes-tool.test.ts`、PromptComposer 相关测试、`engine.prompt-cache.test.ts`。

新增：工具过滤顺序表驱动测试；共享 MCP registry 只暴露当前 session server；plan mode seen/executed 集合一致；feature flag 与 guard 同时作用；PromptComposer 输入使用一次性 config snapshot；runtime/private MCP manager 分支一致。

### 5.5 goal-run-controller

复用：`hooks/goal-stop-hook.test.ts`、`turn-loop-goal-lifecycle.test.ts`、`session-manager.cleargoal*.test.ts`、`protocol/server.goal*.test.ts`、`goal.test.ts`。

新增：dispose 幂等；replacement goal 不被旧 run 清除；mid-run clear 注销对应 handler；onMet 落盘；termination tombstone；subagent 不注册 Goal hook；attach/extend 只作用于本次 loop。

### 5.6 turn-loop-factory / run-loop-driver

复用全部 `turn-loop-*.test.ts`，重点是 abort、context-limit、steer、sensitive result、usage/cache、max turns、goal lifecycle。

新增：fake ports 逐一断言调用；heartbeat 的 usage fold 幂等；pending compaction 只消费一次；headless 只等待 subagent、不等待 shell/video；registry notify 与 queue enqueue race；abort 后仍 drain 已入队通知；所有 disposer 在抛错路径执行一次。

### 5.7 run-finalizer / auxiliary-pipeline

复用：`engine.prompt-cache.test.ts`、`session-usage.test.ts`、`engine.session-title.test.ts`、`engine.force-compact.test.ts`、memory/dream 现有 service tests。

新增：user/dynamic context 不进入 compacted cache；session_end/agent_end/turn_complete 顺序不变；status 保存原始 TerminalReason；title 只首轮触发；memory pipeline fire-and-forget 失败只告警；aux same-identity 去重；extraction model missing/failure 回退。

### 5.8 runtime-config / permission

复用：`__tests__/engine-config-hot-reload.test.ts`、`protocol/server.reload-settings.test.ts`、`plugins/loadPluginHooks.test.ts`、`engine.permission-rules.test.ts`、`tool-system/builtin/plan.test.ts`。

新增：过期 version 零副作用；hook reload 不删 SDK/goal hook；plugin disable 热生效；MCP reconcile rejection 被捕获；preset tool set 差异只告警；live classifier 在 setPermissionMode 后立即 reconfigure；planMode 与 permissionMode 单一状态源。

### 5.9 每块完成门槛

实施时每块至少运行：该模块单测、映射的 Engine 集成测试、core typecheck/lint 中相关范围。最后一阶段再跑完整 core tests。本方案编写阶段按任务约束不执行任何测试。

## 6. 风险与兼容性注意

- **事件顺序是隐含 API**：`session_started`、assistant/tool events、`goal_progress`、`turn_complete` 以及 hook 顺序被 UI/协议依赖。移动代码不能顺便重排 await/fire-and-forget。
- **run-scoped 与 Engine-scoped 状态不可混放**：`activeTurnLoop/activeGoalHook/activeRunSession` 是当前 run；model pool、settings cache、MCP manager、compactedMessagesBySession 是跨 run。controller 构造时必须明确生命周期。
- **共享 Runtime 污染**：ToolRegistry/MCPManager/ModelPool 可能跨 session 共享。任何“重建”或 filter 必须只影响本 session 的 view，不能删除其他 owner 的工具。
- **闭包时序**：当前 run 中有些闭包在 session 变量赋值前创建但稍后才触发。抽取时要改成显式依赖，不能依赖“现在恰好不会早调用”。
- **private 测试耦合**：现有测试有 `(engine as any)` 访问。迁移时先给 controller 加单测，不要为保测试方便把内部 controller 暴露为 public API；旧集成测试可逐步改用行为断言。
- **兼容导出**：`EngineConfig` 的 engine.ts re-export、`resolveRunCwd`、`resolveChildToolScope` 等深层 import 在迁移期保留 forwarding export；root index 的既有导出不变。
- **循环依赖复发**：最危险的是 `subagent-spawner.ts` 为了 new child 反向 import `Engine`，以及 tool builtin 为调用新 service 反向 import engine。必须用 callback/`ToolRuntimeHost`。
- **同步/异步语义**：`refreshRuntimeConfig` 当前同步返回、MCP reconcile 异步后台执行；不要把 public 方法改成 Promise。相反，sandbox/LLM/MCP 初次 connect 本来就在 run 中 await，继续保持。
- **配置 snapshot**：一次 TurnLoop 内的 system/tools/config 应稳定；热刷新只影响下一次 `Engine.run()`/下一消息。抽 controller 后不能让 in-flight loop 每轮重新读取 mutable Engine config。
- **文件体积不是唯一验收**：若只是把 1,400 行 run 搬到另一个 1,400 行函数且传整个 Engine，债务并未消失。验收看依赖数量、可独立测试性、run-scoped ownership 和无反向 import。
