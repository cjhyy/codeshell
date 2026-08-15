# AgentModule 与 ResolvedComposition 统一组合设计

> 状态：**Phase A（Compiler+golden）与 Phase B（一次性 cutover）已落地 main**；Phase C（生命周期 disposer）与 Phase D（request boundary）待做。  
> golden 基线：`tests/fixtures/composition-golden.json`（基线 commit 35e0f7c4，pre-cutover 旧路径生成，cutover 后由新工厂逐项复现）。  
> 注意：cutover 是 breaking 变更，下一个 release 版本须升 0.9.0（`bun run scripts/release.ts 0.9.0`）。  
> 日期：2026-08-14；落地 2026-08-15。  
> 范围：统一 `CapabilityModule` / `ExtensionModule`，建立可验证的组合编译结果与生命周期所有权，并补充轻量的模型请求证据。  
> 核心决策：保留 CodeShell 的 **Core First** 与可信内核，不引入 Cordis，不把所有内部组件改造成动态插件。

## 0. 实施偏差记录（落地时的有意调整，语义不变）

1. `AgentModuleToolContribution` 实现为判别联合 `{kind:"preset-tags", tool: BuiltinTool} | {kind:"always", tool: ExtensionTool}`（比 spec 的扁平 union 类型更安全）。
2. `activateHost`/`activateEngine`/`privateService`/`LifetimeScope` 属 Phase C，未实现；`createToolService` 原名保留为 engine contribution 字段，Phase C 再改名。
3. **catalog 注入推导规则**：旧 extensionModules.catalogTools 的"强制并入 active preset"语义改写为——preset-tags 工具中 owning module 未贡献任何 preset 的（pet 类）注入 active preset；贡献了 preset 的模块（core/coding）不注入。数据上与现状逐项一致（golden 证明）。
4. **core preset 遮蔽规则**：host 模块可遮蔽 core 同名 preset（`core_preset_shadowed` diagnostic），复刻 `resolveAgentPreset` 的 contributed-first 优先级（coding 的扩展版 "general" 依赖此行为）；host 之间同名仍 fail loud。
5. `defineProduct` 不再 `registerPreset()`，改为合成 `{id:"product"}` AgentModule 传入 runner。
6. `resolveAgentPreset`/`resolveBuiltinToolNames`/`listPresetNames` 保留但降为 builtin-only（去掉 capabilities 参数）；模块 preset 一律经 `resolvePresetFromComposition`。
7. `Capability*` 前缀的贡献小类型（provider/detector/hook 等）与 `ExtensionTool`/`ProtocolObserver*` 名称保留，改名推迟为后续纯美化。
8. `expectedModules` 校验落在 Compiler；host loader（`CODE_SHELL_CAPABILITY_MODULES`）自身也 fail loud（import/工厂失败直接 throw）。
9. hook 规范化名保留现有 `capability:${id}:...` 前缀与 priority 20 缺省（golden 逐项相等的要求）。

## 1. 摘要与已定结论

CodeShell 当前已经具备 Core、产品 capability、preset、tool catalog、hook、protocol extension 与长期 Session 等主要组合原语，但它们由两套模块接口和若干进程级 registry 分别装配：

- `CapabilityModule` 贡献工具、preset、prompt、动态上下文、artifact、file history、workspace 校验和 engine hook。
- `ExtensionModule` 贡献普通工具、catalog tool、behavior profile、protocol query/observer、run 参数校验和隐藏 Session kind。
- `registerCapability()`、`registerPreset()`、`registerSection()` 等入口仍可修改进程级状态。
- Engine、AgentServer 与 host 分别读取模块数据，缺少一份可序列化检查的最终组合结果。

本设计把上述入口收敛成一条显式流水线：

```text
Core declarations + host AgentModules
                              │
                              ▼
                    compileComposition()
                              │
                              ▼
                    ResolvedComposition
                    ├─ engine contributions
                    ├─ protocol contributions
                    └─ provenance / diagnostics
                              │
                              ▼
                    activateComposition()
                    ├─ host scope
                    ├─ engine scope
                    ├─ session scope
                    └─ run scope
```

已定结论：

1. 新的统一模块名为 `AgentModule`；Coding、Arena、Pet 都通过同一个顶层接口接入。
2. 模块贡献优先使用声明式数据。运行时 activator 只能创建已声明贡献所需的资源，不得暗中增加未出现在组合结果中的工具、prompt、query 或权限规则。
3. `compileComposition()` 是纯函数：相同输入必须产生顺序、诊断与 digest 均相同的结果；冲突一律 fail loud，不做隐式 last-write-wins。
4. `ResolvedComposition` 是 Engine 与 AgentServer 的共同输入和组合事实源，host 不应让两者各自重新解析模块。
5. 每个运行时注册必须返回 disposer，并由明确的 host / engine / session / run scope 持有；释放逆序、幂等，部分激活失败必须回滚。
6. 第一阶段模块拓扑在 host 启动时冻结。现有 settings reload、工具可见性和权限热更新保持不变，但本设计不承诺运行中热加/热删模块。
7. Core 内部继续使用直接依赖和明确构造参数。`ModuleActivationContext` 只用于扩展边界，不成为遍布 Core 的 Service Locator。
8. 模型请求证据是独立的轻量后续阶段：复用现有 append-only Transcript，只增加 request boundary 与 digest，不重写 Session、Run、Cron、Goal 的持久化模型。
9. 不设过渡兼容层：所有 host 与产品模块在一次 cutover 中切换并删除旧接口，`@cjhyy/code-shell-core` 以 breaking 版本发布。所有消费方都在本仓库内，没有需要长期兼容的外部用户；迁移前后行为一致由 Phase A 先行落库的 golden snapshot 证明。

