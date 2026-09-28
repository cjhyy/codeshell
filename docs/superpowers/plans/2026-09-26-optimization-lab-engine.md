# 优化实验室执行计划 B：有预算约束的文本实验引擎

状态：待实施。计划 A 提供了离线数据契约与默认关闭的 Desktop 模块；本文不代表引擎、预算授权或真实模型实验已经完成。

设计依据：[个人先用方案](../../todo/optimization-lab-mvp.md)。前置交付：[计划 A](2026-09-26-optimization-lab-foundation.md)。范围是方案 P1a 的离线可验证引擎；Desktop 授权页面、worker 保活与真实付费验收留给计划 C。只有用户对具体实验计划授权后才允许真实模型调用。

## 已有边界与实施决定

- 能力包只导入 `@cjhyy/code-shell-core/extension`，不创建 Engine、不接入普通 Skill/Memory/dream，不修改 TUI/server 组装根。
- 复用 `DatasetManifest`、`EvalCase`、`validateDataset`、`freezeDataset`、`canonicalJson`、`sha256Hex`、`labRoot(cwd)` 与现有 verdict policy。新状态写入 `labRoot(cwd)/experiments/<id>/`。读取冻结清单必须验证其内容、case hashes、summary 和目录 hash，不能仅比较自报字段。
- A 的 runnable 样本将资料内联到 `input`，`fixtureRefs` 必须为空。B 不恢复可变路径读取；需要资料附件时另行设计内容冻结。analysis_only 样本保留在计划分母中，不发模型请求、不计通过。
- A 的 `readSkillSnapshot` 提供全文、frontmatter、body、revision、revisionKind、extraFiles。B 只接受 `revisionKind === "bundle" && extraFiles.length === 0`，完整快照复制到实验目录；后续调用不重新扫描正文。
- `resolveLLMConfigForTag` **会回退连接**。B 必须先按选中 connection id 过滤 settings 中的 modelConnections，再调用 resolver；无此连接/凭据/catalog 模板时直接拒绝。不得把默认连接的可用性当作所选连接可用。模型与无密钥配置指纹每次调用前重核，发生改变需新计划和授权。
- `ClientDefaults.fetch` 是真实 HTTP 计量入口；使用非流式 `createMessage`、`retryMaxAttempts: 1`。客户端兼容性重试和 SDK 重试也必须逐 HTTP 请求入账；不得只数 runner 次数。不支持的 provider/传输适配器在授权前拒绝。
- `acquireLockOnPath` 是同步短锁，只在不含 await 的临界区内持有。实验的异步单写者身份由持久租约承担，绝不能把文件锁横跨网络请求。执行方的状态/账本变更在同一个实验级锁内重读并核验 owner 与 generation（外部控制意图见 B2）；不要在持锁时嵌套 `mutateJsonFile` 锁。
- 私有包仍默认关闭。查询使用 `optimization_lab_*` 命名；不会注册供模型自行授权或采纳的工具。
- 本切片强制 `judgeMode: "human"`，拒绝启用模型 judge。模型 judge 的连接、模板、数据外发与预算约束必须在后续独立任务实现并测试后才能开放；B/C 的最小闭环采用确定性断言与人工语义评分。

## 文件与依赖顺序

| 文件（相对 packages/optimization-lab/src）              | 职责                                       |
| ------------------------------------------------------- | ------------------------------------------ |
| `contracts/experiment.ts`、`contracts/grant.ts`         | 计划、授权、阶段与哈希契约                 |
| `store.ts`、`lease.ts`                                  | 受限路径、不可变 artifacts、原子状态、租约 |
| `ledger.ts`                                             | 请求/Token/费用估算/执行时间事件账本       |
| `providers/connection.ts`、`providers/metered-fetch.ts` | 严格连接解析、请求准入与响应计量           |
| `runner.ts`、`assertions.ts`                            | 无工具文本执行、确定性硬断言               |
| `strategy.ts`、`candidate.ts`                           | reflect_once_v1 与候选静态校验             |
| `grading.ts`                                            | 盲评模板、不可变评分记录与检查点           |
| `controller.ts`                                         | 唯一调度者、停止、恢复、阶段切换           |
| `report.ts`、`overfit-hints.ts`                         | 不可变 JSON/Markdown 报告与过拟合提示      |
| `queries.ts`、`module.ts`                               | 面向可信宿主的生命周期 queries             |
| `*.test.ts`、`test-fixtures/`                           | 假 fetch、假时钟、子进程租约/崩溃实验      |

