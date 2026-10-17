# Desktop 普通显示与数据投影审查 — round 6

冻结基线 `cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`，分支 `codex/audit/task-skills-package-round6-20261017`。本分审新增正式问题 **0**。两份既有隔离组件 fixture 首跑通过，共 **12 tests / 71 expect / 0 fail / 0 skip**；另一份自有纯函数 fixture 在解析 import 时失败，按约束保留首次证据并停止该方向，不能算产品失败或通过。

## 范围与正常合同

- **日志显示**：`pages/PageRegistry.ts:91–93,194–198` 挂载真实 `LogsView`；`LogsView.tsx:78` 调用公开 `tailLog(bucket, limit)`，preload `index.ts:996–997` 和 Main `activity-history-ipc.ts:37–45` 传递三个正常 bucket 与有界行数。`logs-service.ts:1–7` 明确是按需读取最近 N 行，没有实时 streaming 合同。本轮 Main/preload 只用于确认当前调用合同，没有执行它们或读取真实日志。
- **设置搜索/导航**：`SettingsPage.tsx:214–217` 按本地化模块名和分组名匹配，`:453–465` 同时按 scope 过滤；`:669,706` 的两个搜索框共享 query，`:571–607,707–713` 消费同一结果；`:592–596,524–535` 在窄屏选择模块后清查询并移交标题焦点。测试范围限模块发现与导航，不评价其设置写入。
- **侧栏列表**：`Sidebar.tsx:108,117` 的正常上限为 compact 5、expanded 每页 60；`:996–1008` 先过滤归档、按 pin/activity 排序，再传入当前项目 active id 与 revealed id。`sidebarSessionVisibility.ts:16–32` 在分页中保留必要行及输入顺序。没有把传入 0/负数/小于两个必要行的虚构 cap 当生产触发。
- **模型选项显示**：`App.tsx:1524–1528` 和 `settings/AgentsSection.tsx:148–155` 消费真实 `catalogModelOptions`；`textConnections.ts:158–184` 明确 connection instance id 才是 key，显示 label 可以相同，未解析 catalog 和非 text 项会被排除。`chat/ModelPill.tsx:53–54,216–247` 使用分组显示、按 key 标记选项；`modelPickerPresentation.ts:2–12` 用 Map 保留首次 provider 顺序和原选项对象。未评估模型运行、参数、上下文预算或持久偏好。

## 候选与处置

| 候选 | 正常触发、预期及实际证据 | 处置、影响与限制 |
|---|---|---|
| DD6-01：切日志源或刷新后显示旧源结果/错误 | 正常 desktop→engine→desktop，以及刷新失败后重试。预期只接受当前读取、保留同源已加载内容，并区分空日志与无匹配。`LogsView.tsx:66–106` 用 effect cleanup 拒收旧结果，`:107–108` 只投影当前行。既有真实组件首跑 7/51 覆盖旧 success/error、卸载、匹配计数和恢复，全部符合预期。 | **REJECTED**，没有发现显示错误；不分配问题 severity。测试调用实际 React handler/状态，bridge 仅为 owned deferred promise；不是 Electron、真实文件或原生键盘验收。行数 picker 的实际交互、复制和真实滚动布局不在动态覆盖内。 |
| DD6-02：窄屏搜索选中模块后状态/焦点错误，或搜索泄出不支持 scope 的模块 | 正常切换可见搜索布局、搜索“外观”、点击结果和清除无匹配 query。预期同步两个 query、结果选择后聚焦新标题、project scope 不出现 user-only 模块。`SettingsPage.tsx:453–465,507–535,592–596` 和真实组件首跑 5/20 给出一致结果。 | **REJECTED**，未确认导航错误，不分配 severity。可见性几何为既有 MiniDOM fixture 的受控布局替身；没有真实 Chromium resize、Radix popup/IME、设置读写或账户操作结论。 |
| DD6-03：分页时 active/revealed 行丢失或原排序被修改 | 当前消费者确实使用 5/60 上限；静态 `sidebarSessionVisibility.ts:18–32` 对两个必要 id 进行保留，再按原列表过滤；`:39–43` 复制后排序。自有 500 行 immutable 输入矩阵原计划核验正常分页。 | **SKIP（fixture）**：首次 import 解析失败，0 项产品测试执行；静态代码提供反证方向但不宣称动态通过。未渲染 Sidebar、没有项目/工作区/native 查询，未确认用户可达缺陷或影响，不分配 severity。 |
| DD6-04：同名模型显示项合并/选择身份丢失 | 正常两个 provider 的模型有相同 label，并含 custom model id；预期 key 仍是 instance id，显示分组不删除对象。`textConnections.ts:177–181` 保留 key 与 label，`modelPickerPresentation.ts:3–10` 仅按 provider 分组。自有矩阵原计划验证这一合同。 | **SKIP（与 DD6-03 同一 fixture）**：未在失败后拆分、修复 import 或改用既有测试重跑。没有把注释中的旧 models[] 术语、同名 label 或刻意 stale catalog 当缺陷；不主张模型误用/费用，不分配 severity。 |