## 2. 动机与当前问题

### 2.1 两套模块接口表达同一产品概念

当前 `packages/core/src/capabilities/index.ts` 的 `CapabilityModule` 和
`packages/core/src/tool-system/capability-module.ts` 的 `ExtensionModule` 都表示“由可信产品包向 Core
贡献 agent 行为”。两者都能贡献工具，但只有前者能贡献 preset/prompt/hook，后者又单独拥有 protocol
observer/query 与 behavior profile。

这造成三个问题：

1. 新产品模块需要先判断自己属于 Capability 还是 Extension，语义依赖实现细节。
2. `composeToolCatalog()` 同时接收 capabilities 和 extension modules，Engine 构造器还要再调用
   `registerExtensionModules()`，工具组合存在两条路径。
3. Arena/Pet 的 factory 名为 `create*Capability()`，返回类型却是 `ExtensionModule`；Coding 则是常量
   `CODING_CAPABILITY: CapabilityModule`（没有工厂函数），公共词汇已经漂移。

### 2.2 最终组合不是一等对象

Engine 构造阶段分别完成 capability 解析、tool catalog 合并、behavior profile 注册、prompt section 合并、preset 选择、extension tool 注册和 hook 接线。AgentServer 又独立读取 protocol observer、query、run validator 与隐藏 Session kind。

因此当前很难直接回答：

- 某个 Session 最终加载了哪些模块？
- 某个工具来自 Core、Coding 还是 Pet？
- 某个 prompt section、hook 或 query 的所有者是谁？
- 为什么某个工具被隐藏或某个 preset 成为默认？
- Engine 与 AgentServer 是否使用了同一组模块？

这些问题目前只能通过阅读多处源码或运行时逐层打印来回答。

### 2.3 生命周期所有权分散

部分 registry 已支持 unregister，但返回值和所有权不一致：

- `ToolRegistry.registerTool()` 返回 `void`，调用方必须记住名字再手动删除。
- `HookRegistry.register()` 返回 `void`，run-scoped hook 依赖调用方保存 handler identity。
- `registerCapability()`、`registerPreset()`、`registerSection()` 修改进程级 map。
- protocol observer、MCP owner、session tool host 等又各自实现独立 dispose 逻辑。

这不表示当前实现必然泄漏，但缺少一个统一规则来证明“谁创建、谁持有、何时释放”。

### 2.4 Transcript 已接近事实日志，但模型请求缺少统一边界证据

`packages/core/src/session/transcript.ts` 已明确把 `transcript.jsonl` 定义为事件日志而非 chat history，消息、tool call/result、summary、context transfer 和 turn boundary 都可从事件读取。与此同时，system prompt、动态上下文、工具目录、配置版本和 hook 注入的最终组合仍主要在 Engine 运行路径中形成。

本设计不要求把所有这些内容原样持久化，而是先建立一个不含密钥的请求边界记录，使调试和测试能够判断“这次模型调用使用了哪一版组合和上下文”。

## 3. 目标与非目标

### 3.1 目标

1. 用一个 `AgentModule` 表达 Core 外所有可信产品模块贡献。
2. 用一份 `ResolvedComposition` 同时驱动 Engine 与 AgentServer。
3. 让所有贡献带稳定 owner、来源、顺序和 lifecycle scope。
4. 编译阶段检测重复 id、工具、preset、prompt、query、behavior profile 和不完整引用。
5. 让运行时激活和释放具备逆序、幂等、失败回滚的统一语义。
6. 保持 ToolExecutor、permission、path policy、sandbox、protocol validation 等现有安全咽喉不变。
7. 提供稳定的 composition snapshot / inspect 数据，支持测试、日志和后续开发 UI。
8. 一次性 cutover：Coding、Arena、Pet 与全部 host 在同一批变更中迁移并删除旧接口，以 breaking release 发布；用 Phase A 的 golden snapshot 证明迁移前后行为一致。
9. 为模型请求增加轻量、脱敏、可校验的 request boundary。

### 3.2 非目标

1. 不引入 Cordis 或其他第三方插件框架。
2. 不取消 Core 的可信内核地位；Engine、TurnLoop、ToolExecutor、Permission、Session 和 Protocol 仍由 Core 拥有。
3. 不允许普通安装插件向进程内加载任意 JavaScript；现有 Skill、Hook、MCP、Command 与 Panel 安全模型保持不变。
4. 不把每个 Core service、helper 或 builtin 都改成插件。
5. 第一阶段不支持运行中热替换模块拓扑。
6. 不借机实现 Code Mode、结构化工具输出或新的 sandbox backend。
7. 不重写 Transcript 为通用 event-sourcing 框架，不迁移现有 Session 文件格式。
8. 不改变现有 preset 工具顺序、权限默认值、prompt 内容、protocol method 或 UI 行为。

