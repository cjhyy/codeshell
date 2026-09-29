# Arena Step 1 — 摘掉全部调用点,保留包与源码

日期:2026-09-23
分支:`codex/arena/remove-call-sites`
状态:调用点移除与 main 冲突整合已完成；构建、类型、发布包和回归检查通过

## 背景

`packages/arena`(50 个生产文件 / 约 10k LOC)事实上已停止演进。`packages/arena/src`
的全部 Git 历史只有 7 个非发版提交,没有一个是 arena 自身的功能开发:

```
1b634a22 refactor!: delete the legacy capability/extension composition seams
842b97e9 feat: coding/arena/pet ship AgentModule factories
54ddfeab chore(lint): prefer-const 修正
c8d409af fix: 收口发布链与 review 首批缺陷
07410d10 refactor(packages): package boundaries and release units
1bb1df75 merge: integrate architecture debt migration
e0ab4577 refactor: complete architecture debt migration
```

全部是被动跟随跨包重构。近 90 天 53 个涉及 arena 的提交中,42 个是 `chore: release 0.x`
版本号 bump。同期对比:core 659、desktop 801、pet 109、coding 93。

产品所有者确认无人使用。代码仍在每次发版被 bump、build、typecheck、audit,构成
纯维护税。

## 目标

让 arena 在两个宿主中都不再被加载、不再对用户可见、不再进入发布流水线。

## 非目标

- 不删 `packages/arena/`
- 不改 arena 自身源码
- 不删 `packages/tui/src/cli/commands/arena.ts`
- 不迁移、不清理用户 settings 数据

**Step 1 必须完全可逆:revert 单个 commit 即恢复。** 这是保留包而非直接删除的全部
理由 —— 删用户数据或删源码都会破坏可逆性。

## 已确认的三个范围决策

1. **ModelManager 的 Arena tab 一起摘掉** —— 保留一个配置面板去配一个已不加载的
   能力是纯误导:用户存了参与者却没有任何东西会消费它。
2. **用户 `settings.json` 里的 `capabilities.arena.participants` 原样留着,不读不写** ——
   Step 2 真删包时再决定。
3. **`/arena` CLI 命令整个注册删掉** —— 帮助文本里不再出现不工作的命令。

## 改动清单

### ① TUI 组装根 — `packages/tui/src/cli/commands/repl.ts:152-156`

```ts
modules: [createCodingModule()],
expectedModules: ["coding"],
```

删 `createArenaModule` import。`expectedModules` 是 `compileComposition` 的断言
(`packages/core/src/composition/compiler.ts:50`),留着 `"arena"` 会直接抛错 ——
**必改项**。

`cronComposition` 本来就只有 coding;两者现已一致,原注释中"cron engine 单独
coding-only(arena is interactive)"的对比失去意义,需重写。

### ② TUI CLI 命令

- `packages/tui/src/cli/main.ts:147-169` — 删整个 `.command("arena")` 注册块
- `packages/tui/src/cli/commands/builtin/extra-commands.ts:16` — 从斜杠命令列表摘掉
  `"arena"`,否则 REPL 内 `/arena` 仍会提示
- `packages/tui/src/cli/arena-options.test.ts` — 删(因 ② 失效)

`packages/tui/src/cli/commands/arena.ts` 保留在磁盘。

### ③ TUI ModelManager 的 Arena tab

- `ModelManager.tsx` — 删 `ArenaPane`(约 120 行)、`handleArenaInput`、arena state;
  `Tab` 类型收窄为 `"models" | "providers"`;Tab 循环改为两档对切;删 `onSaveArena`
  prop 与 `ArenaParticipantEntry` 导出
- `TuiControlSurface.tsx:17,28,252-260` — 删 prop 传递与 `config_set` 写入
- `App.tsx:1160-1225` — 删 `arenaParticipants` 字段及两个 `config_get` 查询
  (`capabilities.arena.participants` 与 legacy `arena.participants`),收缩 `Promise.all`

