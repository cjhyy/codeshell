# Round 6 — Core Task/Todo data and display consumers

冻结基线：`cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`，分支 `codex/audit/task-skills-package-round6-20261017`。本切片 **0 个新增确认发现**；这表示下列已检查合同没有得到新的反例，不表示 Task/Todo 全模块没有缺陷。未改产品源码，未执行 Git 写操作。

## 当前合同与调用方

| 范围 | 当前源码合同及消费者 | 本轮证据与界限 |
| --- | --- | --- |
| store / create / update / list / delete / dependencies | `packages/core/src/tool-system/builtin/task.ts:4–26,49–85` 明确使用唯一 `TodoWrite` 全量快照，transcript 是 store。新建、修改、重排、删除通过替换数组表达；没有当前独立 TaskCreate/Update/Get/List/Delete API，也没有普通 todo dependency 字段。`builtin/index.ts:608–617` 注册 TodoWrite；`types.ts:634–639` 的 TaskInfo 也无 dependency 字段。 | 追踪真实路径及注册点，未把已移除 API 或不存在的 dependency store 算作功能缺陷。 |
| live / replay | `task.ts:90–141,154–170`：非数组外层输入返回错误且不发事件；数组内过滤无效项，缺失 activeForm 回退 content；生成位置 id；所有项 completed 时发空列表。`engine.ts:2520–2531` 在 resume 时只发非空快照。 | 真实 `todoWriteTool`、`readLastTodoSnapshot`，替换/删除/清空、最新快照优先、无效外层跳过、legacy 名称不复活。一个测试内部枚举长度 0–3 的 40 种受支持状态组合。没有执行 Engine.run 或模型。 |
| guard metadata | `task-guard.ts:29–43,61–90` 依赖同一快照的稳定数组引用，替换/clear/reset 后重算年龄；首次 stale 和 re-nag 间隔均为 3 turn。`run-tooling.ts:164–169,301` 接入快照，`turn-loop.ts:1941–1952` 轮末读取；`run-stream.ts:127–154,228–230` 将 child 事件转发后提前返回，不改父 latestTodos。 | 真实 TaskGuard 与 real stream wrapper + 内存 callback；证明 child 替换/清空不改父 guard 元数据、同位置新项不继承年龄、pending 不催促。无真实 Session / journal 写入。 |
| Desktop disk / reducer / labels | `main/transcript-reader.ts:181–209,391–403` 本地镜像快照转换；`renderer/types.ts:1453–1476` 替换唯一主列表并丢弃 child todo。`renderer/App.tsx:1825–1835` 取最新列表，`topbar/StatusPopover.tsx:220–250` 显示进度和 activeForm；`messages/TaskListMessageView.tsx:19–65` 是另外的列表视图。 | 真实 reader → foldTranscript → reducer，与 live 对比另一个测试内部的同 40 个状态组合；多次写入只保留最新 panel，completed 清空，child 不覆盖 parent。label 组件为静态检查，没有真实 Electron/截图验证。 |
| TUI | `tui/src/ui/App.tsx:190–197,948–963,2150` 按 main / child owner 保存和选择快照，空 child 只删除该 owner；`components/TaskList.tsx:13–60` 显示状态和 activeForm。 | 现有 `App.agent-todos.test.tsx` 首跑，fake client + Ink mount，覆盖替换/clear/跨 session 晚到/复用 child id。未运行真实 CLI、provider、PTY 或用户会话。 |
| Web | `web/src/lib/streamReducer.ts:553–584` 明确忽略主 todo，只按 agentId 替换 child 进度行。 | 真实 reducer 检查主列表忽略及两 child owner 替换；未运行服务、浏览器、WebSocket 或真实 agent lifecycle。没有扩展既有 WEB-R5-01 生命周期方向。 |

## 排除候选与查重

候选独立存放在 [tasks-candidates-and-dedup.json](evidence/tasks-candidates-and-dedup.json)，确认发现集合是 [tasks-findings.json](evidence/tasks-findings.json)，两者不混计。

- 独立 CRUD/dependency store 缺失：当前合同明确已替换为 TodoWrite 快照，不构成新问题。
- all-completed 的 Engine resume 不发空 task_update：`docs/archive/todo/plan-group-a-core.md:29–31,145–159` 与现有 `engine.todo-resume.test.ts:88–112` 明确接受该行为；不重复提出需要额外产品合同的旧候选。本轮没有运行该 Engine 测试。
- TaskGuard 同位置 id 继承旧年龄：`docs/todo/2026-09-11-overnight-todo-audit.md:21,134` 已记录修复；本轮源码和首跑证明快照替换会重置，不新增计数。
- Desktop/Web 不展示主或 child 的特定 todo：各消费者合同不同。Desktop child omission 在 `docs/superpowers/specs/2026-05-28-desktop-subagent-isolation-followup-design.md:18,127–134` 明确要求；Web 源码明确只展示 child，TUI 当前已有 child 详情快照。不能把跨 UI 差异当统一功能缺失。

[tasks-dedup.json](evidence/tasks-dedup.json) 扫描全部既有 `docs/audit-*`、`docs/review*`，以及 docs 下全部 archive / _archive：**338 JSON 文件全部解析成功、2,229 个带识别/状态字段的嵌套对象记录、512 Markdown 文件**。这些对象包含验证收据等，并非 2,229 条 finding；task 专用词命中 JSON 记录 0、Markdown 文件 18。另核查上述现行交付/设计记录。查重只覆盖此保存语料与词项，不能证明语义等价旧问题绝不存在。

## 首次验证收据

仅使用 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILE`。三次独立首次执行均保存原始合并 stdout/stderr 和真实 runner exit；没有失败、fixture 修复、重试或替代执行。

| shard | tests | expect | fail / skip | exit / 完成标记 |
| --- | ---: | ---: | --- | --- |
| [tasks-snapshot-contract.test.ts](evidence/tasks-snapshot-contract.test.ts) | 7 | 161 | 0 / 0 | 0 / Completed |
| [tasks-display-contract.test.ts](evidence/tasks-display-contract.test.ts) | 4 | 91 | 0 / 0 | 0 / Completed |
| 现有 `packages/tui/src/ui/App.agent-todos.test.tsx` | 2 | 28 | 0 / 0 | 0 / Completed |
| 合计 | **13** | **280** | **0 / 0** | **3 shards 均完成** |

两个参数枚举各检查 40 个组合，仍各计 1 个测试；不是新增 80 个测试。三份首日志：`evidence/tasks-snapshot-contract.first.stdout+stderr.log`、`evidence/tasks-display-contract.first.stdout+stderr.log`、`evidence/tasks-tui-owner.first.stdout+stderr.log`，均被仓库通用 `*.log` 规则忽略，交付时须显式保留。机器收据含日志 SHA、exit SHA、计数及限制：[tasks-receipts.json](evidence/tasks-receipts.json)。

源码哈希与 frozen commit 比较：[tasks-source-manifest.json](evidence/tasks-source-manifest.json)。本轮没有网络请求、真实模型调用、付费执行或用户数据 fixture；执行范围为源码纯转换、内存 fake 和 guarded runner 创建的隔离环境。没有声称覆盖权限、安全、native/realexec、全部 Engine resume、任意历史导入、超大数据、完整进程生命周期或真实 UI 行为。