## 4. 设计原则

### 4.1 声明与激活分离

模块必须先声明自己可能贡献的内容，Compiler 才能检查并输出组合。激活阶段只创建声明项背后的运行时资源：

```text
declare: tool/query/prompt/hook/service 的 id、scope、顺序和配置
activate: 构造 executor、observer、private service，并登记 disposer
```

禁止在 activator 中调用未经过 Compiler 的通用 `addTool()` / `addPermissionRule()`。否则 inspect 与实际行为会再次漂移。

### 4.2 Core 机制直接依赖，产品扩展走模块边界

Core 内部的 SessionManager、ToolExecutor、PermissionController、PromptComposer 等保持显式 import 与构造依赖。只有 Coding、Arena、Pet 以及未来同级可信产品包通过 `AgentModule` 接入。

### 4.3 安全决定保持单调

Module 只能声明工具、hook 和默认 permission contribution，不能绕过：

- preset/tool visibility；
- ToolExecutor schema validation；
- path policy；
- permission classifier 和用户 approval；
- sandbox；
- protocol ingress validation。

模块 hook 继续遵守现有“只能收紧、不能提升权限”的 clamp 规则。

### 4.4 无隐式覆盖

第一阶段不设计 override 语法。工具名、prompt section、preset、query 和 behavior profile 重复时直接报错，错误必须同时包含冲突 key 与两个 module id。

Settings 中现有 enabled/disabled 工具折叠属于“选择”，不是贡献覆盖，继续在组合后的 catalog 上执行。

### 4.5 确定性优先

贡献顺序为：

1. Core 内建声明；
2. host 显式传入模块的数组顺序；
3. 模块内部声明数组顺序。

除非某个现有协议已规定排序，否则 Compiler 不做字母排序。迁移前后 tool definition、prompt section 和 hook priority/order 必须逐项一致，避免破坏 prompt cache 与行为。

## 5. 核心类型

以下类型用于约束设计，字段名允许在实现阶段按现有类型位置微调，但语义不得改变。

### 5.1 生命周期与 disposer

```ts
export type ModuleScopeKind = "host" | "engine" | "session" | "run";

export type Dispose = () => void | Promise<void>;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type DisposableLike = Dispose | Disposable | void;

export interface LifetimeScope {
  readonly kind: ModuleScopeKind;
  readonly id: string;

  child(kind: ModuleScopeKind, id: string): LifetimeScope;
  own(disposable: DisposableLike): void;
  dispose(): Promise<void>;
}
```

规则：

- `own()` 在 scope 已释放后必须拒绝新资源。
- `dispose()` 幂等，按资源获取的逆序释放。
- 一个 disposer 抛错不能阻止其余 disposer；最终抛出聚合错误或记录完整错误集合。
- child scope 必须在 parent 自有资源之前释放。
- 激活中途失败时，当前 scope 立即回滚，不留下部分注册。
- 注册函数返回的 disposer 自身也必须幂等。

### 5.2 AgentModule

```ts
export interface AgentModule {
  readonly id: string;
  readonly version?: 1;
  readonly engine?: AgentEngineContributions;
  readonly protocol?: AgentProtocolContributions;

  /**
   * Allocate host-lifetime resources required by declarations above.
   * It may not add undeclared protocol-visible entries.
   */
  activateHost?(ctx: HostModuleActivationContext): MaybeDisposable;

  /**
   * Allocate resources private to one Engine instance.
   * It may not add undeclared model-visible entries.
   */
  activateEngine?(ctx: EngineModuleActivationContext): MaybeDisposable;
}

export type MaybeDisposable = DisposableLike | Promise<DisposableLike>;
```

`id` 使用稳定、跨 host 一致的 namespaced 字符串，例如：

- `core`
- `coding`
- `arena`
- `pet`

安装插件名称不自动成为 `AgentModule`；只有可信、随应用发布或由 embedders 显式传入的进程内模块使用此接口。

### 5.3 Engine contributions

```ts
export interface AgentEngineContributions {
  readonly tools?: readonly AgentModuleToolContribution[];
  readonly presets?: readonly AgentPreset[];
  readonly defaultPreset?: string;
  readonly promptSections?: Readonly<Record<string, string>>;
  readonly dynamicContextProviders?: readonly CapabilityDynamicContextProvider[];
  readonly instructionBoundary?: CapabilityInstructionBoundaryFinder;
  readonly artifactDetectors?: readonly CapabilityArtifactDetector[];
  readonly fileHistory?: readonly CapabilityFileHistoryContribution[];
  readonly sessionWorkspace?: SessionWorkspaceCapability;
  readonly hooks?: readonly AgentModuleHookContribution[];
  readonly behaviorProfiles?: readonly RunBehaviorProfile[];
  readonly adjustToolSelection?: CapabilityModule["adjustToolSelection"];
  readonly privateService?: AgentModulePrivateServiceContribution;
}
```

工具只有一条目标贡献路径。原先 `BuiltinTool` 的 preset metadata 与 `ExtensionTool` 的 always-visible
语义由显式 exposure union 表达：

```ts
export interface AgentModuleToolContribution {
  readonly definition: RegisteredTool;
  readonly execute: ExtensionTool["execute"];
  readonly exposure:
    | ({ readonly kind: "preset-tags" } & BuiltinToolExposure)
    | { readonly kind: "always" };
}
```