每个任务先写有行为意义的失败测试，再实现并提交。使用 Bun；只格式化改过的文件。构建与消费 dist 的测试顺序运行，避免 clean/build 与测试相互干扰。

## Task B0：确认基线与冻结契约

- [ ] fetch origin，在最新 origin/main 建 `codex/optimization-lab/engine` 独立 worktree；核对 A 实际已合入。
- [ ] 运行 `bun install --frozen-lockfile`、`bun run typecheck`，完成后运行 `bun test packages/optimization-lab tests/optimization-lab-composition.test.ts`。记录基线与任何既有失败，不能用跳过测试掩盖回归。
- [ ] 读取 A 实际源码与当前 Core provider API；记录 runner、策略、估算器、评分模板版本常量。连接适配首期明确列出支持的 providerKind，其他种类预检失败。

## Task B1：ExperimentPlan 与 BudgetGrant

文件：`contracts/experiment.ts`、`contracts/grant.ts` 及测试。

- [ ] RED：缺失/额外字段、过期、非有限数字、非正限额、并发非 1、候选超 2、hash 不符均拒绝；相同内容重排键保持相同 hash。
- [ ] 定义 schemaVersion=1 的计划：projectKey、datasetHash、Skill 名称/来源 revision/全文与正文 hash、目标及优化连接的无密钥指纹、runnerVersion=`text_fragment_v1`、策略=`reflect_once_v1`、verdict policy 版本、评分器 hash、主目标、排序规则、外发范围、正文/上下文上限、最大候选数与固定 repeat 数。
- [ ] 冻结验收规则：关键硬断言 IDs、固定回归案例 IDs、质量不退步定义、质量优先所需修复数或降本优先阈值、成本可比条件与最低证据条件。结果生成后不得调整门槛挑选结论。
- [ ] 每个 trial/操作固定 maxRequests、maxOutputTokens、timeoutMs；冻结价格来源与日期（缺失用 null）、估算器版本、`outputCapCoversReasoning: true | false | "unknown"`。只有 true 且有保守输入界限才生成 Token 上界；其余声明 Token/费用无上界。
- [ ] 授权包含 planHash、revision、confirmedAt、expiresAt、startOperationId、maxRequests、maxExecutionMs、Token/估算费用停止阈值与撤销信息。首次开始原子落 startedAt；重复 start 返回同一实验状态。
- [ ] planHash 排除自身、凭据和可变时间；授权 revision 是追加记录。续期/加额度继承全部消费和 unknown，不能创建空账本。plan/scorer/data/model 改变创建新计划而非覆盖旧计划。
- [ ] GREEN：本地预检、计划生成、授权记录均为零 HTTP 调用。提交契约。

## Task B2：实验存储与租约

文件：`store.ts`、`lease.ts` 及子进程测试。

- [ ] RED：两个进程同时 start/resume 只有一个 owner；存活租约不可接管；过期租约可接管但旧 generation 的迟到写入被拒绝。
- [ ] 实验 ID 为内部生成标识，外来 ID 拒绝路径穿越。state、lease 与 ledger 使用同一实验级短锁；同步重读/校验/写入/释放，不持锁 await。
- [ ] lease 保存 owner、workerGeneration、heartbeatAt、过期规则；活跃阶段定时续租。等待评分时先写检查点再释放租约；continue 重新竞争租约。等待期间 expiresAt 到期只标记授权过期，不自动迁移阶段。
- [ ] 执行方的模型调用、trial/checkpoint/ledger 写入需要 owner/generation fencing；非 owner 宿主可在同一短锁中写 stop/revoke 控制意图和授权 revision，并核对 expected revision。活跃 owner 在每次准入及短周期轮询时读取控制 revision，撤销立即触发 abort；waiting 状态也允许本地评分/授权修订，不要求虚构执行租约。
- [ ] artifacts 用内容哈希命名且存在时验证一致，不覆写；临时文件唯一、原子 rename。文件大小有限，符号链接/非普通文件拒绝。状态迁移需要 expected revision。
- [ ] 模拟写临时文件后崩溃、锁竞争、旧 owner 迟到结算，验证未知状态保持保守。提交存储与租约。