`catalogEditor.ts`、`connFormat.ts`、`SettingsMenu.tsx` 仅用于普通显示/导航合同的补充静态阅读，没有新增独立问题或动态覆盖。32 个源码文件的整文件哈希及实际阅读范围见 [desktop-source-manifest.json](evidence/desktop-source-manifest.json)；哈希覆盖整个文件不代表逐行审核所有代码。

## 旧记录去重

完整检索冻结 HEAD 已跟踪的全部 `docs/audit-*`、`docs/review*` 和 `docs/archive` 的 `.md/.json/.txt` 记录，**885 文件 / 14,627,167 bytes**。四组检索命中分别为 logs 36、settings navigation 91、sidebar projection 421、model options 58；完整路径、行内容和 885 文件 SHA256 保存在 [desktop-dedup.json](evidence/desktop-dedup.json)。这是候选去重文本检索，不代表重新执行旧 fixture 或独立验证每条旧报告。

- `docs/review-remaining-2026-10-12/hosts.md:39–43` 已有 logs/runs/inbox/subagents 静态 coverage，没有把既有覆盖重新称新发现。
- `docs/archive/review-2026-05-30/findings.json` 已记录 `logs-service.ts` 的空行过滤观察；本轮没有重新发现、执行或晋升它。当前审查是 renderer 对公开返回行的显示。
- `docs/review-2026-10-12/validation/original-sidebar-title-round27/independent-quality.raw.md:5–18,43–53` 对 sidebar/history 双标题来源已明确保留 0 finding。本轮没有借同名词恢复它，也没有用不明确的统一命名合同晋升问题。
- 旧 R61 多窗口选中会话同步、R75 模型偏好整图覆盖（`model-switch-round18.md` / `model-switch-quality-round18.md`）、R70 自定义指令失败后重试（`settings-recovery-round16.md`）、菜单目标/recents 陈旧，以及源/设置保存类问题均有不同既有记录，本轮排除其持久化、项目变更、原生菜单和写入方向。
- 没有恢复旧失败 CLI、recorder、summary、Discord、memoryTTL 方向；没有进入并行修复的 annotation/Review/context-tail 区域。

## 首次执行收据

三个命令均为 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILE`，逐文件只执行一次。现有 guarded runner 隔离 HOME/应用状态及继承凭据；组件使用其原有自有 MiniDOM、内存 storage/bridge。没有修改 fixture 来制造 DOM 方法失败，没有真实应用状态、网络、模型、付费或 native 调用。

| FILE | 首次结果 | 原始 stdout+stderr 与退出收据 |
|---|---|---|
| `packages/desktop/src/renderer/logs/LogsView.interaction.test.tsx` | exit 0；7 tests / 51 expect / 0 fail / 0 skip；Completed | [raw log](evidence/desktop-logs-first.log)，[exit + hash](evidence/desktop-logs-first.exit.json) |
| `packages/desktop/src/renderer/settings/SettingsPage.search.test.tsx` | exit 0；5 tests / 20 expect / 0 fail / 0 skip；Completed | [raw log](evidence/desktop-settings-search-first.log)，[exit + hash](evidence/desktop-settings-search-first.exit.json) |
| `docs/audit-2026-10-17-round6/evidence/desktop-display-projections.test.ts` | exit 1；import 路径多向上一层，`Cannot find module`。Bun 原文 0 pass / 1 fail / 1 error；测试体未执行，不能当产品失败。 | [unchanged fixture](evidence/desktop-display-projections.test.ts)，[first raw log](evidence/desktop-projections-first.log)，[exit + hash](evidence/desktop-projections-first.exit.json) |

失败 fixture 与首次日志保持原样；**未修复、未重试、未换方法**。审计的 DD6-03/DD6-04 方向标记 SKIP，不冒充 Bun 的 test skip。总计 3 次 shard 尝试、2 次零失败完成、1 次 fixture 解析失败；成功 shards 共 12 tests / 71 expect，失败 shard 无产品测试执行。机器可读收据见 [desktop-results.json](evidence/desktop-results.json)。

仅写入本报告和 `evidence/desktop-*`。没有产品修复、git mutation、真实应用或用户状态验收；这一小范围正常控制不构成整个 Desktop 的通过结论。