Core/Coding/Pet 当前的 `BuiltinTool` 适配为 `kind: "preset-tags"`；Arena 当前的普通 `ExtensionTool`
适配为 `kind: "always"`，从而保持它在 registry 中直接可见的既有语义。新模块不得省略 exposure，避免
“忘记声明可见性就默认开放”。Compiler 最终只产出一种 `ResolvedToolContribution`，Engine 不再先建
catalog 后另行注册 extension tool。

实现时直接复用现有 contribution 类型的结构，并在 cutover 中同步去掉 `Capability*` 命名。`privateService` 取代模糊的 `createToolService()`，必须声明 owner 与 lifetime：

```ts
export interface AgentModulePrivateServiceContribution {
  readonly scope: "engine" | "session";
  create(ctx: ModuleServiceHost): unknown | Promise<unknown>;
  dispose?(value: unknown): void | Promise<void>;
}
```

工具只能读取自己 module id 对应的 private service，不开放跨模块匿名 `unknown` 服务查找。

### 5.4 Protocol contributions

```ts
export interface AgentProtocolContributions {
  readonly queries?: Readonly<Record<string, ExtensionQueryHandler>>;
  readonly createObserver?: (host: ProtocolObserverHost) => ProtocolObserver;
  readonly validateRunParams?: (params: Record<string, unknown>) => string | null;
  readonly hiddenSessionKinds?: readonly string[];
}
```

`ExtensionModule.catalogTools` 与普通 `ExtensionModule.tools` 都迁入 `engine.tools`：前者保留
`preset-tags` exposure，后者显式变成 `always`。工具不属于 protocol contribution；query、observer、run
validator 和 hidden Session kind 才属于 protocol 面。`createObserver` 对应现有的 `ExtensionModule.createProtocolObserver`，属有意的简化改名，在 cutover 中一并完成。

### 5.5 ModuleActivationContext

```ts
export interface ModuleActivationContext {
  readonly moduleId: string;
  readonly scope: LifetimeScope;
  readonly resolved: ResolvedModule;
  readonly host: ModuleHostServices;

  own(disposable: DisposableLike): void;
}
```

`ModuleHostServices` 是扩展边界所需服务的窄接口，例如 settings reader、sandbox resolver、SessionManager 与 protocol notifier。它不提供任意字符串 service lookup，也不暴露 Engine 私有字段。

`HostModuleActivationContext` 与 `EngineModuleActivationContext` 在该基础接口上分别暴露自己的窄 host
services。禁止用一个 activator 根据可选字段猜测当前阶段；host 与 engine 生命周期在类型上分开。

## 6. ResolvedComposition

### 6.1 运行时形状

```ts
export interface ResolvedComposition {
  readonly version: 1;
  readonly digest: string;
  readonly modules: readonly ResolvedModule[];
  readonly engine: ResolvedEngineComposition;
  readonly protocol: ResolvedProtocolComposition;
  readonly diagnostics: readonly CompositionDiagnostic[];
}

export interface ResolvedModule {
  readonly id: string;
  readonly order: number;
  readonly source: "core" | "host";
}

export interface ResolvedContribution<T> {
  readonly key: string;
  readonly moduleId: string;
  readonly moduleOrder: number;
  readonly localOrder: number;
  readonly scope: ModuleScopeKind;
  readonly value: T;
}
```

`ResolvedEngineComposition` 至少包含：

- 唯一 tool catalog；
- preset 表与最终 default preset；
- prompt sections；
- dynamic context providers；
- engine hooks；
- behavior profiles；
- artifact/file-history/workspace contributions；
- tool-selection adjusters；
- module private-service declarations。

`ResolvedProtocolComposition` 至少包含：

- query handlers；
- observer factories；
- run validators；
- hidden Session kinds。

### 6.2 可序列化快照

函数、class 和 service instance 不进入日志或 snapshot。Compiler 额外提供纯数据投影：

```ts
export interface CompositionSnapshot {
  version: 1;
  digest: string;
  modules: Array<{ id: string; order: number; source: string }>;
  tools: Array<{ name: string; moduleId: string; presetTags: string[] }>;
  presets: Array<{ name: string; moduleId: string; isDefault: boolean }>;
  promptSections: Array<{ name: string; moduleId: string }>;
  hooks: Array<{ event: string; name: string; priority: number; moduleId: string }>;
  behaviorProfiles: Array<{ name: string; moduleId: string }>;
  queries: Array<{ type: string; moduleId: string }>;
  hiddenSessionKinds: Array<{ kind: string; moduleId: string }>;
}
```

Digest 只基于该规范化快照计算，不基于函数源码、绝对安装路径、对象 identity 或进程随机值。字段排序规则必须写入测试，以保证跨进程一致。

### 6.3 Diagnostics 与 provenance

第一阶段成功结果中的 diagnostics 主要记录非错误信息：

- module 没有任何 contribution；
- protocol-only 或 engine-only module；
- private service 的 scope。

重复 key、未知 preset、冲突 default preset、非法 scope、缺失 companion 等属于编译错误，不得降级为 warning 后继续运行。

## 7. Composition Compiler