## Task B3：账本、恢复与最终阶段预留

文件：`ledger.ts` 及测试。

- [ ] RED：未授权/过期/撤销/hash 错配/资源不足，预留失败且请求数为零；重复结算不重复计费；重启不丢 unknown。
- [ ] `ledger.jsonl` 事件含 schemaVersion、严格递增 sequence、eventId、attemptId/operationId、owner/generation、role、grantRevision、时间与前序校验信息。事件先持久落盘再允许外部副作用。
- [ ] 支持 reserve、dispatch、settle、unknown；请求名额、input/output/cache/reasoning usage 分开记录，不能重复相加。超预估时停止新调用并标记估算失效。
- [ ] operation 预留整个 timeout 窗口；多次 HTTP 不重置 operation 截止时间。结算实际执行时长，崩溃未知整窗计已用。人工等待不消耗时间，expiresAt 仍流逝。
- [ ] 崩溃后的 reserved/dispatched 未结算项转换为 unknown。检测截断尾行，只截去未完成尾行并保存修复证据；中间损坏/sequence 缺口拒绝恢复，不能按空账本继续。
- [ ] 原版+候选保留集的请求/Token/费用估算/评分/执行时间预留独立占用，搜索不可动用。候选变长重算可行性，不足停止而非缩减保留集分母。
- [ ] property/table-driven tests 覆盖角色混合、重复事件、未知费用、续期、候选数减少、全部最终额度已锁定。提交账本。

## Task B4：严格连接与计量 fetch

文件：`providers/connection.ts`、`providers/metered-fetch.ts` 及测试。

- [ ] RED：选中连接删除/不可解析而默认连接仍可用时，上游调用为零；凭据不出现在 plan/ledger/errors/report；配置指纹变更拒绝旧授权。
- [ ] 在过滤后的 settings 上复用 resolver，保持 Core 默认行为不变。只把运行需要的凭据交给客户端，不持久化请求 authorization/header/query secret；保存适合复核的无密钥摘要。
- [ ] 指纹采用显式白名单投影：connection/catalog/provider/model、规范化且无 userinfo/query secret 的 endpoint 身份、有效输出/推理参数与 ClientDefaults.temperature。httpHeaders、authCommand、任意 extraBody 不得通过 spread 混入清单；不支持的参数预检拒绝，受支持的 extraBody 逐字段归一化。不能只用 Core prompt-cache identity（它有意忽略部分请求参数）。测试 header/query 密钥不落盘、temperature/有效 extraBody/endpoint 改变使旧计划失效；凭据更新的非秘密 revision 独立记录。
- [ ] 每次 fetch 获取真实序列化 request，按批准的 provider 适配器检查 endpoint、model、输入/输出约束；先预留再发送前复核租约、授权与绝对截止时间。
- [ ] 请求截止时间为 min(operationDeadlineAt, expiresAt)。中止信号合并用户停止/撤销/失租/到期；固定收尾窗口不允许新请求。
- [ ] 非流式响应读取实际 model 与 usage。字段缺失明确 unavailable/unknown，不以请求模型代填；缺 usage、断网、取消、响应体损坏保留 unknown 额度。推理与 cache 含义按 adapter 记录。
- [ ] 使用假 fetch 和真实 `createLLMClient` 测试 SDK/兼容重试、429/5xx、消费超估计、超时、丢失响应；每个网络请求有不同 attemptId，预留失败就无法接触 fake upstream。
- [ ] 未支持/无法强制单次输出限制的 adapter 在预检拒绝。提交计量入口。

## Task B5：文本 runner 与断言

文件：`runner.ts`、`assertions.ts` 及测试。

