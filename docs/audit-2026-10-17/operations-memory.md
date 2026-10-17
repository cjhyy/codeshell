# Core operations / memory / 本地进度审查

基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`，分支 `codex/audit/remaining-20261017`。只增加本报告和 `evidence/ops-*`，不改产品、既有测试或 Git。运行证据限纯函数、自有临时根目录与内存 fake；不触碰真实账户、模型、网络、权限/认证或安全攻防。

## 覆盖与执行记录

- 第一轮：operations ledger/resolver/recovery/archive 当前代码；memory session summary 排序、持久化、recall TTL、pending/global 搬移。
- 第二轮：memory extraction/merge/promotion 的实际 orchestrator + 假模型与实际 promotion gate。
- 第三轮：任务进度 reducer 的并行事件时序；RunQueue、FileRunStore、RunManager、Heartbeat、CheckpointWriter、ArtifactTracker、Evaluator 当前代码与自有磁盘状态恢复。
- 第四轮：项目 memory 持久 key 的自然路径碰撞与冷重建/注入索引。
- 既有报告仅用于查重。`docs/review-remaining-2026-10-12/core-lifecycle.md` 的并发 auto-dream cadence 重复消费属于已知，本轮不计为新发现。
- 所有 Bun 运行均通过 `node scripts/run-bun-test-shard.mjs`，首跑即将 stdout/stderr 重定向到 `evidence/ops-*.log`；失败/中止原样保留，转其他独立模块，不调整重跑同项。
- 收束统计：确认 **4 项（P2=2、P3=2）**：OM1、OM3、OM4、OM5；OM2为语义候选。完整成功 shard 合计 **31 个实际执行测试 / 155 expect / 0 failure**，另有 round1 **1 pass / 3 fail / 7 expect** 的首次失败组，单独保存，不纳入 Completed 门禁统计。未做二次运行。
- `evidence/ops-source-manifest.json` 保存 14 个关键生产源码和 10 个本分审 fixture/log 的 SHA-256；14 个源码逐字节匹配冻结 Git blob。收束后依父任务要求只读复核 Sources/Desktop 报告，结果另存 `evidence/quality-ops-review.md`，未重跑测试。

## 已确认发现

### OM1 · P2 · 全局候选的 ADD 被 promotion gate 改成按名称覆盖项目 dream

- 位置：`packages/core/src/services/global-dream-promotion.ts:99–114`，入口 `packages/core/src/services/memory-orchestrator.ts:228–243`。
- 触发：项目 dream 中已有 auto/reference `retry-policy`，正文“Do not retry charge requests after an uncertain result.”；本次提取同名但不同请求类别正文“Retry read requests twice after a temporary error.”，scope=global。两条 `type` 都是 reference。真实 orchestrator 调用 fake LLM 得到明确 `ADD` 决策（保留两条不同请求类别事实）。
- 预期：ADD 不能替换现有不同正文；若需更新，应经过 UPDATE 的目标 ID 和同主题判定。
- 现有契约：`memory-orchestrator.ts:613–615` 要求对照旧正文，保留方向、否定、数字、范围差异，缺失/相似主题不能证明 UPDATE/DELETE，不能确定时选择 ADD；`:661–663` 明确相似词不能证明新事实取代旧事实，只有完全重复才可在没有显式 LLM UPDATE 时压掉。gate 的按名称覆盖绕开了这两处写入层契约。
- 实际：gate 忽略 ADD 语义，只按名称挑现有项目 dream，再用其 ID `save()` 新正文；项目只剩 ID=`original` 的 read 规则，charge 规则正文被覆盖。pending 同时写入新正文。
- 影响：自动提取可在未作 UPDATE 决策时丢失另一条 auto/dream 持久记忆。范围限项目 auto/dream；未证明 manual 记忆损坏、真实模型行为或外部副作用。
- 证据：`evidence/ops-memory-promotion-round2.test.ts` 第一个测试；原始 `evidence/ops-memory-promotion-round2.log`，整组 **2 pass / 0 fail / 13 expect，Completed**。实际 MemoryManager、MemoryOrchestrator、promotion gate 与自有临时文件；模型是两次内存 JSON 响应。
- 查重：未在本轮检索的旧审查报告发现同一问题；旧 auto-dream cadence 竞态与本项不同。

### OM3 · P3 · Session summary 接受时区偏移时间但按字符串排新旧

- 位置：`packages/core/src/services/session-memory-sort.ts:12`，接受范围 `packages/core/src/services/session-memory.ts:145–148`。
- 触发：合法保存 older=`2026-10-17T01:00:00+08:00`（实际 UTC 10/16 17:00），newer=`2026-10-16T23:00:00Z`（实际晚六小时）。
- 预期：`listSessionMemories` 契约“most recent first”应返回 newer、older。
- 实际：返回 older、newer。保存校验使用 Date.parse，排序却直接比较原始字符串。
- 影响：SDK/导入调用传入带偏移有效时间时顺序错误，limit 较小时可能选入旧摘要；内建 orchestrator 的 `toISOString()` 时间为统一 UTC，不受该样例影响。
- 证据：`evidence/ops-memory-data-round1.test.ts` 第一个测试实际通过并打印 expected/actual。**该整组是 1 pass / 3 fail / 7 expect，退出 1，没有 Completed，不构成完成门禁。** 原始 `evidence/ops-memory-data-round1.log` 保留未覆盖。不能将单项观察扩大为整组通过。
- 查重：旧 2026-05-30 发现是“按文件名排序”，当前代码已经修成 createdAt 字符串；本项为不同有效时间表示的剩余边界。

### OM4 · P3 · 并行工具完成的进度时间来自另一个工具

- 位置：`packages/core/src/tool-system/builtin/agent-progress.ts:29–54`；实际子代理进度入口 `packages/core/src/tool-system/builtin/agent.ts:386–398`。
- 触发：Read/id=a 在 t=10 开始；Search/id=b 在 t=20 开始；Read/id=a 在 t=30 完成。
- 预期：Read 完成记录若携带 `startedAt`，应保留其自身 t=10，或在无法关联时省略。
- 实际：reducer 未保留 tool ID/独立起始时间，Read 完成复制 `previous.lastTool.startedAt`，结果 `{name:Read,state:completed,startedAt:20,finishedAt:30}`；t=20 属于 Search。
- 影响：子代理 progress 的工具起止元数据错误；未发现当前 UI 用该字段计算时长，不扩大为工具执行错误、后台任务提前完成或现有 UI 时长错误。
- 证据：`evidence/ops-progress-recovery-round3.test.ts` 第一项，原始 `evidence/ops-progress-recovery-round3.log`，**2 pass / 0 fail / 7 expect / Completed**；纯 reducer，无真实工具。
- 查重：本轮检索旧报告未见同一问题。

### OM5 · P2 · 普通嵌套路径与连字符项目名映射到同一个 memory 根目录

- 位置：`packages/core/src/session/memory.ts:189–191`。
- 触发：同一 workspace 下两个实际不同目录 `team/api` 和 `team-api`，分别创建 project-scoped MemoryManager；均为自有临时根内的普通目录，没有符号链接或路径穿越。
- 预期：两个不同 projectDir 的项目记忆独立，B 的“this repo”注入索引只含 B 的项目事实。
- 实际：将路径分隔符替换为 `-` 的所谓 `projectHash` 对两个路径产生同一 key。A 保存一条后 B 立即读到；B 再保存另一条，冷重建 B manager 仍读到两条；B `buildInjectionIndex` 的 “Project memories (this repo)” 同时包含 A schema-v1 与 B schema-v2 的事实。
- 影响：自然项目命名导致持久数据混合、错误项目事实注入；相同 ID 更新/删除的更严重后果未执行，不声称已证明原文覆盖、模型误改文件或安全越权。
- 证据：`evidence/ops-memory-project-key-round4.test.ts`、原始 `evidence/ops-memory-project-key-round4.log`；**1 pass / 0 fail / 6 expect / Completed**。真实本地 MemoryManager/冷重建/注入索引，无网络、真实模型、权限实验。
- 查重：旧审查检索未发现此自然路径 key 碰撞；与 Desktop 的模型切换状态、Web 项目归属大小写问题不同。已与 Desktop 分审协调，该项未被其重复覆盖。

## 基线与首次失败记录

- 独立既有 operations 基线：`node scripts/run-bun-test-shard.mjs --timeout 30000 --test-name-pattern '^(schema2 reclaims|readonly lookup|a fresh verification|an unrelated real write|a schema2 orphan|unknowns, attempts|all legal encrypted|an archived unsent|original private recovery|only successful independent reads|two failed verification)' packages/core/src/operations/archive.test.ts packages/core/src/operations/controller.test.ts`。
- `evidence/ops-operations-baseline-round1.log`：11 pass、26 filtered out、0 fail、89 expect；runner `Completed Bun shard: 37 tests, 26 skipped; 0 failures.`。确认覆盖普通冷归档回放、readonly lookup 无写盘、原子 staging 回收、原始 recovery slots 保留与假 adapter 的验证重读预算。筛掉权限/认证、安全攻防与进程压力条目，不声称全 operations 测试通过。
- 首次 round1 三个同名 TTL/搬移观察脚本假定 readdir 顺序，实际目录顺序不同，分别在准备断言或结果断言失败；promotion/approval 样例选中了当前枚举首项，因此实际为正确删除。它们没有动态证实候选。原文件与原日志不修改，不调整后重试，已经转独立 promotion 模块。
- 独立本地状态基线：`node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/run/RunQueue.test.ts packages/core/src/run/FileRunStore.list-pagination.test.ts packages/core/src/run/RunManager.recover.test.ts packages/core/src/tool-system/builtin/agent-progress.test.ts`；`evidence/ops-state-baseline-round3.log` 为 **15 pass / 0 fail / 40 expect / Completed**。只使用自有临时文件、当前进程/确定不存在 PID 的 signal-0 存在性检查、内存 parked executor；没有子进程、真实模型或原生工具运行。

## 已验证边界（不计缺陷）

- 冷 `queued` snapshot 不被 `recover()` 或 `resume()` 接管；SDK `start()` 可正常执行并完成。round3 第二项实际 FileRunStore/RunManager + fake executor：recover=`[]`、queued 不动、resume 明确拒绝、SDK start 后完成一次。**不计确认缺陷**：RunQueue 明确注明 Phase 1 无 persistence，recover 文档明确只扫 running，当前架构文档也描述此范围。CLI 没有 start 子命令是恢复能力缺口候选，但不能以本地观察偷换为承诺已实现自动恢复。未运行真实进程 crash 或 CLI 模型配置路径。
- 旧 evaluator warning→failed 为 SDK 契约歧义，旧报告已记录；不重复计数。

## 当前覆盖边界

| 子模块 | 本轮实际覆盖 | 未执行/不声称 |
| --- | --- | --- |
| operations ledger/archive/recovery/controller | 当前 ledger 全部状态转换/批次 reserve/seal/冷 receipt 与归档 retention/collect；11 条既有普通磁盘数据基线 | 权限、认证、安全攻防、provider 网络、真实账户；全量测试、多进程压力、磁盘满、真实 crash 注入 |
| operations resolver | 读取 sticky selection/pending/generation/error budget 数据流程 | 授权检查实验和真实适配器发现；未单独运行全部 resolver suite |
| memory manager/session summary | 当前存储/索引/metadata/recall TTL/pending搬移代码；合法 offset 保存列举；普通项目路径key碰撞、冷重建与index混合 | 三个首次失败同名候选不复跑；真实多进程与真实用户 memory 根目录 |
| memory extraction/orchestrator/promotion | parser、decision/fallback/rank/current context、promotion全代码；假模型 ADD + 真实本地写与stale pending批准 | 真实模型、真实用户意图判断、端到端设置 UI |
| task progress/local run | reducer并行时序、RunManager cold queued boundary；15条既有队列/分页/冷recover/progress基线 | 真实 native worker/process crash、完整 Engine 模型执行、真实 approval/input transport |

## 候选（不计已确认）

- `pruneByRecall` 逐条检查后按名称删除，同名稳定 ID 可能删除另一条。首次脚本未到 TTL 调用；仅源码候选，不计确认，遵照要求不调支架重试。
- pending/global 搬移按选中文件或 ID 读取、按名称删除，可能出现同名误删。首次两个样例未选到非首项；仅源码候选，不计确认，遵照要求不调支架重试。

### OM2（候选）· pending 旧快照与项目最新候选不同

- 位置：`packages/core/src/services/global-dream-promotion.ts:146–154`；批准路径 `packages/core/src/session/memory.ts:660–699`。
- 实际观察：同项目依次提议同名 `units`，先 centimeters、后 meters；项目 dream 刷新为 meters，pending 按 `name+originProject` 去重不更新而保留 centimeters，批准后 global dream 也是 centimeters。round2 第二个测试和原始日志为干净 **2 pass、Completed**，确实执行了本地 gate/manager。
- 语义边界：pending 可能有意保存最初待审快照。尚未找到必须同步“最新候选”的产品契约；Desktop 源码只展示 name/description/promotionReason/originProject，未执行 UI。**不能仅凭新旧不同就确认缺陷，不计正式发现或 P3 数量。**
- 查重：本轮未发现同项旧报告；未来如明确了刷新契约，可在已有观察上复核，不需要把当前候选冒充确认。