建议新增内部目录：

```text
packages/core/src/composition/
  types.ts
  compiler.ts
  snapshot.ts
  lifetime-scope.ts
  activate.ts
```

公开扩展类型从 `@cjhyy/code-shell-core/extension` 导出；Compiler/activator 在稳定前留在
`@cjhyy/code-shell-core/internal`，避免过早扩大稳定 API。

### 7.1 输入

```ts
interface CompileCompositionOptions {
  core: AgentModule;
  modules?: readonly AgentModule[];
  /** Module ids the host requires; missing ids are a compile error. */
  expectedModules?: readonly string[];
  hostKind?: "sdk" | "tui" | "desktop" | "server";
}
```

`requestedPreset` 不进入编译输入：preset 每 session 可经 config slice 指定、可被 settings 热更新经
`refreshRuntimeConfig()` 切换，host 启动时无法预知。composition 只携带 preset 表与唯一 default，
per-session 的选择与校验由运行时 `resolveAgentPreset()` 对照 resolved 表完成，查不到照样 fail loud，
只是时机在真正使用时。

`expectedModules` 用来杜绝 loader 静默跳过模块的故障模式：现状 `loadConfiguredExtensionModules()`
加载失败仅 `logger.warn` 后跳过，事后表现为 `unknown behavior profile: pet` 一类难排查错误。

Core 的 builtin tools、builtin presets、builtin prompt sections 与基础 behavior profile 通过一个内部
`CORE_AGENT_MODULE` 进入同一 Compiler，但这只是统一数据路径，不表示 Core 可以卸载或被普通模块覆盖。

### 7.2 编译与校验顺序

1. 校验 module id 非空、格式合法、全局唯一。
2. 固定 module order：Core 为 0，host 模块按输入顺序递增。
3. 收集 engine/protocol 声明并附加 provenance。
4. 校验 tool name 唯一；普通 extension tool 与 catalog tool 先规范化为同一 resolved tool 后再校验。
5. 校验 preset name、prompt section name、behavior profile name和 query type 唯一。
6. 解析唯一 default preset；多个模块声明不同 default 时 fail loud。
7. 校验 default preset 存在；校验 `expectedModules` 全部到位。
8. 校验每个 preset 引用的 builtin tool 与 prompt section 存在。
9. 校验 builtin tool companion、preset tag 和 permission contribution 的现有不变量。
10. 规范化 hook priority/name。缺省名称必须包含 module id 与本地序号。
11. 校验 hidden Session kind、run validator 和 protocol observer 的所有权。
12. 生成可序列化 snapshot 与 digest。
13. 冻结最终结果，返回 `ResolvedComposition`。

所有错误使用 `ConfigError` 或新的 `CompositionError`，结构化 metadata 至少包含：

```ts
{
  code: "duplicate_tool",
  key: "ToolName",
  firstModuleId: "coding",
  secondModuleId: "pet"
}
```

### 7.3 Compiler 不负责的内容

- 不读取用户 settings 或文件系统。
- 不连接 MCP，不创建 sandbox，不启动 observer。
- 不按当前 credential/feature flag 动态过滤工具。
- 不执行动态 context provider。
- 不实例化 Engine 或 AgentServer。

这些属于 activation 或现有 per-run selection 阶段。

## 8. Activation 与生命周期

### 8.1 Host activation

Host 在创建 ChatSessionManager / AgentServer 前编译一次 composition。Host scope 负责：

- protocol observer；
- protocol query registration；
- host-level module resource；
- host 关闭时的完整释放。

AgentServer 只读取 `resolved.protocol`，不得再次遍历原始 `AgentModule[]`。

### 8.2 Engine activation

每个 Engine 从同一 `ResolvedComposition` 建立 engine child scope，负责：

- ToolRegistry 的 engine-local catalog/view；
- engine hooks；
- module private services；
- prompt/preset/dynamic context 的只读组合引用。

Engine 关闭时释放 engine scope。EngineRuntime 共享资源仍由其当前 owner 持有，不因模块化而复制到每个 Engine。

### 8.3 Session 与 Run scope

第一阶段不要求产品模块贡献任意 session/run activator，但基础 scope 必须存在，供现有生命周期逐步接入：

- Session scope：session tool host、session-owned MCP owner、approval owner 等。
- Run scope：GoalStopHook、file-history hook、run-local abort handle 等。

迁移规则是“只搬所有权，不改变行为”。例如 `HookRegistry.register()` 改为返回 disposer 后，run scope 直接
`own()` 该 disposer，替代在 `finally` 中重复保存 handler identity 和手工 unregister。

### 8.4 Registry 返回值统一

现有的两个真实 registry 渐进改成返回幂等 disposer：

```ts
ToolRegistry.registerTool(...): Dispose;
HookRegistry.register(...): Dispose;
```

preset、prompt section 与 protocol query 目前没有对应的 registry 类，不适用"改返回值"：

- preset 现状是 `preset/index.ts` 的模块级 `_customPresets` Map + `registerPreset()`；prompt section 现状是
  `registerSection()` 的模块级 map + `composePromptSections()` 纯函数一次性合并。两者的声明在 cutover 中直接
  进 composition，旧入口与模块级 map 一并删除，不需要 disposer。