### ④ TUI onboarding 第 2 步 — `OnboardingPrompt.tsx`

删整个 `"arena"` step:`Step` 类型收窄为 `"flow"`、`arenaPicks`/`arenaIdx` state、
arena 输入分支、`saveArenaSettingsByKeys` import(这也是 arena **根入口**的 import)、
`step === "arena"` 渲染块。`:149-153` 的"只有一个模型就跳过 picker"逻辑变为无条件
`finish()`。

### ⑤ Desktop — 3 处

- `src/main/agent-bridge.ts:178,330` — 删 `arenaCapabilityModule` 解析与
  `CODE_SHELL_CAPABILITY_MODULES` 中的 `#createArenaModule`
- `scripts/predist.ts:129` — 删预热 import
- `scripts/build-workspace-dependencies.ts:13` — 删构建清单项

Renderer **零 arena 引用**(已核验)。Desktop 中 Arena 仅为 LLM 可调工具、无 UI,
摘除后 Desktop 侧用户无感。

### ⑥ 停止发布

- `packages/arena/package.json` — 加 `"private": true`
- `scripts/package-release-audit-config.ts:68-69` — 移除审计条目
- 根 `package.json` build 链 — 摘掉 arena filter

`tsconfig.json:49-50` 的两个 path alias **保留** —— 包还在,源码仍需可 typecheck。

保包但不自动构建;typecheck 仍覆盖源码。符合"保留源码"意图。

### ⑦ 门禁测试

- `tests/composition-golden.test.ts:35` + `tests/fixtures/composition-golden.json` —
  `expectedModules` 去掉 arena;fixture 删 `arena` module 与 `arena_status` 事件。
  **fixture 手工修改,禁止重生成。**
- `tests/package-boundaries.test.ts:121` — arena 从"能力包必须只依赖 core"循环移除
  (已 private);`:255` 的 `importsArenaRoot` 检查与 `allowedCompatibilityImports`
  中的 `OnboardingPrompt.tsx` 白名单一并清除(④ 删掉该 import 后白名单成死条目)
- `tests/architecture-budgets.test.ts:168` — arena 导出预算 19;源码不动,**原样保留**
- `tests/eslint-boundary-guard.test.ts:61` — arena 作 lint 边界探针;arena 仍在
  workspace 中,探针应仍有效,**倾向不动**,以实跑结果为准

## 风险

**唯一实质风险**:③④ 是 Ink 组件的结构性删除,`OnboardingPrompt` 的 step machine
从两态塌为一态,易漏改渲染分支。

缓解:`App.render-entry.test.tsx` 与 `extra-commands.test.ts` 已存在,可捕获。

## 验证顺序

1. `bun run build` — 改了 build 链,先确认可建
2. `bun run typecheck`
3. `bun test packages tests` — **不跑裸 `bun test`**(会扫进 archify 等忽略目录,
   产生约 197 个假失败)
4. `bun run lint` + `bun run lint:engine-bypass`
5. 仅对改动文件跑 prettier — **不跑 `bun run format`**(会重排全仓)

## 注意

本地 `main` 领先 `origin/main` 8 个提交(未推送的已合并工作)。本分支从本地 `main`
起(已包含 origin/main),不丢内容。

## 2026-09-28 集成补充

- 保留 Arena 包及实现源码，标记为私有并从宿主运行依赖、自动构建和 npm 发布集合移除。版本号仍与其他 workspace 同步，源码测试和类型检查继续保留。
- 保留 `packages/tui/src/cli/commands/arena.ts` 原文件，但从 TUI 编译与发布输出排除，公共 TUI 不再依赖未发布的 Arena 包。
- 保留 main 新增的 Optimization Lab 用户开关、宿主加载及打包流程。
- 当前发布检查覆盖 9 个公共包；历史恢复仍接受已完成的 10 包检查，并使用已验证原始 tag 的发布脚本与包集合。
- 不迁移、不删除用户已有 Arena 设置；既有显式退出登录清理逻辑不变。
