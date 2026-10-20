# CodeShell 第二十三批审查

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。本批新增 **1 个 P3、0 候选、1 个旧机制关联**。只记录，未修改产品；全仓目标继续，本批不代表所有内容审查完毕。

| 方向 | 结果 | 证据与限制 |
| --- | --- | --- |
| [Product 配置](product-report.md) | PRODUCT-R23-01：`defineProduct` / `createRunManager` 的公开 cwd 选项在提交默认值链中丢失 | 静态合同和完整配置源流；0 import/constructor/test/真实任务，不推断工具、文件或权限影响 |
| [cron 表达式](cron-report.md) | 0 新问题；旧 TIME1 的相关源码字节仍完全相同 | 7 focused / 19 expect，实际纯叶子与固定 UTC 短引用；旧 malformed/DST/leap/Scheduler 不重跑 |
| [Room 数据投影](room-data-report.md) | 0 新问题；Codex 旧问题和基线只静态去重 | 6 focused / 13 expect，实际 mobile-history + owned reader；Codex、真实 transcript/room/store/CLI 未运行 |
| [广泛选题及 utils 负提案](frontier-selection.md) | 0 新问题；Root 33 个文件 static full/selected 阅读，prep 10 pins 仅重核 hash | Root 0 产品尝试；旧 stdin、queue、params、OM3、JSON/Unicode 等方向未重复恢复 |

PRODUCT-R23-01 合并两个公开工厂的同一缺口：配置指定工作目录与进程启动目录不同，随后 submit 不重复填写 cwd 时，工厂从未消费该默认值，RunManager 只能回落 process.cwd()。显式 per-submit cwd、或进程目录恰好相同的正常控制也只是源码推论，未执行。公开 SDK 的明确选项合同足以支持限定 P3，无需伪造仓内消费者或导入真实执行后端；未宣称已观察外部用户或下游操作。旧 prompt/sections 优先级仅记 PRODUCT-R23-R1 关联，不新增严重级别。登记见 [findings](findings.json)、[candidates](candidates.json)、[related](related.json)。

本批只有两次首次守卫 shard，合计 **13 pass / 32 expect / 0 fail / 0 skipped**，全部 focused，既有测试运行数 0。raw stdout/stderr 与 exit/hash 都先保存后阅读；0 产品重跑、0 fixture 修复或失败替代验证。Cron 普通控制在后来的静态优先补充指令到达前已完成，随后只做静态；它们不代表新机制或 Scheduler 验证。Room 为 4 项普通投影与 2 项 owned deferred/reject 边界，未把人工回调当生产故障。Product 正式问题的证据为静态配置合同，**并非由这 13 项测试发现或动态验证**。逐项命令、计数和限制见 [validation](validation.json)。

全历史去重读取 docs/bugs 的全部 MD 与递归 parsed JSON 标量，含 archive/_archive、排除本批；本批读数 **2,301 文件 = 1,213 MD + 1,088 JSON，335,490 strings / 472,091 scalars，0 parse error**。各方向区分总命中、保存上限及人工选择；关键词/哈希不证明语义穷尽。prep 的较早 335,488/472,088 读数独立保留，不混作同次扫描。[旧 TIME1 状态](evidence/cron-source-status.json) 仅证明源码未变，没有重放旧复现、修复验收或新增缺陷计数。

没有真实模型/付费 API/账号/用户资料/业务网络/外部消息/native/PTY/真实 timer/认证/权限/security/custody/watchdog/身份实验，没有共享依赖/dist 重建、build、typecheck、lint、完整 suite 或 E2E。元数据导航猜测、收据 schema/自链接排序和 cron 读取上界订正分别留档，不算产品失败；所有旧失败方向保持跳过。

分支为 `codex/audit/product-cron-room-parsers-round23-20261017`，复用独占已附 worktree。初始与结束刷新 main 均为冻结点 c1d007ed，origin/main 仍 02d5d9a9，无外部新增提交/路径；初始/集成前主 checkout 快照完全相同，保留原有删除及 4 个未跟踪文件。见 [初始快照](evidence/integration-before.json)、[集成计划](evidence/integration-plan.json)、[source manifest](source-manifest.json)、[source status](addressed-sources.json)、[作者完整性](worker-integrity.json)。源码 pin 含历史/配置及仅 hash 的 prep 文件，不能作为全文件、传递依赖或运行时覆盖数。

独立复核见 [Product review](evidence/review-product.md)、[cron/Room review](evidence/review-cron-room.md)、[选题 review](evidence/review-frontier.md)、[Root QC](evidence/root-qc.md)、[汇总 review](evidence/review-aggregate.md)。[evidence index](evidence-index.json) 索引除自身外的全部文件。最终暂存/cached blob、whitespace、commit/主 checkout 逐字节和 dirty 保全收据保存为本批归属的 `/tmp/codeshell-audit-20261017-round23-stage-verification.json` 与 `/tmp/codeshell-audit-20261017-round23-integration.json`；没有把未来提交 SHA 写入本文件，不 push。