- protocol query 现状是 AgentServer 私有 Map，经 `ProtocolObserverHost.registerQuery` 填入且只 set 不
  delete。改造后由 host scope 登记 disposer，并补齐删除路径。

保留显式 `unregisterX()` 作为内部入口时，也必须与 disposer 走同一个实现，不能形成两套删除逻辑。

## 9. Engine、Protocol 与 Host 接线

### 9.1 EngineConfig 迁移

目标接口：

```ts
interface EngineConfig {
  composition?: ResolvedComposition;
  modules?: readonly AgentModule[];
}
```

规则：

1. `composition` 与 `modules` 互斥，同时传入直接报错。
2. `modules` 是 SDK/library consumer 的便利入口，Engine 内部编译一次；这是长期 API，不是过渡层。
3. product host 必须在 host root 编译并传 `composition`，避免每个 Engine 重复编译或与 AgentServer 漂移。
4. 旧字段 `capabilities` / `extensionModules` 在 cutover 中直接删除，不保留 deprecated 别名。

### 9.2 AgentServer

AgentServer 目标上只接收：

```ts
interface AgentServerOptions {
  composition: ResolvedComposition;
  // existing transport / chatManager / legacy engine fields...
}
```

旧的 `extensionModules` 选项在 cutover 中直接删除。AgentServer 只读取 `resolved.protocol`，不接受原始模块数组；不存在"composition 与模块合并编译"的路径——ResolvedComposition 是编译产物，无法作为编译输入再合并，模块合并只能发生在 `compileComposition()` 的输入侧。

### 9.3 Hosts

- Desktop worker：显式加载 Coding、Arena、Pet factory，编译一次后创建 manager/server/engines。现状的两条装配路径都要拆掉：coding 的 bin wrapper（`packages/coding/src/bin/agent-server-stdio.ts`，import 时全局 `registerCapability`）删除；Desktop **main 进程**自身的 `registerCapability(CODING_CAPABILITY)` 一并移除。
- TUI：显式加载 Coding、Arena；不再依赖 `registerCapability()` 修改进程全局状态。
- Server/Headless：现状 spawn coding worker 时不注入任何模块（headless 实际只有 Coding）；cutover 中按发行能力显式注入模块，不因为 npm package 被安装就自动启用。
- SDK：默认只使用 Core；consumer 显式传 `modules`。

环境变量 `CODE_SHELL_CAPABILITY_MODULES` 是跨进程接线机制而非兼容层，保留；loader 的输出必须是 `AgentModule[]`，并在 host root 进入同一 Compiler。loader 不得在 import 时产生全局注册副作用（现状真正的 import 副作用在 coding bin wrapper，一并删除），加载失败不再静默 warn-skip——缺失的期望模块由编译输入的 `expectedModules` fail loud。

## 10. Inspect 与调试接口

Compiler 必须先提供纯函数：

```ts
toCompositionSnapshot(composition: ResolvedComposition): CompositionSnapshot;
```

随后增加内部 protocol query，例如 `composition_snapshot`，只返回纯数据且不包含：

- executor 函数；
- prompt 正文；
- credential、环境变量或绝对安装路径；
- private service value；
- observer/handler closure。

首个产品消费者可以只是日志或开发测试，不要求本期增加 Desktop 正式 UI。CLI 后续可提供：

```text
codeshell inspect-composition
```

Inspect 的主要用途是回答：

- 当前有哪些 module？
- tool/preset/prompt/hook/query 的 owner 是谁？
- 默认 preset 从何而来？
- Engine 与 protocol 是否使用同一个 composition digest？

## 11. 轻量模型请求证据

本阶段在模块统一完成后单独实施，不阻塞前述迁移。

### 11.1 新事件

在每次主 agent 模型请求真正发出前，向 Transcript 追加或通过现有 recorder 记录：

```ts
interface ModelRequestBoundaryData {
  requestId: string;
  turn: number;
  step: number;
  provider: string;
  model: string;
  compositionDigest: string;
  systemPromptDigest: string;
  toolCatalogDigest: string;
  messageDigest: string;
  /** Engine 的 lastAppliedConfigVersion（server reloadSettings 单调计数器）；此前从未持久化，是新字段。 */
  configVersion: number;
  sourceEventRange?: {
    fromEventId: string;
    toEventId: string;
  };
}
```

### 11.2 隐私和语义

Transcript 默认只记录 digest 和事件锚点，不复制完整 system prompt、动态上下文或工具参数。digest 分两层，校验能力不同：

- `compositionDigest` 与 `toolCatalogDigest` 是无 key 的规范化摘要：内容非敏感，跨进程、resume 后均可重算比对。`compositionDigest` 来自 `ResolvedComposition` 快照。
- `systemPromptDigest` 与 `messageDigest` 是 keyed HMAC：key 为 Session 级持久化 key，存入现有凭证加密边界（safeStorage 一线），不得与 transcript 同目录落盘。**不能复用** prompt-cache diagnostics 的进程级随机 key（`randomBytes(32)`，进程重启即失效，resume 后 digest 永远对不上，§11.3 不变量 3 将无法成立）；也不能记录裸敏感值的普通 hash（低熵内容可被字典攻击还原）。
- `messageDigest` 对实际发送给 provider 的规范化 message projection 计算。
- 该事件只证明请求版本与可校验一致性，不宣称仅凭 digest 可以恢复完整 request。
- 完整模型请求目前由 dev-gated 的 session-recorder 记录（`CODE_SHELL_DEV`/`--debug` 判定，写盘为完整 prompt/messages，仅图片 base64 脱敏）。本阶段要求把它改为显式诊断开关并如实标注记录范围；扩大脱敏范围可另行跟进。

