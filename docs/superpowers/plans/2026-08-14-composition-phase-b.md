# Composition Phase B Implementation Plan（一次性 cutover, breaking release）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine 与 AgentServer 全部改读 `ResolvedComposition`；Coding/Arena/Pet 改为 `AgentModule` 工厂；全部 host 切换；删除 `CapabilityModule`/`ExtensionModule`/全局注册入口；golden 逐项相等；breaking 版本。

**Architecture:** 单分支多 commit，每个 commit 全绿。commit 1-3 让 core 内部先跑在 composition 上（旧 config 字段经**仓内临时桥**继续工作），commit 4-5 切产品与 host，commit 6 删除全部旧接缝与桥，commit 7 版本+文档。最终树上没有旧接口。

**Tech Stack:** 同 Phase A。golden fixture `tests/fixtures/composition-golden.json`（基线 commit 35e0f7c4）是行为不变的唯一证据，**cutover 全程禁止改 fixture 数据**。

**执行纪律：** 分支 `composition-cutover`；只 `git add` 点名文件；不跑 repo-wide format；改 core 后跑下游包测试前先 `bun run --filter '@cjhyy/code-shell-core' build`（pet/coding/arena 测试吃 core dist）。

**关键语义规则（来自侦察，实施时不得偏离）：**

1. **catalog 注入规则**：旧行为是 extensionModules 的 `catalogTools` 强制并入 active preset（builtinTools + defaultPermissionRules + enabledBuiltinTools），coding 的 capability tools 不注入（其 preset 已经由 tag 派生包含它们）。统一后规则改写为：**preset-tags 工具中，owning module 未贡献任何 preset 的（pet/arena 类），强制并入 active preset**；贡献了 preset 的模块（core/coding）不注入。该规则从 composition 可推导，数据上与现状逐项一致。
2. **behaviorProfiles 合并顺序**保持：core 两个 → `config.behaviorProfiles`（host 配置）→ 模块贡献（Map last-wins）。composition 中 core 的 profiles 用 `moduleId === "core"` 切出来放最前。
3. **queries 双通道**保持：AgentServer 先查 `protocolQueryHandlers`（observer 的 registerQuery），未命中经 server.ts:3524 兜底 `engine.queryCapability` —— engine 改读 `this.composition.protocol.queries`（TUI 的 arena_status 依赖这条兜底路径）。
4. **preset 解析**：新增 `resolvePresetFromComposition(composition, name?)`：name ?? `composition.engine.defaultPreset`，在 `composition.engine.presets` 里找，找不到 fail loud 并列出可用名。`_customPresets`/`registerPreset` 删除；`defineProduct` 改为把 preset 通过合成 AgentModule (`{id:"product", engine:{presets:[p], defaultPreset:p.name}}`) 传入自己创建的 runner，不再全局注册。
5. **resolveBuiltinToolNames** 改签名：`{ preset: AgentPreset; host?; enabledBuiltinTools?; disabledBuiltinTools?; adjusters?: readonly ((names: Set<string>, ctx: {preset: string; host?: string}) => void)[] }` —— 不再接 capabilities/preset 名。调用方自己先解析 preset。
6. **loader fail loud**：`loadConfiguredAgentModules()` 解析 `CODE_SHELL_CAPABILITY_MODULES`，任何 import/工厂失败直接 throw（不再 warn-skip）；解析出的 module id 列表即 `expectedModules` 传给 compiler。
7. **dream-service 保行为**：其 seed Engine 现靠全局注册拿到 coding（默认 preset terminal-coding）。切换后显式传 `modules: [createCodingModule()]`。
8. **session-manager** 删除无参 `resolveCapabilities()` fallback（:470）；Engine 从 composition 传 workspace；`cli/agent-server-stdio.ts:392` 的 goalDiskReader 显式传 composition 的 workspace capability。
9. **类型保留**：`ExtensionTool`/`ProtocolObserver`/`ProtocolObserverHost`/`ExtensionQueryHandler`/`BuiltinTool` 及 `Capability*` 贡献小类型（provider/detector/hook 等）保留（AgentModule 引用它们）；删除的是 `CapabilityModule` 与 `ExtensionModule` 两个接口及其全套注册/组合函数。`Capability*` 改名推迟为后续美化（更新设计稿 §5.3 措辞）。

---

## 消费点清单（侦察结果，执行时照此逐一处理）

