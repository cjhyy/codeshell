# Arena / Optimization Lab 离线数据补审

源码基线：`0f83bbfdfb8f2c6f31148250bd6544f5325c16e7`；工作分支：`codex/audit/broad-round3-20261017`。只新增本报告及 `evidence/lab-*`，产品源码和 Git 状态均只读。

**本轮确认 3 项，均为 P3，明确限于私有或实验能力。** `CODESHELL.md` 将 Arena 定义为保留私有源码，当前 Host 不加载、发行不发布；两个包的 `package.json` 均为 `private: true`。Optimization Lab 为 Desktop-only 实验能力，`optimization_lab` 默认关闭。本轮没有开启 flag、启动 Host/UI/实验或调用真实模型，不能据此宣称默认 Desktop/TUI/server 流程已受影响。Arena README 的旧集成示例不用于扩大消费者范围。

查重覆盖 `docs/audit-2026-10-16`、`docs/audit-2026-10-17` 的 findings/报告/候选及已有 review/archive 中相关记录。旧 Arena `git_show -- <object-ref>`（N33/A1）与 Lab 冷停止被恢复为 interrupted（N32/O1）不重复计数；未检出本报告三项相同根因的旧确认项。

## LAB-R3-01 / P3 — 人工评分更正后，反思输入仍携带最初评分

- **契约**：评分记录不可变，更正用 `supersedesRecordHash` 追加；`fullyGraded` 以最新记录决定是否允许继续。已经在继续前生效的更正应成为冻结反思反馈，不能在评分门禁和 optimizer 输入之间相互矛盾。见 `grading.ts:185–218,228–239`，`controller.ts:762–764`。
- **触发**：在 baseline 人工打分 checkpoint，先导入某 trial 的 inconclusive 记录，再合法追加 passed 更正，之后 Continue。`controller.ts:853–856` 按追加顺序保留两条 ref，`:763` 冻结的 `baselineGradingHashes` 包含两条记录，`:1244–1254` 未消除被替代记录。
- **预期 / 实际**：预期反思输入使用 passed 及更正后的 evidence。实际 `strategy.ts:41` 用 `feedback.find` 取同 trial 的第一条记录，发送 `semanticPassed: null`、原先 `Initial review unfinished`；同时 `fullyGraded` 已返回 true。仅传入更正记录的对照返回 true。
- **主要位置**：`packages/optimization-lab/src/strategy.ts:41`。可达链路：`packages/optimization-lab/src/controller.ts:526,763,856,1244`；更正契约：`packages/optimization-lab/src/grading.ts:195,216,237`。
- **影响**：仅在显式启用 Lab 并进行 baseline 更正时，单次反思会基于过期语义反馈生成候选；更正后的评价方向或证据无法进入该输入。未证明真实模型会生成何种候选，也未证明最终报告一定错误。
- **证据边界**：调用真实 `createGradingTemplate` / `importGrading` / `fullyGraded` / `reflectionInput`，Controller 的 ref 追加与冻结消费者链路为静态核验；未执行 `Controller.start`、HTTP、模型或完整持久实验。

## ARENA-R3-01 / P3 — 缺失或无效评审 verdict 被改成 agree，进而 verified

- **契约**：claim 状态机明确要求“至少一条显式 agree”才能 verified；没有评审或只有 refine 不能自动验证。见 `transitions.ts:46–51,58–78`。`PeerVerdict` 允许值为 agree/refine/disagree/needs_evidence。
- **触发**：私有 Arena 的模型评审 JSON 能解析并含合法 claimId，但省略 `verdict`，或输出例如 `"uncertain"` 的无效枚举；无其他反对项、无 pending check。
- **预期 / 实际**：预期保留未验证状态，或将无效评审视为缺少证据。实际 `validateVerdict` 对任何非四个允许值返回 `"agree"`；真实 `parseChallenges` 的结果经 `applyReviewResult` 后，将 under_review claim 改成 verified。缺失值及 uncertain 均复现；合法 needs_evidence 对照仍为 contested。V1 `parseReviews` 复用同一默认值。
- **主要位置**：`packages/arena/src/strategies/utils.ts:359–361`；V2 消费者 `:562–566`，V1 消费者 `:349–353`，状态消费者 `packages/arena/src/transitions.ts:71–74`。`phases/cross-review.ts` 将这些 challenge 加入 ledger 后执行 `applyReviewResult`。
- **影响**：仅在主动调用保留私有 Arena 源码的评审链路时，格式不完整的模型结果会被误记为同伴验证，影响 claim-aware 共识中的 verified 分类。不是默认产品已发生的误判。
- **证据边界**：直接执行真实 parser 与状态纯函数；原始输入、解析 verdict 和状态均写入 raw 观察输出。未运行评审模型、完整 Arena 会话或最终共识模型。

## ARENA-R3-02 / P3 — 裁决提前返回，未将剩余 claim 收尾为 unresolved