### 11.3 不变量

测试和可选 debug invariant 检查：

1. 每次主模型调用恰有一个 request boundary。
2. boundary 位于对应 request 之前，且属于当前开放 turn/step。
3. 从 Transcript 派生的 message 部分与实际发送 messages 的 digest 相同。
4. 实际 tool definitions digest 等于 boundary 的 tool catalog digest。
5. Engine 与 AgentServer/host 报告的 composition digest 一致。

校验范围：不变量 1、2、5 与无 key digest（composition/tool catalog）跨进程可验；keyed digest（system prompt/message）只有能取到该 Session key 的进程可验——resume 场景由此覆盖，纯离线读 transcript 不可验。

辅助模型调用（summary、title、goal judge、memory）第一阶段不进入主 Session request boundary；它们继续由现有 recorder 区分，避免混淆主对话重放语义。

## 12. 迁移计划

### Phase A：Compiler 与 golden 基线（无行为变化）

1. 新增 `composition/` 内部类型、Compiler、snapshot 与单元测试。
2. 从现行旧路径导出 golden 数据：用当前 Core + Coding + Arena + Pet 真实组合，转储工具顺序、preset、
   prompt section、hook、behavior profile、query 与 hidden kind 为 checked-in golden 文件，并在文件头
   标注生成时的基线 commit。
3. 不需要 `fromCapabilityModule()` 一类长期 adapter；若转储需要临时桥接代码，只允许存在于测试目录。

完成标准：新代码尚未驱动生产路径；golden 完整描述当前组合，Compiler 能捕获所有冲突。

### Phase B：一次性 cutover（breaking release）

单个 PR 合入（内部按包分 commit 便于 review 与 bisect），同时完成：

1. 产品模块改型：Coding 由常量 `CODING_CAPABILITY` 改为返回 `AgentModule` 的工厂；Arena 迁移普通 tools
   与 queries（它没有 catalogTools 和 behaviorProfiles）；Pet 迁移 catalogTools、behaviorProfiles、
   protocol observer、run validator 与 hidden kinds（它没有 queries）。
2. Engine 改读 `ResolvedComposition`，合并 `composeToolCatalog()` 与 `registerExtensionModules()` 的
   双工具路径；AgentServer 只接收 composition；ChatSessionManager 创建新 Engine 时传同一 composition。
3. 全部 host 切换：Desktop worker 与 main 进程、coding bin wrapper 删除、TUI、Server/Headless 显式注入
   模块、SDK；host loader 与测试 fixtures 改为统一 factory 类型。
4. 删除旧接口与全局状态：`CapabilityModule`、`ExtensionModule`、`registerCapability()` /
   `unregisterCapability()` / `listRegisteredCapabilities()`、`registerPreset()` 与 `_customPresets`、
   `registerSection()`、`composeToolCatalog()`、`registerExtensionModules()`；同时改掉 `RunManager` 与
   `session/session-manager.ts` 中无参 `resolveCapabilities()` 的进程全局读取（不改则 §16 第 6 条的
   双 composition 隔离过不了）。
5. 断言新 Compiler 输出与 Phase A golden 逐项相等；现有 Engine/协议/smoke/boundary/bypass/export 测试
   全部通过（`index.exports.test.ts` 等断言旧导出面的测试同步更新）；增加 Engine 与 AgentServer 的
   digest 一致性测试。
6. `@cjhyy/code-shell-core` 以 breaking 版本发布，更新 `/extension` 稳定 API 表与 package-release smoke。

完成标准：产品代码中不存在旧模块类型；不存在 Engine 和 AgentServer 分别解析模块数组的路径；新 host 可以
在同一进程创建两份不同 composition，不发生跨实例污染。

### Phase C：生命周期 disposer

1. 实现 `LifetimeScope`。
2. 让 ToolRegistry、HookRegistry 和 protocol query 注册返回 disposer。
3. 先接 run-scoped hook，再接 engine/host activation。
4. 为每类 registry 增加 dispose/reload/partial-failure 测试。

完成标准：新模块资源只由 scope 所有，不再依赖 remove-by-prefix 或手工保存 handler identity。

### Phase D：Request boundary

在模块组合稳定后实现 §11，不与前面阶段混在同一 PR。

## 13. 测试与验收标准

### 13.1 Compiler

- 相同输入产生字节一致的 snapshot 与 digest。
- module order 改变时，只有顺序相关输出和 digest 合理变化。
- 重复 module/tool/preset/prompt/query/behavior profile 明确失败并报告双方 owner。
- 冲突 default preset、未知 requested preset、缺失 tool/prompt 引用明确失败。
- cutover 后 Compiler 输出与 Phase A golden（含基线 commit 标注）逐项一致。
- 输入对象不会被 Compiler 修改；结果被冻结或按只读契约保护。

### 13.2 Scope 与激活