### Engine（packages/core/src/engine/engine.ts）
- :573-574 resolveCapabilities → 改为 resolve composition（见 Task 1 代码）
- :575-579 composeToolCatalog → composition preset-tags 工具的 BuiltinTool 列表
- :596-604 behaviorProfiles 合并 → 规则 2
- :604 composePromptSections → `composition.engine.promptSections` 转 Record
- :605 composeDynamicContextProviders → values
- :606 resolveAgentPreset → resolvePresetFromComposition
- :611-628 extensionCatalogTools preset 注入 → 规则 1
- :656-672 resolveBuiltinToolNames → 规则 5（enabled 里并入规则 1 的注入名单）
- :674 registerExtensionModules → 遍历 composition always 工具 registerTool（保留 hasTool 冲突检查）
- :697 composeCapabilityEngineHooks → composition.engine.hooks 逐个 register
- :705-708 sessionWorkspace → composition.engine.sessionWorkspaces[0]?.value
- :877-881 queryCapability → composition.protocol.queries（规则 3）
- :2283-2285 fileHistory → composition.engine.fileHistory values
- :2598-2599 resolveInstructionBoundary → 遍历 composition.engine.instructionBoundaries 首个非 null
- :3268/:3275/:3283 preset 热重载 → resolvePresetFromComposition + 规则 5
- :4108-4128 capabilityServices → composition.engine.toolServices 逐个 create，key=moduleId
- subagent-spawner.ts:327-328 继承 → 传 `composition: deps.parentConfig 解析后的 composition`（给 EngineConfig 加只读缓存或直接传 modules）

### Run API
- run/RunManager.ts:130-149（capabilities→composition detectors）、run/EngineRunner.ts:116,194、run/factory.ts:89-123 —— `capabilities` 字段全部换成 `modules?: readonly AgentModule[]`，内部编一次 composition
- product/define.ts:125 registerPreset → 合成 AgentModule（规则 4）

### AgentServer（packages/core/src/protocol/server.ts）
- :492 options.extensionModules → `composition?: ResolvedComposition`
- :650-653 hiddenSessionKinds → resolved.protocol.hiddenSessionKinds
- :674-682 observer → resolved.protocol.observerFactories
- :1251-1256 run validator → resolved.protocol.runValidators
- :485-491 过期 doc（默认 pet）一并修正

### Hosts
- core cli agent-server-stdio.ts：loader 改 AgentModule + fail loud；compile 一次；:181/:296/:397 传 composition；:392 goalDiskReader 传 workspace
- core cli agent-server-tcp.ts：compile core-only composition
- coding bin wrapper `packages/coding/src/bin/agent-server-stdio.ts` **删除**；coding package.json 的 bin/exports 条目同步删；desktop/server 改 resolve `@cjhyy/code-shell-core/bin/agent-server-stdio`
- desktop agent-bridge.ts:137,145-146,276-282：entry→core bin；env 串加 coding（`${codingModule}#createCodingModule,...`）
- desktop index.ts:50,105,520：删 registerCapability
- desktop dream-service.ts:73-81：加 `modules: [createCodingModule()]`
- desktop capabilities-service.ts:29-48：用 compileComposition + resolvePresetFromComposition + adjusters 重写
- server serve/cli.ts:78-81 resolveWorkerEntry→core bin；headless-server.ts:161 buildEnv 注入 `CODE_SHELL_CAPABILITY_MODULES=<coding>#createCodingModule`
- TUI main.ts:13,21 删 registerCapability；repl.ts:35,150,158,187,279 → modules+composition（cron engine 用 `[createCodingModule()]` 编的 composition，保持"有 coding 无 arena"现状）

### 删除清单（commit 6）
- capabilities/index.ts：`CapabilityModule` 接口、installedCapabilities、register/unregister/list/resolveCapabilities、composeToolCatalog、composePromptSections、composeDynamicContextProviders、composeArtifactDetectors、composeCapabilityEngineHooks、resolveInstructionBoundary（小贡献类型保留）
- tool-system/capability-module.ts：`ExtensionModule`、registerExtensionModules、queryExtensionModules、validateExtensionModules（ExtensionTool/Observer/Host/QueryHandler 保留）
- preset/index.ts：registerPreset、_customPresets（listPresetNames 改签名或删）
- prompt/section-loader.ts：registerSection、_customSections
- engine/types.ts:56-59：capabilities、extensionModules 字段
- server.ts：extensionModules option
- core 内临时桥 `composition/legacy-bridge.ts`
- index.ts:181-183,216-217,336,344；index.extension.ts:91；index.exports.test.ts:276 → 换成 AgentModule 面

### 测试更新清单（commit 6 内）
- capabilities/index.test.ts → 改写为 compiler 行为测试或删（golden 已覆盖）
- tool-system/registry-defaults.test.ts:59-89 → 用 compiler 冲突 + engine always-tool 注册路径重写
- engine.prompt-cache.test.ts:184,267、turn-loop-goal-lifecycle.test.ts:2470,2540、__tests__/engine-config-hot-reload.test.ts:33 → `capabilities: [x]` 改 `modules: [fromCapabilityModule 等价的手写 AgentModule]`
- pet: engine.pet-behavior.test.ts、server.pet-projection.test.ts、server.pet-pending.test.ts → `modules:[createPetModule()]` / `composition:`
- coding: capability.test.ts、preset.test.ts、integration/engine.workspace-cwd.test.ts、session-manager.workspace-resume.test.ts → 新工厂/新签名
- arena: capability.test.ts → 新工厂
- tests/composition-golden.test.ts → 删 legacy dump 与 bridges，改为 `compileComposition({modules:[createCodingModule(),createArenaModule(),createPetModule()]})` 的 snapshot 必须等于 **原 fixture**（fixture 不动，baselineCommit 不动）
- tests/helpers/composition-bridges.ts 删除

