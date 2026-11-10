# 架构审查任务清单 v2(2026-11-10)

> **基线:`origin/main@fcd8406d5`**(PR #332 合入后,领先 v0.9.52 共 373 个提交)。
> v1 的基线是 `2d1c0b638`,落后 50 个提交(desktop +1.6 万行)。v2 的行号和数字都在 `fcd8406d5` 上重新量过。
> 用途:交给执行模型逐项实施,**每个任务一个 PR**。完成后在标题后加 `✅ PR#号`,不要删条目。

## v2 相对 v1 改了什么

v1 写完后做了一轮技术方案复审:逐条对源码核验证据,并对照 CODESHELL.md、第 16 章和近期 PR 里已经定下的决策。结果:

- **新增 3 项**:T1(实测复现的缺陷)、T2(同类漏洞的护栏)、H3(web 与 server 的源码级互引)。
- **撤回 16 项**:与已定决策冲突、前提不成立、或实测后收益不存在。原因见 §8,其中 7 项转成"需要你决定"(§7)。
- **改写 15 项**:证据换成实测数字,做法改成建立在仓库已有机制上。
- **2026-11-10 追加**:你确认 arena 包和 cdp legacy driver 可以删。这两项从"需要你决定"恢复为任务 R1、R2(§6A),并按 `fcd8406d5` 重新核过引用清单。CODESHELL.md 里"有意保留"的表述由这两个任务一并改掉。

v1 的三条结论需要更正,不要再引用:

1. "行数上限在放行增长"不成立。上限机制是 2026-11-09 的 PR #330 才上线的,之前的增长发生在精确钉值时期。上限取"下一个 500 的倍数"是有意的。
2. "宿主业务不该堆在 desktop main"说重了。第 16 章决策 7 已定:电脑在线是常态,云端只做薄云端。Mimi 等逻辑留在桌面是产品决定。
3. "Pet 概念泄漏进 core 契约"说重了。CODESHELL.md 的 Known Architecture Debt 已写明哪些是认可的兼容残留。

## 0. 执行前必读

### 0.1 证据标记

- **[实测]**:本轮在 `fcd8406d5` 上用脚本或命令量过(AST 扫描、运行探针、`gh` 查 CI)。
- **[未核]**:没有重新核实,动手前先自己确认。

行号是 `fcd8406d5` 的行号。代码动过就按符号名找。

### 0.2 分支与提交

- 不在 `main` 上开发。每个任务从最新 `origin/main` 开分支 `codex/<scope>/<topic>`,用独立 worktree。
- `main` 有 ruleset:14 项 `ci.yml` 必需检查通过才能合并。直接推会被拒,`workflow_dispatch` 的绿不算。走 PR + merge commit。
- 工作区可能有并行会话。禁止 `git add -A`、`git stash`、`git reset --hard`。逐路径 `git add`,提交前核对暂存文件数。

### 0.3 验证命令

```bash
bun install
bun run build                 # 改了 core 必须先跑,包内测试吃的是依赖包的 dist
bun run typecheck
bun run lint
bun run lint:test-shards      # 新增/移动测试文件后必跑
bun run lint:engine-bypass
node scripts/run-bun-test-shard.mjs --timeout 30000 ./<测试文件或目录>
bun run test                  # 全部 CI 分片
```

### 0.4 已知的坑

1. 不要跑 `bun run format`,它会重排全仓。只对改过的文件跑 `bunx prettier --write <文件>`。
2. 不要裸跑 `bun test`。会扫进无关目录、用真实 HOME。一律走 `scripts/run-bun-test-shard.mjs`,路径前加 `./`。
3. 包内测试经 `node_modules` 解析到依赖包的 `dist`;根目录 `tests/` 经根 `tsconfig.json` 的 `paths` 解析到源码。所以改 core 后跑 pet/server 等包的测试前必须先 build。build 会先删 dist,失败会留下空目录,此时下游一片 TS2305 是假象。
4. **行数上限不许调高,也不要改回精确值。** 规则见 `tests/architecture-budgets.test.ts:17-25`:默认 1500;老文件取下一个 500 的倍数且至少留 100 行;只降不升;拆到 1500 以下就删条目。超了就拆文件。
5. **新护栏写进已有测试文件,不要新建测试文件。** 分片按文件数设预算,多个已贴顶:

   | 分片 | 覆盖范围 | 占用 / 预算 |
   |---|---|---|
   | desktop | `packages/desktop`(扣除几十条 ignore) | 763 / 772,PR #332 注明"已到预算" |
   | rest-server | server + web + tui | **240 / 240,已满** |
   | rest | `tests/` + coding、pet、chat、arena、cdp、link、optimization-lab、browser-devtools、host | 390 / 400 |
   | core-engine | `core/src/engine` + `core/src/tool-system` | 286 / 300 |
   | core-rest | core 其余(不含 plugins、session) | 412 / 470 |

   上表是 `2d1c0b638` 的数字,动手前跑 `bun scripts/check-test-shards.ts` 看现值。确需新文件而分片已满时,按 `scripts/check-test-shards.ts` 头注释处理,并在 PR 里说明。
6. **有测试按源码文本做断言。** `packages/desktop/src/preload/ipc-contract.test.ts` 和 `tests/architecture-budgets.test.ts` 只认字面量 `ipcMain.handle(`。抽出去的 registrar 参数必须叫 `ipcMain`。不要引入包装函数改变这个文本形态。搬移代码前先 grep 谁在读这个文件的文本。
7. 往 core 的 `/internal` 加导出,要同步 `packages/core/src/index.exports.test.ts` 的 `expectedRuntimeExportsByPartition`,以及 `tests/architecture-budgets.test.ts` 的导出语句预算(`index.ts` 135、`index.internal.ts` 133、`index.extension.ts` 68)。能加进已有 `export { ... } from` 语句就不要新增语句。
8. `tests/composition-golden.test.ts` 的 golden fixture 禁止重新生成。行为不该变的重构让它红了,说明重构改了行为。
9. 检出路径含中文,`docker-candidate` 两个测试文件本地必挂(报错含 `%E4%B8%AA`),CI 能过。
10. 不要新增 `mock.module`(跨测试文件泄漏)。不要升级 Bun。
11. 新增必填的 Engine 方法会打破几十个手写测试 fake(见 C4)。
12. **main 的 CI 当前不稳。** `2d1c0b638` 和 `fcd8406d5` 两次 push 的 run 都红在 `Electron E2E` 的 `e2e-output-history-recovery.mjs`,报 `electronApplication.evaluate: Resulting promise was garbage collected`(`packages/desktop/scripts/electron-harness.mjs:274`)[实测]。这是测试夹具问题,与本清单无关。PR 遇到同样的红先重跑该 job。

### 0.5 通用验收

- `bun run build && bun run typecheck && bun run lint` 通过,lint 警告数不超过 `scripts/lint-baseline.json`。
- `bun run lint:test-shards` 通过;受影响分片 0 失败;14 项必需检查全绿。
- 开 PR 前单独跑三个全仓契约测试:`tests/architecture-budgets.test.ts`、`tests/package-boundaries.test.ts`、`packages/desktop/src/preload/ipc-contract.test.ts`。
- 纯重构任务不改对外行为、协议字段、持久化格式。
- PR 描述写明:改了什么、复核证据时发现的差异、跑了哪些命令及结果、哪些验证没做。

### 0.6 总览

| 编号 | 任务 | 优先级 | 体量 | 依赖 |
|---|---|---|---|---|
| T1 | 多会话路径丢 `operationBatchToken` / `sessionBrief` | P0 | S | 无 |
| T2 | 禁止无类型无初值的 `let` | P1 | S | T1 |
| T3 | 两处无锁写用户 settings | P1 | S | 无 |
| G1 | IPC 预算改全量扫描 | P1 | S | 无 |
| G2 | core 分层护栏 | P1 | M | 无 |
| G3 | 包依赖表与跨包相对 import | P1 | M | 无 |
| G4 | `mock.module` 棘轮 | P2 | XS | 无 |
| C1 | 路径函数下沉到 utils | P1 | S | G2 |
| C2 | 消除机械型上行 import | P1 | M | G2、C1 |
| C3 | `handleQuery` 改注册表 | P1 | L | 无 |
| C4 | 共享 Engine 测试 fake | P2 | M | 无 |
| H1 | 无头 worker 环境覆盖去重 | P1 | S | 无 |
| H2 | server 不从 web 根入口取值 | P1 | S | 无 |
| H3 | web/app 与 server 源码互引 | P2 | M | H2、G3 |
| D1 | AgentBridge 每行只解析一次 | P1 | M | 无 |
| D2 | preload 暴露对象加类型约束 | P2 | M | 无 |
| D3 | `createWindow` 组合根模块化试点 | P2 | L | 无 |
| E1 | 测试代码类型检查试点 | P2 | M | 无 |
| E2 | 修正过期文档 | P2 | S | 无 |
| E3 | 删除审计证据子目录 | P1 | S | 需你确认 |
| R1 | 删除 arena 包 | P2 | M | 无 |
| R2 | 删除 cdp legacy driver 并移除 `packages/cdp` | P2 | M–L | 无 |

建议顺序:T1 → T3、G1、H1、H2(互不相关,可并行)→ R1、R2 → G2、G3 → C1、C2 → 其余。R1、R2 排在 G3 前面,G3 的依赖表就不用再带这两个包。

---

## 1. 缺陷(先修)

### T1. 多会话路径丢 `operationBatchToken` 和 `sessionBrief`

- **现象**:`agent/run` 走多会话路径时,这两个参数到不了 `engine.run`。
- **影响范围**:Desktop worker 和 serve 都走多会话路径(`packages/core/src/cli/agent-server-stdio.ts` 用 `chatManager` 构造 `AgentServer`)。
  - `sessionBrief`:Desktop 渲染端 `packages/desktop/src/renderer/app/useRunController.ts:550` 把数字人团队简报放进 run 参数。原生引擎会话收不到,简报不会写进会话状态,也不会进系统提示词。
  - `operationBatchToken`:Desktop 的 `packages/desktop/src/main/agent-bridge.ts` 发批量运行时带上它(`{ ...params, operationBatchToken: token }`)。引擎侧 `createRunBatchAuthority` 因此不会创建,批量运行按普通运行执行。
  - 公开 SDK 的单 Engine 路径(`createServer({ engine })`)不受影响,它直接把两个字段传给 `engine.run`(`packages/core/src/protocol/server.ts:2038`、`:2051`)。
- **证据 [实测]**:
  - `packages/core/src/protocol/server.ts:1857` 和 `:1870` 把两个字段传给 `session.enqueueTurn(...)`。
  - `packages/core/src/protocol/chat-session.ts:28` 的 `TurnOpts` 没有这两个字段;`:552` 的 `this.engine.run(next.task, { ... })` 逐字段转发,也没带。
  - `server.ts:1764` 是 `let session;`,没有类型标注。仓库 `noImplicitAny: false`,它就是 `any`,多余属性检查失效,所以 tsc 没报错。
  - 运行探针:用假 engine 构造 `ChatSession`,`enqueueTurn` 传入两个字段和 `clientMessageId`。`engine.run` 收到了 `clientMessageId`,两个字段都不在。
  - `docs/architecture/00-overview.md:143` 已把它记为已知问题,代码未修。
- **步骤**:
  1. 先写失败测试。位置:`packages/core/src/protocol/`(core-rest 分片,有余量)。用记录 `run` 入参的假 engine,断言两个字段到达。
  2. `TurnOpts` 增加 `operationBatchToken?: string` 和 `sessionBrief?: string`;`ChatSession` 的 `engine.run` 调用补上转发。
  3. `server.ts:1764` 改成 `let session: ChatSession;`。由此暴露的其他类型错误逐个判断是不是同类漏传,在 PR 描述里列出。
  4. 让"漏转发"在编译期就能发现:把 `engine.run` 的入参对象抽成一个带穷尽检查的映射(例如对"应转发字段"的键集合做 `satisfies Record<keyof ..., unknown>`),新增 `TurnOpts` 字段而不转发时 tsc 报错。
- **验收**:新测试先红后绿;`bun run typecheck` 通过;core-rest、core-engine 分片和 `tests/protocol/multi-session.test.ts` 全过。
- **行为变化(要在 PR 里写明)**:
  - 修复后简报会真正进入原生会话的系统提示词。
  - 批量令牌会真正进入引擎。`packages/core/src/engine/engine.ts:1523` 附近的分支开始生效:plan 模式或 `dontAsk`/`bypassPermissions` 下带令牌的运行返回 `batch_incomplete`。
  - 批量流程的端到端脚本 `packages/desktop/scripts/e2e-operation-batch-worker.mjs`、`e2e-operation-batch-native.mjs` 不在 CI 里。能跑就跑,不能跑要写明没跑。
- **不要做**:不要在 `ChatSession` 里用 `...next.opts` 整体展开代替逐字段转发;不要改单 Engine 路径。

### T2. 禁止无类型无初值的 `let`

- **背景**:T1 的漏洞能过 tsc,是因为 `let session;` 在 `noImplicitAny: false` 下是 `any`。同类写法全仓不多,可以一次清掉并加护栏。
- **数据 [实测,AST 扫描]**:非测试源码里"没有类型标注、没有初值、不是 for-in/of 循环变量"的 `let`/`var` 声明:

  | 范围 | 处数 | 文件数 |
  |---|---|---|
  | `packages/core/src` | 29 | 24 |
  | `packages/coding/src` | 15 | 9 |
  | `packages/desktop/src/main` | 11 | 10 |
  | `packages/server/src` | 7 | 6 |
  | `packages/web/src` | 1 | 1 |
  | pet、host、chat、link | 0 | 0 |

  `packages/tui/src/render` 另有 82 处,是内嵌渲染器的编译器风格代码,不在本任务范围。
- **步骤**:
  1. 给上表 63 处补类型标注。补完后 tsc 新报的错逐个处理;如果是真实的类型不匹配,不要用 `as any` 压掉,在 PR 描述里列出来。
  2. 在 `eslint.config.js` 的 `custom-rules` 里加一条规则(参照文件里现有自定义规则的写法):`VariableDeclarator` 没有 `init`、`id` 没有 `typeAnnotation`、且不在 for-in/of 里时报错。
  3. 规则启用范围:core、coding、server、web、host、pet、chat、link 的 `src` 和 `packages/desktop/src/main`,排除测试文件。tui 不启用。
- **验收**:`bun run lint` 0 错误且警告数不超基线;在 core 任意源文件写 `let x;` 会报错。
- **注意**:补类型暴露的真实错误超过 10 处时,按包拆成多个 PR。

### T3. 两处无锁写用户 `settings.json`

- **背景**:共享文件的"读 → 改 → 写"必须走 `packages/core/src/utils/file-mutex.ts`(目录锁 + 锁内重读 + 临时文件 rename)。`SettingsManager` 的写入路径已经这样做了(`packages/core/src/settings/manager.ts:536` 的 `saveUserSetting`,内部 `mutateSettingsFile`)。
- **证据 [实测]**:对 `~/.code-shell/settings.json` 的写入点逐个看过,只有两处没走锁:
  - `packages/core/src/engine/persist-active-model.ts:15`。无锁"读 → 改 → tmp → rename",注释自称 "Third settings.json writer"。调用点是 `packages/core/src/engine/engine.ts:3566`(`switchModel` 且 `persist !== false`)。
  - `packages/core/src/plugins/installer/pruneDisabled.ts:56`。调用点是 `plugins/pluginInstaller.ts:505` 和 `plugins/installer/uninstall.ts:19`。
  - 已确认没问题的:`onboarding.ts` 用的是 `mutateJsonFile`;`updater.ts` 只读。
- **步骤**:
  1. `persistActiveModel` 改成调用 Engine 已有的 `getSettingsManager().saveUserSetting("defaults.text", entry.key)`。保留现有的 try/catch 加 `logger.warn`(尽力而为,不能让切换模型失败)。好处是与其他写入者同一把锁,并沿用 `SettingsManager` 的 JSON/YAML 层选择和校验。
  2. `pruneDisabledSettingsForPlugin` 改用 `mutateJsonFile`:文件不存在、损坏或不是对象时 `mutation` 返回空对象跳过写入;保留 `mode: 0o600`。
  3. 扩展已有测试 `engine/persist-active-model.test.ts` 和 `plugins/installer/pruneDisabled.test.ts`:其他键保留、权限 0600、损坏文件不被覆盖。
- **验收**:两处不再直接调用 `renameSync`/`writeFileSync` 写 settings;测试通过。
- **注意**:`saveUserSetting` 会校验整层设置,现有文件不合法时会抛错。这与原来"损坏就放弃写入"的行为一致,但要确认异常被 catch 住。同步文件锁不能在同一进程里阻塞异步持有者。
- **不要做**:不要顺手给全 core 加"禁止 `renameSync`"的规则。core 里另有 12 个文件直接 `renameSync` 且没引用锁(清单见附录 C),多数是单进程独占的文件,需要逐个判断。

---

## 2. 护栏

### G1. IPC 预算改全量扫描

- **背景**:`tests/architecture-budgets.test.ts:112-294` 的 IPC 预算靠手写文件清单累加。新 registrar 文件只要不是从 `index.ts` 抽出来的,就不会进清单。
- **证据 [实测]**:

  | | 清单内 | 上限 | 实际总数 | 清单外 |
  |---|---|---|---|---|
  | main 路由 | 48 个文件,390 条 | 390 | **472** | 9 个文件,82 条 |
  | preload invoke | 16 个文件,371 条 | 372 | **479** | 9 个文件,108 条 |

  PR #332 新增的 `pet/pet-notice-ipc.ts`(4 条路由)就在清单外,预算没有感知。清单外文件明细见附录 B。
- **步骤**:
  1. 路由:遍历 `packages/desktop/src/main/**/*.ts`(排除 `*.test.ts`、`*.fixture.ts`、`*.d.ts`)。默认按 `/ipcMain\.handle\(/g` 计数。
  2. 保留一张小的"特殊计数"表,只放现在用特殊正则的 6 个文件(`account-device-ipc.ts`、`model-trace-ipc.ts`、`task-inbox/task-inbox-ipc.ts`、`optimization-lab-ipc.ts`、`operation-resolution-ipc.ts`、`operation-batch-ipc.ts`),正则照抄现有的。
  3. invoke:遍历 `packages/desktop/src/preload/**/*.ts`,默认按 `ipcRenderer.invoke(` 和 `ipc.invoke(` 计数;`account-device-api.ts` 保留它现在的特殊正则。
  4. 先做自检:新机制只统计原清单内的文件时,结果必须等于 390 和 371。对上之后再放开到全量。
  5. 上限设为落库时的实测总数。保留两条精确断言(`account-device-ipc.ts` 为 8、`session-output-history-ipc.ts` 为 2)。
  6. 保留原有的大段审查注释,补一句说明 2026-11 改为全量扫描、新增的数字是"一直存在但没被统计"的路由。
- **验收**:测试通过;在 main 下任意新文件里加一条 `ipcMain.handle(` 会让它失败。
- **不要做**:不要改 `ipc-contract.test.ts`;不要趁机删路由。

### G2. core 分层护栏

- **背景**:core 的目录级 value import 图里,27 个目录(147,551 行,占 core 的 91%)互相可达 [实测]。但把目录排成 8 层后,违反层序的 import 只有 **29 条,分布在 23 个文件**;另有 6 对同层目录互相依赖。也就是说纠缠是少量 import 造成的,可以先冻结再逐条消除。
- **现状**:仓库已有一个文件级的同类测试 `packages/core/src/engine/engine-import-boundary.test.ts`(tool-system 不得 import `engine/engine`)。本任务是把它推广到目录层。
- **步骤**:
  1. 在 `tests/architecture-budgets.test.ts` 里新增一个测试(不新建文件)。用仓库已装的 `typescript` 包解析 `packages/core/src/**/*.{ts,tsx}`。
  2. 节点 = `packages/core/src` 下的一级目录;`tool-system/builtin` 单独算一个节点;根目录下的文件(`index*.ts` 等)视为最上层,不检查。
  3. 排除:测试文件、`*.d.ts`、`__fixtures__`、`fixtures`、`__tests__` 目录。
  4. 只算 value import:`import`/`export ... from` 中不是 `import type` 且不是"全部具名项都带 `type`"的;加上 `import()` 和 `require()`。
  5. 写入三张表,初值照抄附录 A:
     - `CORE_LAYERS`:8 层的目录归属。
     - `UPWARD_ALLOWLIST`:29 条"文件 → 目录"。
     - `SAME_LAYER_CYCLES`:6 对同层互依目录。
  6. 三条断言:
     - 每个目录都有层归属(新目录必须先归层)。
     - 实际的上行 import 集合是白名单的子集,且白名单没有过期条目(保证只降)。
     - 实际的同层互依集合是已知 6 对的子集,且没有过期条目。
- **验收**:测试在现状上通过;人为加一条上行 import(如 `utils` 里 import `engine`)会失败并指明文件。
- **说明**:附录 A 的分层是本次审查提出的方案。执行者认为某个目录归层不对可以调整,但调整后的上行条数不得多于 29,并在 PR 描述里说明理由。
- **不要做**:本任务不修任何 import。

### G3. 包依赖表与跨包相对 import

- **现状(已有的机制,不要重复造)**:
  - `tests/package-boundaries.test.ts`:workspace 依赖图无环;core 的运行时依赖只有 link;能力包只依赖 core;host 只依赖 core 并扫描源码;host 类包只能用 coding、arena、server 的聚焦入口。
  - `eslint.config.js` 的 `codeshell-boundary-imports`:只覆盖 core、四个能力包、desktop renderer。
  - `tests/eslint-boundary-guard.test.ts`:用 ESLint stdin 探针测上面的规则,每个探针约 2 秒。
- **缺口 [实测,AST 扫描]**:
  1. 没有"每个包允许依赖谁"的完整表。例如 server → web 没有任何约束。
  2. 生产源码里有跨包相对路径 import,绕过了 package.json,依赖图无环测试看不到:
     - `packages/web/app` 下 6 个文件 → `../../server/src/panels/*`(其中 2 处是 value import)。而 server 又在 package.json 里依赖 web,这是一个源码级的环。
     - `packages/desktop/src/mobile/main.tsx` → `../../../web/app/*`(4 处)。
     - `packages/desktop/scripts/cloud-chooser-server.ts` → `server/src`(4 处)。
     - 3 个 `*.fixture.ts` 和 `renderer/test-utils/renderHook.tsx`。
     - 测试文件里另有 146 处,属于测试夹具,不管。
  3. web 对 `@cjhyy/code-shell-core`、`/internal` 的 import 目前全部是 type-only(0 处 value),但没有规则保证。
  4. tui 的 `src/cli/commands/arena.ts` import 了 `@cjhyy/code-shell-arena/runtime`,但 tui 的 package.json 没声明 arena。这个文件被 tsconfig 排除在编译外。
- **步骤**:
  1. 在 `tests/package-boundaries.test.ts` 加一个表驱动测试,逐包精确断言 workspace 依赖。当前值:

     | 包 | workspace 依赖 |
     |---|---|
     | link、chat、cdp、browser-devtools | 无 |
     | core | link |
     | coding、pet、arena、optimization-lab、host | core |
     | web | core、link |
     | server | core、link、host、web、coding |
     | tui | core、coding、server |
     | desktop(dependencies) | core、coding、pet、optimization-lab |
     | desktop(devDependencies) | browser-devtools、cdp、chat、host、link、server、web |

     R1、R2 合入后,表里没有 arena 和 cdp,desktop 的 devDependencies 也没有 cdp。以落库时的 package.json 为准。
  2. 同一文件加一个测试:每个包的非测试源码里出现的 `@cjhyy/code-shell-*` 包名,必须在该包的 package.json 里声明。已知例外只有 tui 的 `arena.ts`,写进显式例外表;R1 合入后这个例外就不存在了。
  3. `codeshell-boundary-imports` 规则加一个通用分支,挂到所有包的 `src/**` 和 `packages/web/app/**`:相对路径解析到另一个 workspace 包目录时报错。跳过测试文件、`*.fixture.ts`、`test-utils/`。
  4. 现存违例做成显式白名单,每条注明去向:
     - `desktop/src/mobile/main.tsx` → `web/app`:有意保留。桌面的手机端入口直接编译 web 的 SPA 源码(见 `packages/desktop/vite.mobile.config.ts`)。
     - `web/app` → `server/src/panels`:由 H3 消除。
  5. 给 `packages/web/src/**` 和 `packages/web/app/**` 加规则:对 `@cjhyy/code-shell-core` 及其子入口只允许 type-only import。写法参照 renderer 那段 `@typescript-eslint/no-restricted-imports` 的 `allowTypeImports`。
  6. 在 `tests/eslint-boundary-guard.test.ts` 补探针,不超过 3 个。
- **验收**:`bun run lint` 0 新增错误;探针测试通过;给 web 加一个 server 依赖会让依赖表测试失败。

### G4. `mock.module` 棘轮

- **背景**:`mock.module` 跨测试文件泄漏,是分片越拆越碎的原因之一。
- **数据 [实测]**:66 个文件、206 处,其中 50 个文件在 desktop。
- **步骤**:在 `tests/architecture-budgets.test.ts` 加一条:`packages/` 和 `tests/` 下含 `mock.module(` 的文件数不超过落库时的实测值。失败信息写"改用依赖注入"。
- **验收**:新增一个用 `mock.module` 的测试文件会失败。

---

## 3. core

### C1. 路径函数下沉到 utils

- **背景**:两个很小的路径函数定义在高层模块里,导致大量模块为了取路径去 import `settings` 或 `session`。
  - `userHome()` 定义在 `packages/core/src/settings/manager.ts:39`。core 里 30 个非测试文件在用,llm、hooks、links、prompt、skills、model-catalog 等目录都因此 import `settings/manager`。
  - `codeShellHome()` 定义在 `packages/core/src/session/session-paths.ts:59`。15 个文件在用,其中 9 个经 `session/session-manager.js` 的转出口拿到。
- **两个函数语义不同,不能互相替换 [实测]**:
  - `userHome()` 是 `process.env.HOME ?? homedir()`。
  - `codeShellHome()` 是 `process.env.CODE_SHELL_HOME || join(homedir(), ".code-shell")`。
  - 结果是:settings 认 `HOME` 不认 `CODE_SHELL_HOME`;sessions 认 `CODE_SHELL_HOME`。把 `join(userHome(), ".code-shell")` 换成 `codeShellHome()` 会改变文件读写位置。
- **步骤**:
  1. 新建 `packages/core/src/utils/paths.ts`,把两个函数连同注释原样搬过去。它只依赖 node 内置模块。
  2. 原位置改成从新文件转出口,对外导出名不变。三个入口文件的导出不能少。
  3. core 内部的 import 改指向 `utils/paths`。
  4. 重新跑 G2,把因此消失的条目从白名单删掉。预期消失:`runtime/background-shell.ts → session`;`model-catalog ↔ settings` 这对同层互依是否消失取决于 `model-catalog/index.ts` 是否只为 `userHome` 引 settings,先确认。
- **验收**:G2 白名单变短且无新增;`packages/core/src/index.exports.test.ts` 通过;core 各分片通过。
- **不要做**:不要把手拼的 `join(userHome(), ".code-shell")` 改成 `codeShellHome()`;不要动 `sessionsRoot()` 及其测试守卫;不要改任何路径的实际取值。

### C2. 消除机械型上行 import

- **背景**:G2 的 29 条上行 import 里,约 11 条只是引用了一个常量、schema 片段或纯函数,把被引用的东西往下搬就能消除。另外 6 对同层互依也多是同样性质。完整清单和引入的符号见附录 A。
- **机械型条目(本任务范围)**:

  | 文件 | 上行到 | 引入的符号 | 建议 |
  |---|---|---|---|
  | `session/output-history-comparison.ts`、`output-history-native-comparison.ts` | engine | `outputUserMessage` | `engine/run-output-user-message.ts` 只有 74 行,搬到 session 或 utils。它还引了 `engine/image-policy.js` 的 `byteLengthFromBase64`,要一起处理 |
  | `automation/runner.ts` | run | `AUTOMATION_RUN_SOURCE` | 常量搬到 automation,run 反过来引它 |
  | `hooks/registry.ts`、`tool-system/registry.ts` | composition | `onceDispose` | 搬到 utils |
  | `credentials/use-credential-tool.ts` | tool-system | `SENSITIVE_TOOL_RESULT_PLACEHOLDER` | 常量搬到 utils 或 credentials |
  | `settings/schema.ts` | tool-system | `MAX_MCP_CONNECT_RETRIES`、`MAX_MCP_CONNECT_TIMEOUT_MS` | `mcp-connection-policy.ts` 没有任何 import,常量可下沉 |
  | `settings/schema.ts` | sources | `WorkspaceSourceBindingSchema` | `sources/types.ts` 只依赖 zod,schema 片段可下沉 |
  | `settings/schema.ts` | panel-apps | `PanelAppPackagePinsSchema` | 从 `panel-apps/bindings.ts` 拆出 schema 再下沉 |
  | `composition/core-module.ts` | engine | `ISOLATED_TASK_PROFILE`、`QUICK_CHAT_RESTRICTED_PROFILE` | 常量搬到 composition 或更低处 |
  | `runtime/background-shell.ts` | session | `codeShellHome` | C1 已解决 |

- **步骤**:
  1. 每条先读被引用符号的定义,确认是纯常量、纯 schema 或无副作用的纯函数。不是就停下来,把它移到"需设计"并在 PR 里说明。
  2. 搬到更低层后,原位置保留转出口,避免改动所有调用方。
  3. 每消除一条,从 G2 的白名单删掉对应条目。
  4. 同层互依的 6 对(附录 A)按同样方式处理能处理的。
- **验收**:G2 白名单至少减少 9 条;三个入口的导出符号不减;`tests/composition-golden.test.ts` 不改 fixture 通过。
- **不要做**:不要碰"需设计"的 18 条(附录 A 标了"需设计")。它们涉及真实的行为依赖,例如 `credentials/access.ts` 直接调用 link provider、`tool-system` 核心引用内置工具。这些要先有方案。

### C3. `handleQuery` 改注册表

- **背景**:`packages/core/src/protocol/server.ts` 4892 行,上限 5000,只剩 108 行余量,下一个功能就会撞线。文件里 `AgentServer` 一个类 4489 行、52 个字段、77 个方法。最大的方法是 `handleQuery`(`:3085` 起,约 680 行)。
- **现状 [实测]**:`handleQuery` 是一个 `switch`,21 个 case:`output_journal`、`usage`、`tools`、`sessions`、`config`、`session_detail`、`compact`、`archive_range`、`archive_marker`、`models`、`providers`、`config_set`、`config_get`、`permission_set`、`provider_add`、`provider_refresh`、`provider_delete`、`model_add`、`model_delete`,以及 `default`。`default` 分支调 `engine.queryCapability(...)`,走 composition 的 `protocol.queries` 扩展缝。
- **步骤(分两个 PR)**:
  1. **PR 1,定格测试**:对每个 query 记录请求到响应的形状(成功和典型失败),包括错误码。已有测试覆盖的不重复写。
  2. **PR 2,搬移**:
     - 新建 `packages/core/src/protocol/queries/`,按域分文件(模型与 provider、设置与权限、会话与归档、用量与工具)。每个 handler 是独立函数,入参是一个只含它需要的东西的上下文对象。
     - `handleQuery` 变成:查内置表 → 没有就走原来的 `queryCapability` → 都没有返回原来的错误。
     - 按 0.4 第 4 条的规则下调 `server.ts` 的行数上限。
- **验收**:PR 1 的测试在 PR 2 前后都通过;`server.ts` 至少减少 500 行;`tests/composition-golden.test.ts` 不改 fixture 通过;协议相关分片全过。
- **搬移前先查**:哪些测试或脚本按文本读 `server.ts`(`grep -rln "protocol/server" packages tests scripts` 后看谁在 `readFileSync`)。
- **不要做**:不要改 query 名、参数、错误码或响应形状;不要合并语义相近的 query;不要动两条 run 路径。

### C4. 共享 Engine 测试 fake

- **背景**:加一个必填的 Engine setter 会让几十个测试挂掉,因为每个测试文件各自手写一个 `{...} as unknown as Engine`。
- **证据 [实测]**:
  - 58 个测试文件用了 `as unknown as Engine`(core 51、desktop 2、pet 2、host 1、根 tests 2),非测试代码 0 处。
  - 宿主注入的 8 个 setter(`setAskUser`、`setAskUserAsync`、`setBrowserBridge`、`setInjectCredential`、`setChildHostBindings`、`setSessionMessageRouter`、`setWorkspaceBridge`、`setPanelBridge`)只有一个调用方:`packages/core/src/protocol/server.ts:904` 的 `wireInteractiveSession`。
  - setter 本身都是一行赋值,不是 `engine.ts` 体积的来源。
- **步骤**:
  1. 在 `packages/core/src/testing/` 新增 `createFakeEngine(overrides)`:所有 setter 默认空实现,`wireInteractiveSession` 会调用的方法都有默认值,其余方法调用时抛出带方法名的错误。
  2. 把 `packages/core/src/protocol/server.*.test.ts` 里的手写 fake 迁到它。其他包的 fake 不在本 PR 范围。
  3. 不从三个公开入口导出它。
- **验收**:protocol 目录测试里的 `as unknown as Engine` 清零;给真实 Engine 加一个新 setter 并在 `wireInteractiveSession` 里调用时,只需要改 `createFakeEngine` 一处。
- **不要做**:不要改 Engine 的公开方法;不要为了测试在生产代码里加 `typeof ... === "function"` 判断。

---

## 4. 包边界与宿主

### H1. 无头 worker 环境覆盖去重

- **背景**:worker 入口的默认值是面向 Desktop 的。`packages/core/src/cli/agent-server-stdio.ts:396` 只要 `CODE_SHELL_CREDENTIAL_ACCESS` 不是 `"local"` 就走宿主 IPC 取凭据。无头宿主必须显式清掉一组开关,否则 worker 会去等一个不存在的宿主,而且是静默退化。
- **证据 [实测]**:同一组"清除宿主开关"的覆盖手抄了 4 份:
  - `packages/server/src/serve/headless-server.ts:557` 和 `:680`(同文件两份,逐行相同)。
  - `packages/server/src/panels/agent-task-host.ts:363`。
  - `packages/desktop/src/main/desktop-web-service.ts:148`。

  清除的键是:`CODE_SHELL_REMOTE_LINK_CLIENT_SECRET`、`CODE_SHELL_OPERATION_BATCH_ACCESS`、`CODE_SHELL_MODEL_REQUEST_SIGNING`、`CODE_SHELL_WORKSPACE_ACCESS`、`CODE_SHELL_HOST_MCP_SERVERS`;外加把 `CODE_SHELL_CREDENTIAL_ACCESS` 设为 `"local"`。
- **步骤**:
  1. 在 `packages/server/src/worker-bridge-core.ts` 旁新增一个函数并从 `index.worker.ts` 导出(即 `@cjhyy/code-shell-server/worker`,这 4 处都已经从这里拿 `WorkerBridgeCore`):
     - 一个常量数组,列出上面 5 个键。
     - `headlessWorkerEnv(base, extra)`:清掉这 5 个键,设 `CODE_SHELL_CREDENTIAL_ACCESS: "local"`,再合并 `extra`。
  2. 4 处改用它。各处的差异原样保留:
     - headless 的两处额外设 `CODE_SHELL_DATA_ROOT` 和能力模块。
     - `agent-task-host` 只在调用方没传 `buildEnv` 时才设默认能力模块。
     - `desktop-web-service` 额外设 `ELECTRON_RUN_AS_NODE`。
  3. 测试加进已有的 `packages/server/src/worker-bridge-core.test.ts`(rest-server 分片已满,不能新建文件)。断言:5 个键被清除、凭据访问为 local、`extra` 生效。
  4. 在 PR 描述里贴出 4 处改前改后的 env 逐键对比。
- **验收**:`grep -rn "CODE_SHELL_OPERATION_BATCH_ACCESS: undefined" packages` 只剩新函数里一处;行为不变。
- **不要做**:
  - 不要放进 `packages/host`。`tests/package-boundaries.test.ts` 钉死了 host 的导出和依赖。
  - 不要搬 `WorkerBridgeCore`。
  - 不要改 Desktop 自己的 `agent-bridge.ts:444`,它是把开关设为 `"host"`,语义相反。
  - 不要统一各处的能力模块集合。
- **顺带记录(不要改,报告给仓库所有者)**:三处默认能力模块不一致。`headless-server` 缺省只有 link provider;`serve/cli.ts` 传的是 coding 加 link;`agent-task-host` 缺省只有 coding。

### H2. server 不从 web 根入口取值

- **背景**:`@cjhyy/code-shell-web` 的根入口同时导出 React hook 和组件。server 是 Node 进程,却从根入口做 value import。
- **证据 [实测]**:
  - `packages/server/src/hub/run-replay.ts:1` 引 `OutputCoverage`;`hub/session-management.ts:10` 引 `replayTranscript`、`transcriptUserDisplay`。
  - web 根入口的 value import 闭包是 37 个文件,外部依赖 `react` 和 `qrcode`。
  - `packages/web/src/lib/transcriptReplay.ts` 和 `lib/outputCoverage.ts` 各自的闭包只有 3 个文件,没有任何外部依赖。
  - web 已有无 React 子入口的先例:`./account`、`./account-profile`,在 package.json 里直接指向模块文件。
- **步骤**:
  1. `packages/web/package.json` 的 `exports` 增加两个子入口,写法照抄 `./account`:
     - `./transcript-replay` → `dist/lib/transcriptReplay.js`
     - `./output-coverage` → `dist/lib/outputCoverage.js`
  2. 根 `tsconfig.json` 的 `paths` 增加对应两条,写在现有 `@cjhyy/code-shell-web/account` 那两条旁边。
  3. server 的两处 import 改用新子入口。
  4. 在 `tests/package-boundaries.test.ts` 加断言:`packages/server/src` 的非测试源码不得 value import `@cjhyy/code-shell-web` 根入口。写法参照同文件里 "keeps product hosts on focused Server entries"。
- **验收**:上述断言通过;`bun run test:package-release` 通过(它会按 exports 逐个做运行时导入);`bun run test:server-smoke` 通过。
- **注意**:子入口名不要和 `packages/web/src` 下的目录同名。desktop 的 tsconfig 有通配 `@cjhyy/code-shell-web/*` → `../web/src/*`。
- **不要做**:不要新建包;不要改 web 根入口的导出。

### H3. web/app 与 server 的源码互引

- **背景**:web 的 SPA 源码用相对路径 import server 的源码,而 server 在 package.json 里依赖 web。包级依赖图无环测试看不到这个环。
- **证据 [实测]**:`packages/web/app` 下 6 个文件 import `../../server/src/panels/*`:
  - value import 2 处:`panel-video-capture.ts:5` 和 `PanelHost.tsx:18`,引 `browser-capture.js` 的 `panelVideoOptions` 等。
  - type import:`HubPanels.tsx:11`、`PanelHost.tsx:3`、`PanelVideoDialog.tsx:2`、`useWorkbenchNavigation.ts:2`、`Workbench.tsx:13`,引 `ManagedPanel` 等。
  - `packages/server/src/panels/browser-capture.ts` 只有 51 行,没有任何 import,是浏览器也能跑的纯逻辑。
  - `packages/server/src/panels/types.ts` 110 行,只有一条对 `@cjhyy/code-shell-core` 的 type import。
- **建议方向**:server 已经依赖 web,所以把这部分"浏览器和 Node 都要用的 Panel 契约"放进 web 的无 React 面,server 反过来从 web 引。
- **步骤**:
  1. 先调查:列出 SPA 实际用到的类型和函数,以及它们的类型依赖闭包。闭包如果伸到 server 独有的类型,停下来报告,不要硬搬。
  2. 闭包干净的话:在 `packages/web/src/` 下建一个无 React 的模块放这些契约,加一个子入口(做法同 H2)。
  3. server 的 `panels/types.ts`、`panels/browser-capture.ts` 改成从 web 的子入口转出口,保持 `@cjhyy/code-shell-server/panels` 的现有导出不变(desktop 在用)。
  4. web/app 的 6 个文件改成包内 import。
  5. 从 G3 的白名单里删掉这组违例。
- **验收**:`grep -rn "server/src" packages/web/app` 在非测试文件里无结果;desktop 和 web 的构建通过;`bun run test:package-release` 通过。
- **不要做**:不要让 web 的 package.json 依赖 server。

---

## 5. desktop

### D1. AgentBridge 每行只解析一次

- **证据 [实测]**:`packages/desktop/src/main/agent-bridge.ts:572` 的 `handleWorkerLine` 把 worker 的每一行原始字符串依次交给一串处理器,每个处理器自己无条件 `JSON.parse(line)`,没有预筛:
  - `webConfiguration.observe`(`web-configuration-gate.ts:19`)
  - `updateTentativeRunLifecycle`
  - `workerHost.intercept`(`worker-host-runtime.ts:50`)
  - `maybeHandleCronChanged`
  - `routePetProjectionLine`
  - `routePetReportLine`
  - 生成日志摘要的那次解析
  - `parseSnapshotAppend`(`parseStreamLine.ts:25`)

  每行至少解析 8 次,发生在 Electron 主进程。流式输出的每个文本增量都是一行。
- **步骤**:
  1. 在 `handleWorkerLine` 入口解析一次,得到"原始行 + 解析结果或解析失败"。
  2. 各处理器的签名改成接收已解析对象。解析失败时各自保持原行为。
  3. 不改处理顺序和各自的提前返回逻辑。
  4. PR #332 之后可能又加了处理器,以当前代码为准重新列一遍。
  5. 在已有的 agent-bridge 测试文件里加断言:处理 N 行时 `JSON.parse` 的调用次数(desktop 分片已到预算,不要新建测试文件)。
- **验收**:现有 agent-bridge 测试全过;每行的解析次数降到 1(`WorkerBridgeCore` 内部的解析不算)。
- **注意**:跑 desktop 测试前先 build。这项不保证解决"worker 输出停滞后爆发"的问题,那个的根因未定。

### D2. preload 暴露对象加类型约束

- **现状 [实测]**:
  - `packages/desktop/src/preload/index.ts:502` 的 `contextBridge.exposeInMainWorld("codeshell", { ... })` 没有 `satisfies CodeshellApi`。类型声明在手写的 `preload/types.d.ts`(2932 行),实现和声明之间没有编译期约束。
  - 较新的域已经有一套模式:`shared/<域>.ts` 定义 `XxxApi` 接口,`preload/<域>-api.ts` 按接口实现,`main/<域>-ipc.ts` 注册。但 main 侧的 handler 没有按接口检查,通道名在 preload 和 main 各写一遍。
- **步骤**:
  1. 给暴露对象加 `satisfies CodeshellApi`,记录 tsc 报了多少处不一致。
     - 不超过 20 处:逐个修,修的是声明或实现里错的那一边。
     - 超过 20 处:不修,把清单写进 PR 描述,然后停下来等决定。
  2. 选一个已有 `shared` 接口、路由少的域做 main 侧试点(例如 `accountFeatures`,2 条路由)。在 `shared/<域>.ts` 里加"通道名 → 参数与返回值"的类型表,main 侧把 handler 写成一个 `satisfies` 这张表的对象,再逐条 `ipcMain.handle("通道名", handlers["通道名"])`。
- **验收**:暴露对象受 `CodeshellApi` 约束;试点域里故意改错 main 侧的返回类型会让 typecheck 失败;`ipc-contract.test.ts` 和 G1 的计数不变。
- **不要做**:不要引入 `handleIpc(...)` 之类的包装函数,见 0.4 第 6 条。

### D3. `createWindow` 组合根模块化试点

- **现状 [实测]**:`packages/desktop/src/main/index.ts` 4589 行。`createWindow()` 占 `:1341-2689`,共 1349 行;服务装配在其中的 `if (!bridge)` 块里(`:1546` 起),靠第一个窗口触发。文件里有 31 个模块级 `let`。2026-11-09 的拆分把 IPC 路由挪进了 18 个 `*-ipc.ts`,装配和生命周期没动。
- **步骤**:
  1. 定义一个最小的模块接口(名称、`start`、`dispose`)和一个按注册顺序启动、逆序关停的注册表,接入现有的 `packages/desktop/src/main/desktop-shutdown.ts`。
  2. **只迁一个域做试点**:选依赖最少的一组服务。不要选 pet(那边有你自己的收敛计划,见 §7)和 agent-bridge。
  3. 该域对应的模块级 `let` 和退出清理代码一并移进模块。
- **验收**:试点域的启动和清理各只在一处;`index.ts` 行数下降并按规则下调上限;`Electron E2E` 检查通过。
- **搬移前先查**:哪些源码契约测试在读 `index.ts` 的文本。
- **不要做**:不要一次迁多个域;不要改服务的启动时机。

---

## 6. 工程治理

### E1. 测试代码类型检查试点

- **现状 [实测]**:所有包的 tsconfig 都排除了 `*.test.ts`,根 tsconfig 排除了 `tests`。没有任何配置对测试做类型检查。接口变了,测试里的手写 fake 只能等运行时才暴露。
- **步骤**:
  1. 选最小的两个包 host 和 link 试点。各加一个只做检查不产出的测试 tsconfig,包含测试文件,`types` 里加 `bun-types`。
  2. 跑一遍记录错误数。能直接修的修;修不完的按"错误数只降不升"建基线。
  3. 加脚本并接进 CI 的 typecheck job。
  4. 在 PR 描述里给出其余各包的错误数,供后续逐包接入。
- **验收**:两个试点包的测试通过类型检查或有基线;CI 跑到它。
- **不要做**:不要一次接入 core 或 desktop。

### E2. 修正过期文档

只改文档和注释,不改代码。

1. `docs/architecture/12-package-boundaries-and-release-units.md`(最后修改 2026-08-12):`:48` 仍画 `tui → core + coding + arena`;`:361` 的发布顺序里有 arena;全文 0 次提到 host。按 `scripts/package-release-audit-config.ts` 的现状重写发布单元部分。最好排在 R1、R2 之后做,一次写对。
2. `docs/todo/engine-split-plan.md`(2026-07-07):仍写 "planning draft only",基线 3521 行。文件头加一行"已过期"并指向本清单。
3. `docs/todo/architecture-debt.md`(2026-07-14):是 7 月的历史记录,里面的行数是当时的。文件头加一行说明日期和现状出处,不改正文。
4. `packages/desktop/package.json:209` 的 `//deps` 注释:写的是"只有 electron 和 core 不内联"。实际 `packages/desktop/scripts/build-main.ts` 的 external 是 electron、playwright-core、core、link、coding。另外 link 是 external 却只列在 devDependencies,在注释里说明它靠什么进包。
5. `TODO.md` 头部的"领先 228 个提交":`git rev-list --count v0.9.52..origin/main` 现在是 373。
6. `packages/web/package.json` 的 description 写的是"逻辑层",实际包里有完整 SPA(`web/app`)。CODESHELL.md 的包清单同步。
7. `docs/architecture/00-overview.md:143` 的"多会话路径丢字段":T1 合入后改成已修复并注明 PR。

### E3. 删除审计证据子目录(需你确认后执行)

- **证据 [实测]**:
  - `docs/audit-2026-10-16`、`docs/audit-2026-10-17` 和 64 个 `docs/audit-2026-10-17-round*`,共 7375 个被跟踪文件、355 MB。
  - 其中各目录的 `evidence/` 子目录占 6676 个文件、348 MB;其余(README、findings、manifest 等)只有 699 个文件、6.8 MB。
  - docs 之外没有任何文件引用这些目录;docs 内只有 `docs/todo/release-ui-20261015.md` 一处引用。
  - 对比:`packages/` 全部源码 63 MB。
- **步骤**:
  1. 确认去向后(见 §7 第 1 条),删除这 66 个目录下的 `evidence/` 子目录,其余文件保留。
  2. 修正 `docs/todo/release-ui-20261015.md` 里指向被删路径的链接。
  3. `scripts/check-test-shards.ts` 里对 `docs/` 的豁免规则保留,它是针对整个 docs 的。
- **验收**:`git ls-files docs | wc -l` 减少约 6600;`bun run lint:test-shards` 通过。
- **不要做**:不要重写 git 历史;不要动 `docs/review-2026-10-12` 等其他目录。

---

## 6A. 清理:已决定删除

2026-11-10 仓库所有者确认这两项可以删。两个任务会改到同一批文件(`ci.yml:210`、CODESHELL.md 的包数、`tests/package-boundaries.test.ts` 的私有包列表、`eslint.config.js` 的包列表、Dockerfile),分两个 PR 先后合入,后合的那个 rebase。两项都做完后 workspace 从 14 个包变成 12 个。

### R1. 删除 arena 包

- **现状 [实测]**:
  - `packages/arena`:非测试源码 9789 行,11 个测试文件;private;不在根 `build` 链里;没有任何宿主加载它。
  - 唯一的 importer 是 `packages/tui/src/cli/commands/arena.ts`(411 行)。它被 `packages/tui/tsconfig.json:32` 排除在编译外,`main.ts` 也没有注册这个命令。
  - `tests/fixtures/arena-cli-preload.ts` 引的是 `packages/arena/dist`,没有任何测试引用这个夹具。
- **要删的**:
  - `packages/arena/` 整个目录。
  - `packages/tui/src/cli/commands/arena.ts`。
  - `tests/fixtures/arena-cli-preload.ts`。
- **要改的**:

  | 位置 | 改动 |
  |---|---|
  | `packages/tui/tsconfig.json:25-32` | 去掉关于 Arena 的注释和 `exclude` 里那一项 |
  | 根 `tsconfig.json:57-58` | 去掉两条 arena 的 `paths` |
  | `eslint.config.js:20`、`:31`、`:449` | 包列表、能力包列表、规则的 `files` 里去掉 arena |
  | `scripts/package-release-audit-config.ts:105-109` | 去掉 arena 的定义 |
  | `.github/workflows/ci.yml:210` | rest 分片的路径去掉 `packages/arena` |
  | `Dockerfile:10` | 去掉拷贝 arena `package.json` 的那行 |
  | `tests/architecture-budgets.test.ts:403` | 去掉 `"packages/arena/src/index.ts": 19` |
  | `tests/eslint-boundary-guard.test.ts:94` | 探针路径换成另一个能力包(如 `packages/pet/src/...`),断言不变 |
  | `tests/package-boundaries.test.ts:129` | 能力包列表去掉 arena |
  | `tests/package-boundaries.test.ts:298-307` | 去掉注释,私有包期望列表去掉 arena |
  | `tests/package-boundaries.test.ts:346-362` | 这个 `it.each` 拿 arena 当"私有 workspace"的例子。换成仍然存在的私有包,如 `@cjhyy/code-shell-browser-devtools` |
  | `tests/package-boundaries.test.ts:364-386` | 测试名和匹配 arena 的正则去掉 |
  | `CODESHELL.md:10`、`:17`、`:37`、`:182`、`:217` | 包数、包清单、"coding/arena/pet"、"all 14 workspace packages";`:217` 那条改成"Arena 已删除,不要把它的 import、内置工具、设置或固定 RPC 加回 core" |
  | `README.md:260`、`README.zh-CN.md:244` | 目录树去掉 arena |
  | `TODO.md:91` | 去掉"Arena 只作为私有保留源码"的表述 |
  | `bun.lock` | `bun install` 重新生成 |

- **文档**:只改描述"当前状态"的地方:`docs/architecture/06-capability-packages.md` 里 arena 的段落、`07-tui.md:76`、`:110`、`:145`、`:1031`、`00-overview.md`、`docs/architecture/README.md`。`docs/archive` 和带日期的历史文档不动。`docs/architecture/archify/` 下的图不要动,它们有交付哈希。
- **要保留的(是防回归的守卫,不是残留)**:
  - core 里断言"Arena 不是内置工具、不从 core 导出"的测试:`packages/core/src/tool-system/registry-defaults.test.ts`、`packages/core/src/index.exports.test.ts:519-551`、`packages/core/src/preset/preset-builtin-tools.test.ts:61`、`scripts/smoke-core-exports.mjs:133`、`scripts/smoke-core-harness.mjs:63`。
  - `packages/tui/src/cli/main-options.test.ts:24`(不接受已退役的 arena 子命令)和 `OnboardingPrompt.test.tsx`。
  - `packages/tui/src/cli/commands/builtin/extra-commands.ts:16` 的 `"arena"`:这是 `/logout` 时清理用户旧 settings 里的 `arena` 键。`packages/core/src/settings/manager.test.ts:43` 同理。
  - `scripts/validate-release-recovery.cjs:52`:兼容旧 tag 的 job 名。
  - core 注释里顺带提到 arena 的几处,不用改。
- **搜索时的误报**:不分大小写搜 `arena` 会命中 `compareNames`、`prepareNativeModel`,以及 `packages/core/src/session/output-storage-prototype` 里的内存 arena。都与本任务无关。
- **验收**:
  - `git grep -n "code-shell-arena\|packages/arena"` 只剩 CHANGELOG、历史文档和上面"要保留的"。
  - 通用验收全过;`bun run test:package-release` 通过;`bun scripts/check-test-shards.ts` 通过(rest 分片少 11 个文件)。
  - PR 描述里记下删除前最后一个包含 arena 的提交 SHA,方便以后找回。
- **顺带记录(不要改)**:删除后 core 的 `/extension` 入口里有 13 个符号在仓内没有使用者了:`ClientDefaults`、`Colorizer`、`ContentBlock`、`ModelEntry`、`ModelPool`、`NOOP_COLORIZER`、`ToolCall`、`addTokenUsage`、`extractJSON`、`extractJSONArray`、`resolveMaxOutput`、`webFetchTool`、`webSearchTool` [实测]。`/extension` 是已发布的契约,要不要收回由仓库所有者定。

### R2. 删除 cdp legacy driver 并移除 `packages/cdp`

- **范围**:"cdp driver"指两样东西:`packages/cdp/src/driver.ts` 里的 `CdpActionsDriver` 类,和桌面侧的胶水 `packages/desktop/src/main/browser-driver/cdp-driver.ts`(`CdpBrowserDriver`)。生产在用的几个常量和纯函数不在删除范围,先搬走。搬走之后 cdp 包里不剩生产代码,整包移除。
- **现状 [实测]**:
  - `CdpBrowserDriver` 在生产代码里没有任何实例化点。
  - cdp 包被包外 import 的符号一共 15 个,使用者全在 desktop:

    | 符号 | 使用者 | 性质 |
    |---|---|---|
    | `CONTENT_CHAR_CAP`、`MAX_CONTENT_CHAR_CAP`、`encodeReadCursor`、`parseReadCursor`、`hashText`、`normalizePageText`、`READ_PAGE_STATE_EXPRESSION` | `browser-library/puppeteer-browser-driver.ts`、`main/browser-runtime/playwright-driver.ts` | 生产 |
    | `EXTRACT_LINK_CAP`、`MAX_IMAGE_DIM` | `browser-library/puppeteer-browser-driver.ts` | 生产 |
    | `CdpImageData`、`CdpScreenshotRequest`(类型) | `main/browser-driver/electron-screenshot.ts` | 生产 |
    | `CdpActionsDriver`、`CdpActionsDriverOptions`、`CdpSender`、`PageInfo` | `cdp-driver.ts` 和两个集成测试 | legacy |

  - 生产用的 11 个符号都没有内部依赖:4 个函数合计约 40 行;`scroll-state.ts` 92 行、无 import;两个接口约 20 行。
  - cdp 包里其余内容(`keymap.ts` 355 行、`sender.ts`、`types.ts` 的大部分、`buildExtractScript`、`cleanPageText` 等)只被 legacy driver 和它的测试使用。
- **代价(动手前要知道)**:有三个 desktop 测试文件不是在测 legacy driver,而是拿它当测试替身或对照组:
  - `main/browser-driver/automation-host.test.ts`(446 行):测的是生产的 `handleBrowserAction`,但 `createDriver` 注入的是 `new CdpBrowserDriver(假 CDP)`。
  - `main/browser-driver/scenario-e2e.test.ts`(153 行):同上,覆盖多步工具循环。
  - `main/browser-driver/scroll.integration.test.ts`(287 行):同一组滚动和读取场景在 cdp 与 playwright 两个后端各跑一遍。
- **步骤**:
  1. **搬生产符号。** 在 `packages/desktop/src/browser-library/` 新建文件放这 11 个符号,原样搬,不改实现。改 3 个 importer:`browser-library/puppeteer-browser-driver.ts:27`、`main/browser-runtime/playwright-driver.ts:25`、`main/browser-driver/electron-screenshot.ts:1`。`browser-library` 同时会被打进 Chrome 扩展,新文件不能 import node 或 electron 模块。
  2. **改三个测试。**
     - `automation-host.test.ts`、`scenario-e2e.test.ts`:写一个实现 core `BrowserBridge` 契约的测试替身。保留测宿主路由的断言:策略与域名白名单、guest 解析、driver 按 guest 缓存、错误映射、截图走 `captureElectronPage`。删掉"断言发出了哪些 CDP 命令"这类测 legacy driver 本身的用例。每删一个用例,在 PR 描述里列出名字和原因。
     - `scroll.integration.test.ts`:去掉 cdp 后端分支,只留 playwright。
  3. **删 legacy 代码。** `main/browser-driver/cdp-driver.ts`、`cdp-driver.test.ts`、`cdp-actions.integration.test.ts`;`main/browser-driver/index.ts` 里导出 `CdpBrowserDriver`、`CdpSender`、`PageInfo` 的两行。
  4. **删 `packages/cdp/` 整个目录。**
  5. **更新引用:**

     | 位置 | 改动 |
     |---|---|
     | 根 `package.json:20` | `build` 链去掉 cdp 那一段 |
     | `packages/desktop/package.json:220` | 去掉 devDependency |
     | `packages/desktop/scripts/build-workspace-dependencies.ts:24` | 去掉 cdp 条目 |
     | `packages/desktop/scripts/dev.ts:41-43` 和 `:240` 起的那段 | 去掉 `cdpDir` 及其注释,以及"启动前单独 build 一次 cdp"的整段 |
     | `packages/desktop/scripts/predist.ts:94` | 注释里拿 cdp 举例的部分 |
     | `scripts/package-release-audit-config.ts:110-114` | 去掉 cdp 的定义 |
     | `tests/package-boundaries.test.ts:305` | 私有包期望列表去掉 cdp |
     | `eslint.config.js` 的 `workspacePackageRoots` | 去掉 `"cdp"` |
     | `Dockerfile:11` | 去掉拷贝 cdp `package.json` 的那行 |
     | `.github/workflows/ci.yml:173` | 去掉 `cdp-actions.integration.test.ts` 的 ignore |
     | `.github/workflows/ci.yml:210` | rest 分片的路径去掉 `packages/cdp` |
     | `.github/workflows/ci.yml:461-463` | 去掉 "test Chromium CDP integration" 整个步骤 |
     | `CODESHELL.md:10`、`:31`、`:133`、`:175`、`:182` | 包数、包清单、build 顺序、gotcha 里关于 legacy cdp driver 的句子 |
     | `README.md:266` 和 `README.zh-CN.md` 对应行 | 目录树去掉 cdp |
     | `docs/architecture/06-capability-packages.md:991` 起的 §6.6 | 改成一句"已删除;读取游标和文本归一化工具在 desktop 的 `src/browser-library`" |
     | `docs/architecture/08-desktop-main.md:894`、`:1178` | 更新这几个工具的出处 |
     | `bun.lock` | `bun install` 重新生成 |

  6. **第三方声明。** `keymap.ts` 是从 browser-use 翻译来的。它删掉后桌面不再打包这部分代码,`packages/desktop/THIRD_PARTY_NOTICES.md:271` 起的 browser-use 一节和 `packages/desktop/src/main/third-party-notices.test.ts:25` 的断言要一起去掉。去掉之前先 grep 确认仓库里没有别的 browser-use 派生代码。
- **不要动**:`main/browser-driver/electron-cdp.ts`。名字里带 cdp,但它是指向 Puppeteer 实现的兼容导入路径,生产在用(`automation-host.ts:24`、`background-runtime.ts:37`)。
- **验收**:
  - `git grep -n "code-shell-cdp\|packages/cdp"` 只剩 CHANGELOG 和历史文档。
  - `bun run --cwd packages/desktop build` 通过(含 Chrome 扩展)。
  - desktop 分片、Puppeteer 和 Playwright 两个集成步骤、`Electron E2E` 通过;`bun run test:package-release` 通过。
- **覆盖变化(写进 PR 描述)**:`normalizePageText` 和读取游标的几个函数,原来主要靠 `packages/cdp/src/driver.test.ts` 里 `CdpActionsDriver.readContent cursor paging` 一组用例间接覆盖。删除后只剩 Puppeteer、Playwright driver 的测试在用它们。给搬过去的 4 个函数补几条直接的单元测试,加进已有的 `browser-library/puppeteer-browser-driver.test.ts`。

---

## 7. 需要你决定的事项(不交给模型)

1. **审计证据的去向。** E3 删除前,348 MB 的 `evidence/` 要不要先存一份(独立仓库、bundle、release 附件),还是直接删。
2. ~~arena 去留。~~ **已决定(2026-11-10):删除。** 见 R1。
3. ~~cdp 的 legacy driver 去留。~~ **已决定(2026-11-10):删除。** 见 R2。
4. **CI 关键路径是 `tests (desktop-ui)`。** 一次绿跑里它用了 40.2 分钟,其他所有 job 都在 11.3 分钟以内 [实测,run 42614455601]。其中 `test:ui:overlays` 单脚本 25.4 分钟,28 个 Web 浏览器脚本串行 9.5 分钟,安装浏览器 3.8 分钟。把这两步拆成两个并行 job,整轮 CI 约降到 30 分钟;要更短得把 overlays 脚本本身拆开。拆 job 会改变必需检查的名字,需要你同步改 ruleset。
5. **main 的 CI 连续两次红在同一个 E2E 夹具**(见 0.4 第 12 条)。交给别的模型开 PR 之前最好先处理,否则每个 PR 都可能撞上。
6. **分片预算贴顶。** rest-server 240/240 已满;desktop 已到预算,PR #332 为此又加了 4 条 ignore 和 1 个独立进程。是继续手工拆,还是改成按目录自动分批,需要你定。
7. **core 公开入口 `.` 的范围。** 现在导出 692 个具名符号(340 个 value),其中 panel-apps 64、plugins 61、links 56、credentials 50、themes 26 [实测]。哪些是有意对外的 SDK,只有你能定。core 已发布到 npm。
8. **路径根的语义不一致。** settings 认 `HOME` 不认 `CODE_SHELL_HOME`,sessions 相反(见 C1)。是有意的还是历史原因。
9. **web 的"纯逻辑面"要不要独立成包。** H2、H3 用子入口隔离是短期做法。server、desktop main、浏览器三方都在用 web 里的纯逻辑(转写回放、输出覆盖、账号策略、Panel 契约)。
10. **Pet/Mimi 的结构问题以你自己的方案为准。** `docs/superpowers/specs/2026-11-09-mimi-dispatch-notify-proactivity-design.md` §16 的 1c 收敛已经覆盖了 `pet-dispatch-service.ts`、`pet-notice-wiring.ts` 的拆分和事件解释的合并。本清单不另立任务。
11. **core 里认可残留之外的 pet 字面量。** 共 4 处:`session/session-state-shape.ts:27`(把未知会话种类归一成 `"work"`,而 `types.ts:266` 说会话种类是开放字符串)、`session/session-manager.ts:1193`(`state.kind === "pet"` 分支)、`settings/schema.ts` 的 `pet` 段和 `capabilityOverrides.pet`、`capability-control/overlay.ts`。量很小,是否清理你定。
12. **renderer 状态管理。** `App.tsx` 2948 行、35 个 `useState`;全 renderer 876 处直接调用 `window.codeshell`,分布在 168 个文件。需要先有设计,不适合直接交给模型。
13. **desktop main 进程内 composition 只含 coding。** `capabilities-service.ts:33` 和 `dream-service.ts:104` 用 `[createCodingModule()]` 组装,而 worker 实际加载的是 coding、pet、link 等。能力列表是否因此与实际不一致,需要确认。
14. **docs/todo 归档。** 228 个文件,`TODO.md` 链接了其中 69 个。哪些已完结需要人判断,不适合靠文案关键字自动归档。

---

## 8. v1 撤回项及原因

| v1 编号 | 内容 | 撤回原因 |
|---|---|---|
| A1 | 行数上限收紧到当前值 | 与 PR #330(2026-11-09)定的规则冲突:上限取 500 的倍数并留余量,是为了避免每个 PR 都去改数字 |
| A4 | main 中非 Electron 代码的行数预算 | 与第 16 章决策 7 不符;"不 import electron"这个指标也容易被规避 |
| B2 | 删除 arena | 曾因文档写明"有意保留"而撤回。2026-11-10 你确认可以删,已恢复为 R1 |
| B3 | 删除 cdp legacy driver | 曾因 CODESHELL.md 写明"兼容导出"而撤回。2026-11-10 你确认可以删,已恢复为 R2 |
| B5 | docs/todo 归档 | 判断依据是文案里的 "PASS/已合入",靠关键字判断散文不可靠。转 §7 第 14 条 |
| B6 | 孤儿脚本归档 | 复核后真正无引用的只有约 5 个,不值得单独立项 |
| C2 | host 包提供默认能力模块集合 | 不可行。host 不能依赖 coding,`tests/package-boundaries.test.ts` 钉死了 host 只依赖 core |
| C4 | web 导出 `./app` 入口 | `web/app` 是 vite 直接编译的 SPA 源码,不产出 dist。改为 G3 里的白名单 |
| D5 | 删除 legacy 单 Engine run 路径 | 它是公开 SDK `createServer({ engine })` 的路径。其中的丢字段问题升级为 T1 |
| D6 | Pet 概念移出 core 契约 | 大部分是文档认可的兼容残留。剩 4 处转 §7 第 11 条 |
| D7 | 收紧公开入口 | 是产品决定。转 §7 第 7 条 |
| D8 | 进程级单例并入 EngineRuntime | 现有隔离模型是每用户一个 worker 进程,同进程多租户不是目标 |
| E3 | Pet 逻辑从 desktop main 下沉 | 你已有 §16 的 1c 收敛方案。转 §7 第 10 条 |
| E5 | Settings/Session 实例由组合根注入 | 共享实例有跨进程读到旧值的风险,收益不明 |
| E6 | renderer 的 client 封装层 | 不解决类型契约问题,只增加一层转发。转 §7 第 12 条 |
| F2 | CI 构建一次复用产物 | 实测 `bun run build` 每个 job 只占 0.5–0.8 分钟,且各 job 并行。关键路径在别处,转 §7 第 4 条 |
| F3 | 测试分片自动均分 | 转 §7 第 6 条 |
| F5 | 构建图评估 | 根 `tsconfig.json` 已有指向源码的 `paths`,问题范围比 v1 说的小。暂不立项 |

v1 的 D2、D3 合并改写为 C4。

---

## 附录 A:core 分层实测数据

量法:TypeScript AST 扫描 `packages/core/src` 的非测试源码,只算 value import(含 `import()`、`require()`),`tool-system/builtin` 单独成节点。基线 `fcd8406d5`:633 个文件、161,928 行;目录间 value 边 259 条;最大强连通分量 27 个目录、147,551 行。

### A.1 建议分层

文件可以 value import 同层或编号更大的层。import 编号更小的层算"上行"。

| 层 | 目录 |
|---|---|
| L0 入口 | cli、product(根目录的 `index*.ts` 等也在这层,不检查) |
| L1 协议与运行 | run、protocol |
| L2 引擎 | engine |
| L3 内置工具与组合 | tool-system/builtin、composition |
| L4 能力子系统 | automation、skills、plugins、panel-apps、links、sources、operations、services、prompt、preset、hooks、context、capability-control、profile、themes、speech、stt |
| L5 工具基础设施 | tool-system(不含 builtin) |
| L6 存储与模型 | session、credentials、settings、model-catalog、llm、model-request-boundary、model-traces、cost-ledger、goal、workspace |
| L7 基础 | utils、runtime、logging、data、agent、remote、testing、capabilities |

### A.2 上行 import(29 条,23 个文件)

| 文件 | 上行到 | 引入的符号 | 性质 |
|---|---|---|---|
| `composition/core-module.ts` | engine | `ISOLATED_TASK_PROFILE`、`QUICK_CHAT_RESTRICTED_PROFILE` | 机械 |
| `tool-system/builtin/configure-model-connection.ts` | engine | `modelEntriesFromConnections` | 需设计 |
| `automation/runner.ts` | run | `AUTOMATION_RUN_SOURCE` | 机械 |
| `hooks/registry.ts` | composition | `onceDispose` | 机械 |
| `hooks/goal-stop-hook.ts` | tool-system/builtin | `listRunningBackgroundWork` | 需设计 |
| `links/github-issue-batch.ts` | engine | `resolveRunProfileState` | 需设计 |
| `links/operation-reader.ts` | engine | `resolveRunProfileState`、`composePermissionRules`、`buildToolVisibility` | 需设计 |
| `preset/index.ts` | tool-system/builtin | `deriveBuiltinPresetExposure`、`deriveToolGatedPromptSections` | 需设计 |
| `prompt/composer.ts` | tool-system/builtin | `buildSkillListing` | 需设计 |
| `skills/isolated-instruction-run.ts` | protocol | `createServer`、`createClient`、`createInProcessTransport` | 需设计 |
| `tool-system/session-tool-host.ts` | engine | `composePermissionRules` | 需设计 |
| `tool-system/session-tool-host.ts` | hooks | `HookRegistry`、`registerConfiguredHooks` | 需设计 |
| `tool-system/registry.ts` | composition | `onceDispose` | 机械 |
| `tool-system/registry.ts` | tool-system/builtin | `BUILTIN_TOOLS`、`toToolExecutionResult` | 需设计 |
| `tool-system/dynamic-tool-defs.ts` | tool-system/builtin | `agentToolDefWithTypes`、`generateImageToolDefFor`、`generateVideoToolDefFor` | 需设计 |
| `tool-system/executor.ts` | tool-system/builtin | `complete-goal`、`cancel-goal` 两个模块 | 需设计 |
| `tool-system/session-tool-policy.ts` | capability-control | `computeEffectiveDisabledLists`、`effectiveBuiltinLists`、`effectiveProjectOverrides` | 需设计 |
| `tool-system/path-policy.ts` | plugins | `readInstalledPlugins` | 需设计 |
| `credentials/access.ts` | links | `executeRemoteLinkAction`、`executeLocalOAuthLinkAction`、`isFigmaMcpCredential` 等 | 需设计 |
| `credentials/access.ts` | services | `refreshToken` | 需设计 |
| `credentials/use-credential-tool.ts` | tool-system | `SENSITIVE_TOOL_RESULT_PLACEHOLDER` | 机械 |
| `session/output-history-comparison.ts` | engine | `outputUserMessage` | 机械 |
| `session/output-history-native-comparison.ts` | engine | `outputUserMessage` | 机械 |
| `session/background-continuation.ts` | tool-system/builtin | `buildNotificationMessage` | 需设计 |
| `settings/schema.ts` | panel-apps | `PanelAppPackagePinsSchema` | 机械 |
| `settings/schema.ts` | sources | `WorkspaceSourceBindingSchema` | 机械 |
| `settings/schema.ts` | tool-system | `MAX_MCP_CONNECT_RETRIES`、`MAX_MCP_CONNECT_TIMEOUT_MS` | 机械 |
| `runtime/background-shell.ts` | tool-system/builtin | `notificationQueue` | 需设计 |
| `runtime/background-shell.ts` | session | `codeShellHome` | 机械(C1) |

机械 11 条,需设计 18 条。扫描还会报一条 `sources/__fixtures__/runtime-mock.fixture.ts → tool-system/builtin`,是夹具文件,G2 实现时要排除 `__fixtures__`。

### A.3 同层互依(6 对)

| 目录对 | 一个方向 | 另一个方向 |
|---|---|---|
| hooks ↔ plugins | `hooks/configured-tool-hooks.ts`、`hooks/register-configured-hooks.ts` → plugins | `plugins/pluginCommandHook.ts` → `hooks/hook-output.ts`、`hooks/shell-runner.ts` |
| model-catalog ↔ settings | `model-catalog/index.ts` → `settings/manager.ts` | `settings/migrate-config.ts` → `model-catalog/builtin.ts` |
| panel-apps ↔ plugins | `panel-apps/installer.ts` → `plugins/installer/unzip.ts` | `plugins/installer/projectPluginSource.ts` → `panel-apps/manifest.ts` |
| plugins ↔ skills | plugins 下 3 个文件 → `skills/frontmatter.ts` | `skills/scanner.ts` → `plugins/installedPlugins.ts` |
| preset ↔ prompt | `preset/index.ts` → `prompt/section-loader.ts` | `prompt/composer.ts` → `preset/index.ts` |
| profile ↔ sources | `profile/types.ts` → `sources/types.ts` | `sources/resolve.ts` → `profile/resolve.ts` |

## 附录 B:IPC 预算清单外的文件

main 路由(9 个文件,82 条):

| 文件(`packages/desktop/src/main/` 下) | 路由数 |
|---|---|
| `project-authority-ipc.ts` | 28 |
| `pet/pet-ipc.ts` | 25 |
| `im-gateway-service.ts` | 11 |
| `computer-use/mimi-companion-host.ts` | 5 |
| `panel-app-bridge.ts` | 5 |
| `pet/pet-notice-ipc.ts`(PR #332 新增) | 4 |
| `file-version-ipc.ts` | 2 |
| `cloud-environment-ipc.ts` | 1 |
| `window-titlebar.ts` | 1 |

preload invoke(9 个文件,108 条):

| 文件(`packages/desktop/src/preload/` 下) | invoke 数 |
|---|---|
| `project-authority-api.ts` | 48 |
| `pet-api.ts` | 38 |
| `session-catalog-api.ts` | 8 |
| `mimi-companion.ts` | 4 |
| `background-work-api.ts` | 3 |
| `panel-app.ts` | 3 |
| `panel-mutation-api.ts` | 2 |
| `cloud-environment-api.ts` | 1 |
| `external-runtime-session-state.ts` | 1 |

## 附录 C:core 里直接 `renameSync` 且未引用锁的文件(未判定)

T3 处理了前两个。其余 12 个需要逐个判断写的是不是多进程共享的文件,本清单不立项:

- `engine/persist-active-model.ts`(T3)
- `plugins/installer/pruneDisabled.ts`(T3)
- `settings/schema-export.ts`
- `context/tool-result-storage.ts`
- `plugins/installer/removeDirectory.ts`
- `tool-system/builtin/background-job-history.ts`
- `cost-ledger/store.ts`
- `operations/archive.ts`
- `profile/store.ts`
- `model-traces/store.ts`
- `run/Heartbeat.ts`
- `run/FileRunStore.ts`
- `services/session-memory.ts`
- `session/project-memory-root.ts`

判定方法是文件内有没有出现 `file-mutex`、`lockfile`、`acquireFileLock`、`mutateJsonFile`、`lockSync` 等字样,只是线索,不代表一定有问题。
