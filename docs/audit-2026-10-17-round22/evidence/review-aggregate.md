# 第二十二批独立汇总复核

复核冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。已读 README、findings/candidates/related、validation、source-manifest、worker-integrity、integration-plan、Root QC 与三份方向交叉 review，并对照原始日志、退出收据和作者材料清单。结论：**未发现阻断集成的计数、证据或范围问题。** 本复核只作元数据静态检查，新增产品 import/运行、测试、SDK、模型、网络 API、native、权限实验及 Git 写均为 0；只新增本文件。

分类一致：**1 个 P3 ERROR-R22-01，0 candidate、0 新 related，1 条未分类 terminal frontier。** 正式项的影响限定为额度类 429 原因和建议丢失；实际 helper/轻量异常与 owned 输入测试不是 provider、SDK 429 实例或重试链执行。普通生产来源由静态无条件 429 包装与所存官方错误合同支持；只有中间重试/fallback 最终未恢复并继续传播时才适用最终提示，README、finding、Root QC 与 friendly review 均保留此条件。未据此增加耗时、请求次数或计费影响。banner 只保留算式推导；旧预算分支疑点、历史压缩措辞矛盾和标题旧机制没有重复计为新项。

三份产品 raw/exit 的 SHA、guarded argv、exit 0、各自 `Completed Bun shard` 以及 0 fail/skipped 逐项一致：friendly **12/25**，reactive **8/17**，title **12/34**，总计 **3 clean / 32 pass / 76 expect = 4 existing + 28 focused**。3 个 raw 分别为 1,651、1,124、1,816 字节；它们的 SHA 同时匹配 aggregate validation 和实际 exit receipt。没有把 terminal 的两份 Python collector `.txt`、历史扫描、Git hash 核对、deferred Promise 或循环调用次数算成产品 shard/测试。三份首跑原件已存在，本复核没有重新执行保存脚本或测试。

独立读取冻结 Git blob、刷新 main 的 Git blob 和当前文件字节，**42 个唯一源码/历史/配置 pin** 的 SHA 与 bytes 全部匹配，不代表 42 份产品源码全文或动态覆盖。**40 次作者 source checks 对应 36 条唯一路径**，重复来源没有混成 40 份独立新覆盖。terminal 的两份 Core 类型仍是 hash-only。title/terminal reviewer 新增的 Desktop `session-titles-store.ts` adapter 在 aggregate 中单列为 reviewer 来源，不改变 title 作者的 16-pin 范围或测试数量。

四份 author receipt 独立核对 **65 个 artifact 的 bytes/SHA**：Root 15、budget 18、title 13、terminal 19；worker-integrity 中对应 hash 全部相符。direction reviews 均区分实际叶子、owned callbacks 与静态真实消费者；预算旧测试不重跑，标题 rename/Engine/store 不作为通过项，terminal 不强行抽取或导入。Root QC 的无 Git 写范围已明确限定各 worker/reviewer，未误称主审没有做 Git 元数据及集成工作。

集成计划的 initialPrimary 与 primaryBefore 逐键比较，**只有 head 不同**；statusHex、tracked/staged diff hash 和四个 untracked 文件的 path/bytes/hash 全部保留。独立 `git rev-list --count` 与 `git diff --name-only` 核对 `ab258c3..7e5570210d7e9336cbe9d6a90ed375832e7e3329`，确为 **22 commits / 20 paths**，与计划清单相等、与本批新目录分离；选定 pin 在两端均未变。并行的 CI、浏览器、Windows 安装器及发布材料不纳入本批验证，所存快照不代替 Root 最终 FF 前后状态检查。

写入本 review **之前**，evidence-index 的 85 条非自身记录与当时 85 个非 index 文件集合完全相等，每条 bytes/SHA 均通过。这是明确的检查时点；新增本文件后应由 Root 重建索引，不能将预期的新文件缺项当成原有材料损坏。本复核已静态读取 verify-audit.py，确认它只查文件/Git 元数据、作者收据、Markdown 本地链接与计数，不 import 产品；未在已知待刷新的索引上运行它制造预期失败。Root 完成索引刷新后的最终 verify、暂存集/cached blob、diff check、commit/主 checkout 字节与 dirty 保全仍属于后续集成检查，当前报告没有提前声称它们已完成。

本复核未保存新的外部网页或运行失败方向。正式条目的外部事实使用已存的精简 primary-contract 收据及独立 friendly review；不将其扩展到所有 compatible endpoint。无全仓无 bug、全量 suite、build/typecheck/lint、真实账户/SDK/Engine/终端或修复验收通过结论。全仓审查目标继续。