---

## Tasks

### Task 0: 分支
- [ ] `git checkout -b composition-cutover`

### Task 1: core 内部桥 + Engine 跑在 composition 上（commit 1）
**Files:** Create `packages/core/src/composition/legacy-bridge.ts`（Phase A tests/helpers 的两个 from* 函数搬进 core，标注 cutover 结束即删 + 合并进程全局注册表）；Create `packages/core/src/composition/resolve-preset.ts`（resolvePresetFromComposition + 注入名单推导 `presetInjectedToolNames(composition)` 规则 1）；Modify engine/types.ts（加 `composition?/modules?`，旧字段标注即将删除）；Modify engine.ts 全部消费点；Modify preset/index.ts（resolveBuiltinToolNames 新签名，旧签名暂留给未迁调用方）；Modify subagent-spawner.ts。

- [ ] Engine ctor 顶部：
```ts
this.composition =
  config.composition ??
  compileComposition({
    modules: [
      ...resolveCapabilities(config.capabilities).map(fromCapabilityModule),
      ...(config.extensionModules ?? []).map(fromExtensionModule),
      ...(config.modules ?? []),
    ],
  });
```
- [ ] 逐点替换上表 Engine 消费点；每替换一处跑 `bun test packages/core/src/engine tests/engine-config-hot-reload.test.ts tests/composition-golden.test.ts`
- [ ] `bun test`（全量）绿后 commit：`refactor(core): engine reads ResolvedComposition internally`

### Task 2: Run API + session-manager + AgentServer（commit 2-3）
- [ ] RunManager/EngineRunner/factory/defineProduct 按上表；session-manager 删 :470 fallback；AgentServer options 加 `composition?`，内部消费点换 resolved.protocol（`extensionModules` 选项暂留桥：转 fromExtensionModule 编译）
- [ ] 全量绿后各自 commit

### Task 3: 产品工厂（commit 4）
**coding** `packages/coding/src/module.ts`：
```ts
export function createCodingModule(): AgentModule {
  return {
    id: "coding",
    engine: {
      tools: CODING_TOOLS.map((tool) => ({ kind: "preset-tags" as const, tool })),
      presets: [CODING_GENERAL_PRESET, TERMINAL_CODING_PRESET],
      defaultPreset: "terminal-coding",
      promptSections: CODING_PROMPT_SECTIONS,
      dynamicContextProviders: [gitDynamicContextProvider],
      instructionBoundary: findCodingInstructionBoundary,
      artifactDetectors: CODING_ARTIFACT_DETECTORS,
      fileHistory: CODING_FILE_HISTORY,
      sessionWorkspace: CODING_SESSION_WORKSPACE,
      adjustToolSelection: codingAdjustToolSelection,
      createToolService: createCodingToolService,
    },
  };
}
```
（各常量按 index.capability.ts 现有字面量提取；CODING_CAPABILITY 删除。）
**arena** `createArenaModule()`：tools=always（arenaTool）、protocol.queries={arena_status}。
**pet** `createPetModule()`：engine.tools=catalogTools 转 preset-tags、behaviorProfiles；protocol.createObserver/validateRunParams/hiddenSessionKinds。
- [ ] 各包测试改新工厂；`bun run --filter '@cjhyy/code-shell-core' build` 后跑 coding/arena/pet 测试；commit

### Task 4: hosts 切换（commit 5）
- [ ] 按上表 host 清单逐个改；desktop 打包路径验证：`require.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio")` 在 desktop main 可解析
- [ ] `bun run build && bun test` 全绿；commit

### Task 5: 删除旧接缝（commit 6）
- [ ] 按删除清单与测试更新清单执行；golden fixture 逐字节不变
- [ ] `bun test && bun run typecheck && bun run lint`（engine-bypass/boundary 守卫必须过）；commit

### Task 6: 版本、文档、收尾（commit 7）
- [ ] workspace 版本 0.8.11 → 0.9.0（对照上一个 `chore: release` commit 的改法）
- [ ] 设计稿状态更新：README 行改"Phase A/B 已落地"；设计稿补：catalog 注入推导规则、createToolService 暂不改名、defineProduct 合成模块、`Capability*` 类型名保留为后续美化
- [ ] `bun run test:core-exports && bun run test:package-release`
- [ ] merge 回 main（ff），删分支