- [ ] RED：实际模型 payload 不含 expected、rubric、其他样本、保留集清单和凭据；每个 trial 使用全新 messages，不延续会话状态。
- [ ] 固定拼接冻结 Skill 正文、本题 input、获准内联资料；明确 runnerMode=text_fragment，不宣称实际 Skill 工具加载或完整 Agent 评测。无 Shell、MCP、浏览器、hooks、Memory、dream 和真实资料写入。
- [ ] trial 记录计划/原版或候选/样本 hash、repeat、request IDs、request/response model、状态、输出与执行时间；fallback/模型意外改变使该配对无效。
- [ ] contains、not_contains、json_field_equals 确定性求值；JSON 路径只查 own properties，拒绝危险/不支持路径；解析失败明确 hard failure。语义状态独立，未判分为 not_evaluated。
- [ ] 对硬失败+高语义分、全部 skipped、缺证据分别测试，均不能通过。提交 runner。

## Task B6：一次反思、候选校验与开发集提示

文件：`strategy.ts`、`candidate.ts`、`overfit-hints.ts` 及测试。

- [ ] RED：发送给优化器的材料只有原版、任务目标、开发输入和已冻结评分反馈；任何保留数据/路径不进入 payload。
- [ ] `reflect_once_v1` 只调用一次优化操作，结构化返回 1–2 个完整正文、改动解释、开发来源 IDs。禁止任意 patch、工具调用、额外文件和对评分器的修改。
- [ ] 候选保留原始 frontmatter（按原文本块保持），校验正文 UTF-8 字节、上下文上限、引用范围与 extraFiles=[]；拒绝解析失败和不合法候选，保存失败证据且不无限重试。
- [ ] 以 body hash 保存 `candidates/<hash>/body.md` 与 manifest，记录 parent hash、strategyVersion 与来源。候选内容不得存到 scanner 根或使用 SKILL.md 文件名。
- [ ] 用固定分词/ngram 生成新添实体/数字/文件名/长片段提示；相同输入结果相同，不更改评分或排序。
- [ ] 注入恶意候选、超长正文、元数据权限变更、开发题目硬编码；验证正常 Skill、Memory、dream 文件字节不变。提交策略。

## Task B7：评分模板、回填与冻结反馈

文件：`grading.ts` 及测试。

- [ ] RED：缺必要基线分数不能 proposing；缺必要筛选分数不能选择候选/开启 holdout。任何模板都不含未执行保留题。
- [ ] 控制器生成随机不透明 gradingItemId 和随机顺序；私有映射绑定 experiment/trial/candidate/rubric hashes。公开模板仅当前已完成题目的输入、输出、冻结 rubric 和回填字段，不含这些 hash 或执行次序。
- [ ] 导入拒绝未知 item、规则变更、重复冲突、错配、非法分数与缺必要证据；完全相同记录幂等。审核者、时间、证据和记录 hash 保存为不可变 artifacts。
- [ ] 各阶段使用的评分 hash 固定到 checkpoint；后来更正产生新记录，不能静默改已使用反馈/选择结果。
- [ ] 导入/导出不继续实验，不改 plan/scorer hash、不调用 fetch；过期后仍可本地判分。最终回填只生成新报告，不重新运行模型。
- [ ] 验证输出内容仍可能透露身份，报告保留此盲评限制。提交评分流程。

## Task B8：控制器与恢复状态机

文件：`controller.ts`、`queries.ts`、`module.ts` 及测试。

