# CodeShell 第二十一批审查

冻结点 `615e4e4dd3a61b1ad132ab4f3683985a0d582386`。本批 **0 新确认、0 新候选、1 处旧 source concern 关联**；四组首次 guarded shards 共 **56 pass /193 expect /0 fail /0 skip**，8 existing+48 focused。只记录，没有产品修改，不据零项宣称这些模块或全仓无 bug。

| 分区 | 新确认 /候选 /related | 首次 tests /expect | 报告 |
| --- | --- | --- | --- |
| NDJSON reader | 0 /0 /0 | 15 /30 | [ndjson](ndjson.md) |
| JSON output | 0 /0 /0 | 16 /52 | [JSON](json-output.md) |
| Tool output budget | 0 /0 /1 | 18 /94 | [budget](tool-budget.md) |
| 普通 prefix mapping | 0 /0 /0 | 7 /17 | [prefix](prefix-mapping.md) |

`BUDGET-R21-R1` 关联旧预算 floor source concern：在真实 backstop 的正预算600chars/200heuristic tokens下，手工302个短 text slots 清空正文后仍产生602字符分隔符，实际 helper 判超限；301 slots 对照正好600。普通工具产生302 slots、触发实际 aggregate gate 的证据尚缺，未运行 Manager/compaction/MCP/model，所以仅记旧 concern 的具体边界，不新增严重级别、确认或候选。通过的 characterization 断言当前现象，不是修复。

NDJSON 只使用 owned streams，未找到生产 CLI consumer，原2个 timer tests 只静态阅读；JSON 只运行真实 JSON classes/factory 与 chalk，未使用的 Coreinternal/truncate 精确 stub 零调用，stdout spy 在子分片中恢复；旧 mixed Text tests 未运行。Prefix 只实际 normalize/list 普通有效标签，旧5个 baseline、validator attacks/branch ownership/native 均不重跑。Budget 的8existing包含已有固定上限/Unicode控制，未开启压力或旧失败方向。

所有 first combined raw与exit都先保存再检查，0 Bun失败、修复、重试或替代验证。四个scope交叉复核与独立聚合复核保留，导航猜测、显示截断、范围/符号链接 metadata 修订有说明。详见 [coverage](coverage.md)、[validation](validation.json)、[分类](findings.json)、[关联](related.json)、[源码清单](source-manifest.json)、[证据索引](evidence-index.json)。

全历史索引覆盖 prior docs/bugs（含archives、排本批）**2,169文件=1,189MD+980JSON，288,528 string leaves /404,370 scalar leaves，0parse errors**。匹配总数和 capped contexts 分开；宽泛ID/extension模式可有无关匹配，关键词不证明全历史语义穷尽。旧A12、reader leak、Git parser、CTX/JSONrepair/magic200等排除或 source-only背景未恢复测试，也不宣称旧修复已验证。

结束前已刷新origin；合并前main仍是冻结点，0外部新增提交。初始/premerge快照的原有删除、status、tracked/staged diff和4个untracked bytes一致；仅允许本批docs disjoint fast-forward，见 [integration plan](evidence/integration-plan.json)。没有push、共享deps/dist重建、build/typecheck/lint/full suite/E2E或全仓完成声明；保留工作树继续审查。