- disposer 逆序执行且幂等。
- child scope 先于 parent resource 释放。
- 中间 activator 抛错时，已安装贡献全部回滚。
- 一个 disposer 抛错时其他 disposer 仍执行。
- Engine A 释放不会移除 Engine B 的同名、不同 registry 实例贡献。
- Session/Run 结束后 hook、approval owner、MCP owner 与 tool host 不残留。

### 13.3 行为兼容

- Core-only SDK 默认仍为 `harness-min`。
- Desktop/TUI 仍获得 Coding 默认 preset 和当前工具集合。
- Arena 的工具与 query，Pet 的工具、behavior profile、protocol observer、run validator 与 hidden kind 行为不变。
- ToolExecutor 所有权限、路径、schema、hook clamp、sandbox 和 abort 测试保持通过。
- architecture/package boundary、engine bypass、core export 与 release smoke 保持通过。

### 13.4 真实组合

- TUI composition smoke。
- Desktop worker composition smoke，不要求启动完整 renderer。
- Server/headless Core-only 与产品模块组合 smoke。
- 同进程两份 composition 隔离测试。
- built package 通过 `@cjhyy/code-shell-core/extension` 创建模块的 consumer smoke。

### 13.5 Request boundary

- 普通文本、图片、tool batch、steer/inject、compaction 后续请求的 digest 对齐。
- hook 动态注入和工具可见性变化会改变对应 digest。
- 日志不出现 system prompt 正文、credential 或敏感动态上下文。
- resume 后 composition digest 变化可被诊断，但不能静默伪装成同一运行版本。

## 14. 风险与控制

### 14.1 过度动态化

风险：统一模块后继续把 Core 内部实现都搬到运行时 service lookup，降低可读性和类型安全。

控制：AgentModule 只面向可信产品扩展；Core 内部直接依赖。新增 generic service key 需要单独设计评审。

### 14.2 Compiler 成为新的巨型文件

风险：把原 Engine 构造复杂度原样搬进一个 `compiler.ts`。

控制：按 engine/protocol/validation/snapshot 拆纯函数；Compiler 不做 I/O 和资源创建；增加文件增长预算前先提取。

### 14.3 Inspect 泄露实现或敏感数据

风险：snapshot 误带 prompt 正文、路径、credential 或 handler 信息。

控制：只允许显式白名单纯数据字段；snapshot schema 测试拒绝未知字段；protocol query 再做大小上限。

### 14.4 生命周期改造引入双重释放

风险：迁移期 scope disposer 与旧 `finally` 同时执行。

控制：每个子系统一次只保留一个 owner；disposer 幂等；PR 按 registry 逐个迁移，不做全局机械替换。

### 14.5 Prompt/tool 顺序漂移

风险：Compiler 规范化或排序改变 provider cache key 与模型行为。

控制：golden snapshot 要求迁移前后数组逐项相等，不只比较 set；除明确协议外禁止自动字母排序。

### 14.6 Public API 扩大

风险：过早发布 Compiler 细节，后续无法调整。

控制：第一阶段只把 `AgentModule` 与必要 contribution 类型放 `/extension`；Compiler、ResolvedComposition 构造器和 activation 留 `/internal`。等 Coding/Arena/Pet 与三个 host 完成迁移后，再决定是否公开只读 snapshot API。

### 14.7 一次性 cutover 的回归面

风险：单个 breaking PR 同时改 Engine、AgentServer、三个产品包和四类 host，回归面大，且没有兼容层可以退回半迁移状态。

控制：Phase A golden 先行合入，作为唯一且充分的行为基线；cutover 内部按包分 commit，便于 review 与 bisect；依赖既有 smoke、boundary、bypass、export 守卫测试整体把关；失败整体回滚，不留中间态。

## 15. 与 DeepSeek Harness 的关系

本设计借鉴其三个总体思想：

1. 注册有明确生命周期并可逆释放。
2. 运行中的 agent 是一份可检查的组合，而不是散落的隐式全局状态。
3. 模型可见请求应有持久或可校验的事实证据。

本设计明确不采用其“没有特权 Core / 一切皆插件”的完整范式。CodeShell 继续把 Engine、ToolExecutor、Permission、Protocol 和 Session 作为稳定可信内核，只让产品能力经过统一边界组合。

## 16. 最终完成定义

只有同时满足以下条件，本设计才算落地：

1. Coding、Arena、Pet 都返回 `AgentModule`。
2. Desktop、TUI、Server/Headless 与 SDK 的产品路径使用统一 Compiler。
3. Engine 与 AgentServer 使用同一 `ResolvedComposition` 和 digest。
4. Capability/Extension 双工具注册路径被删除。
5. 模块级注册均由明确 scope 持有并可逆释放。
6. 同进程两份不同 composition 的隔离测试通过。
7. Inspect snapshot 能准确列出工具、preset、prompt、hook、query 与 owner，且不泄露敏感数据。
8. 现有安全门、协议行为、工具顺序和默认 preset 没有非预期变化。
9. Request boundary 阶段有独立测试证明 digest 与真实模型请求一致。
10. `CapabilityModule` / `ExtensionModule` 及 `registerCapability()` / `registerPreset()` / `registerSection()` 等全局入口已从公开导出面删除，breaking 版本已发布。