- [ ] 先写纯状态转换表的 RED：draft→ready→authorized→baselining→[awaiting_baseline_grading]→proposing→screening→[awaiting_screening_grading]→final_evaluating→report_ready。
- [ ] 实现唯一调度循环；所有 HTTP 通过 B4。awaiting 阶段无在途请求且无后台消费；continue 是独立显式操作，重查评分、租约、授权、资源与剩余绝对时间。
- [ ] 排序规则冻结：硬约束优先、已验证任务数、可比较成本；评分缺失不以成本破平局，无法区分不强选。冻结候选 hash 后才向执行器开放保留题。
- [ ] 最终配对按预定交错顺序/固定重复次数运行原版和候选；保留结果不得回流本轮策略。跨授权 revision 完成的保留集在报告标记。
- [ ] cancelled/budget_exhausted/interrupted/failed 写部分报告。仅 budget_exhausted（新授权）及 interrupted（明确确认）可恢复原 checkpoint，cancelled/failed 为终态；未知 attempt 不自动重放。
- [ ] 每完成 artifact/ledger 事件再推进 checkpoint。阶段边界逐点模拟崩溃重启，确认只发尚未发起步骤。
- [ ] queries 提供 prepare/get/status/start/stop/continue/revoke/export_grading/import_grading/report；严格参数校验和 revision/idempotency，授权写入仅留可信宿主入口，C 负责用户确认来源。启动 query 返回后可由 state 轮询，模块没有自造通知或 lifetime 框架。
- [ ] 关闭页面不取消，worker退出停止；新worker读取时显示interrupted，不自动续跑。提交控制器。

## Task B9：不可变报告

文件：`report.ts` 及测试。

- [ ] JSON 与 Markdown 从同一模型生成，按改动→效果→分母→成本→限制排序，报告以内容 hash 存储且不覆写。
- [ ] 给出正文 diff、解释和来源、过拟合提示；逐例原版/候选结果及改善/退步/不变/未知计数，故障与回归集分别汇总。开发收益不能当保留验证收益。
- [ ] 分母包含所有计划样本、analysis_only、未执行、失败、skipped/unknown；重复次数不冒充独立来源组。保留组少于 A 的探索门槛只能探索；单次配对标单次观测。
- [ ] 分开模型试跑消耗和生成/判分/重试投入、reported/reserved/unknown、缓存/推理/输出、实际执行时长/收尾时长、已回报费用/估算/未知费用。
- [ ] 冷热缓存不可比时不判成本收益；未知不能视作满足限额。报告结论 independent 为 improved/no_improvement/regressed/inconclusive，待人工分数保持未验证。
- [ ] 部分报告不得冒充最终验收，晚判分不抹去当时有效的完成证据，也不把未运行题变为已完成。声明 text_fragment、模型别名和环境/样本局限，不展示普通任务已采用。
- [ ] 保存前验证报告引用的全部 immutable hashes；测试快照只用于内容结构，核心结论用行为断言。提交报告。
- [ ] 判定函数只使用计划冻结规则和 trial/grading 快照；案例/引用按 code-unit 顺序稳定排序，生成时间等非内容元数据不参与内容 hash。相同输入重复生成 JSON/Markdown 内容与 report hash 相同，不因时钟/locale 改变；补评分只生成新版本。

## Task B10：离线端到端、交付与计划 C

- [ ] 假 fetch 端到端：至少 6 个有独立来源的样本，原版开发→人工等待→一次候选→筛选等待→配对保留→待评分报告→本地回填新报告；请求、模型 payload、账本事件、分母逐一核对。
- [ ] 并发/故障端到端：两个真实 worker争抢，记录一个上游；逐阶段杀死owner、未知usage、截断尾行、过期、撤销、停止、预算耗尽/续期恢复，证明不重放已发请求且消费不归零。
- [ ] 运行 `bun run typecheck`，完成后 `bun test packages tests`，再运行版本/包边界/变更文件 lint 与 Desktop predist。已知环境或隔离问题需复现定位，不能写成全绿。
- [ ] 方案 §14 的每条 [P1a] 建验收映射：数据泄露→B5/B6；授权/时间/unknown/最终预留/所有HTTP→B1/B3/B4；并发/恢复/生命周期→B2/B8；硬软评分/模板/回填→B5/B7；成本/过拟合/分母→B6/B9；开关→A与C；最坏上界提示→B1与C。
- [ ] 在测试过的任务分支提交，刷新 origin/main 后按 CODESHELL.md 集成；更新 TODO/方案状态，仅声明离线引擎完成。
- [ ] 以实际 queries 写计划 C：Desktop 按需启动及保活、轮询、可信授权确认、最坏情况提示、评分文件导入导出与报告打开。最后由用户确认一份具体的真实模型实验计划和限额，再运行真实验收；本文不提供消费授权。