- **契约**：裁决阶段在结束时将所有剩余 proposed / under_review claim 标为 unresolved（`adjudication.ts:129–133`）；`transitions.ts` 的状态图也说明这项收尾用于避免 claim 从共识摘要消失。最终 `ClaimStatusSummary` 只接受 verified/contested/unresolved/rejected 四类。
- **触发**：私有 Arena 完成评审后，ledger 只有 proposed / under_review，没有 contested / verified。例如所有有效评审都是 refine，或选中 claim 未得到可用评审；未选中的 claim 也可能仍为 proposed。
- **预期 / 实际**：预期无需模型也将这些 claim 收尾为 unresolved，供共识明确呈现未决证据。实际 `adjudication.ts:55–57` 直接返回 `[]`，跳过后面的收尾。实测包含 1 条 proposed 与 1 条 under_review 的真实 ledger，调用实际 `runAdjudication` 后仍为原状态，unresolved 数为 0。
- **主要位置**：`packages/arena/src/phases/adjudication.ts:55–57`；被绕过的收尾 `:129–133`；静态下游 `packages/arena/src/arena.ts:45–52,389–402`。
- **影响**：这些 claim 不进入 claim-status summary 的四个桶，无法通过该摘要向共识说明其未决状态。原始 `reports` 和最终 `claims` 仍保留数据，因此不声称整个会话物理丢失所有 findings，也未证明共识模型最终一定忽略它们。范围仅为保留私有 Arena。
- **证据边界**：实际 ledger 和 `runAdjudication` 动态复现；此早退位于创建 LLM client 前，测试传入不可用 provider 仍正常返回，未触发模型。下游四桶遗漏由实际私有函数源码核验，测试采用相同四状态过滤辅助观察，没有把复制过滤冒称为调用了私有 `summarizeClaims`。

## 分轮执行与精确收据

| 轮次 | 内容 | 结果 |
| --- | --- | --- |
| 静态首轮 | 评分、更正、反思、claim parser/状态机、裁决及下游摘要；查重旧 audit/review | 锁定以上 3 项，已知两项排除 |
| 动态第一轮 | `lab-offline-round1.test.ts`：3 个业务测试 + 1 个观察输出测试 | **1 file / 4 pass / 0 fail / 0 skip / 19 expect；Completed；首次执行 exit 0** |
| 静态补轮 | dataset/plan/canonical JSON、报告配对/成本/分母、candidate 选择、ledger/store 普通数据链路、iterate 解析与收敛、plan/tool 选择、会话输出 | 未增加确认项；候选与边界如下 |
| 动态第二轮 | reviewer cap 的真实 verification 调用 + 内存 fakeLLM fixture | **1 file / 0 pass / 1 fail；无 Completed；首次执行 exit 1**。失败发生在 fakeLLM 前，无业务 expect 执行，保留并跳过 |

两次执行各自的第一次 stdout/stderr 均直接重定向到独立 raw 文件。第一轮未重跑；第二轮未修 fixture、未替换解析/注册办法、未换方式重跑。完成覆盖仅按第一轮 4 项计；失败组不加进成功数，也不能把 5 个尝试测试写成 5 个完整成功测试。

- [第一轮测试](evidence/lab-offline-round1.test.ts)、[首次 raw 输出](evidence/lab-offline-round1.raw.log)、[结构化收据](evidence/lab-offline-round1-receipt.json)。测试 SHA-256 `76759c22bce482b36a15e157939c052d363ef770dfc8b1d76ae096914a773415`；raw SHA-256 `9f02a61eed49105dfcd150e11b99ea8492eb9473d89e08c0e3649d58653ecd38`。
- [第二轮首次 fixture](evidence/lab-offline-round2.test.ts)、[首次失败 raw 输出](evidence/lab-offline-round2.raw.log)、[失败收据](evidence/lab-offline-round2-receipt.json)。无真实 provider 请求；fake client 的方法也尚未执行。
- [源码 manifest](evidence/lab-source-manifest.json) 留存 46 个契约、实现与测试文件的字节哈希；部分为定向行段阅读，哈希收录不代表 46 文件所有分支全覆盖。

## 候选、跳过与覆盖边界（不计确认）

1. **Arena reviewer cap 候选**：`types.ts:331–348` 将 `maxReviewersPerClaim` 定义为防成本膨胀的全局 cap，默认 2；`cross-review.ts:173–182` 遍历全部非 owner，仓内该字段仅在类型和默认值中出现。第二轮拟用四名参与者验证 3 次内存 fakeLLM 调用，但首次报 `Unknown LLM provider: audit-arena-reviewer-cap. Available:`，stack 指向主 checkout 的 `packages/core/dist/llm/client-factory.js`。此为 provider registry/依赖解析 fixture 失败，未建立真实业务结果；保留源码候选，不记第四项。
2. **Arena planner fallback 候选**：正常分支 `planner.ts:113–114` 应由显式 mode 覆盖；异常分支进入 `buildFallbackPlan(topic, flags)`，若 topic 匹配 roadmap 等分支，`:196–211` 直接返回 planning 而忽略 flags.mode。未执行假 provider 异常或真实模型，保持 source-only 候选。
3. **Iterate 解析稳健性候选**：`iterate/parse.ts` 对 critique severity/category 仅断言类型、对 revise meta 直接 `JSON.parse`，形状错误可能影响后续消费。未建立独立完整反例；不扩展为新增确认项。`diffRatio` 明示采用廉价 trigram 近似，短文本/重复字符的近似误差不计普通精确 diff 缺陷。
4. **报告与存储已读范围**：核验报告重算 hard assertions、更正头、paired repeats、analysis-only 分母、成本可比条件、排序与 hash，及 state/ref 追加/读取、冻结 manifest 的普通数据流程。本轮没有执行完整实验、真实付费模型、worker 崩溃/锁压力、磁盘故障、真实并发、采纳/授权/权限/认证/安全方向；不声称已穷尽私有包全部功能。

最终收束：**3 个新增确认 P3；1 个完整成功 shard；1 个首次 fixture 失败 shard；0 次重跑；0 个产品改动；0 次真实模型、网络、产品子进程或 Host/feature 启动。** 第二轮失败和静态候选不改变确认项或成功覆盖数字。
