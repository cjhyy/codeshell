# CodeShell 第十九批审查

冻结源码：`5f5cf69df8526470700712a4dc2d5ae6bd2da132`。**新增 1 项 P3、0 项候选；另列 2 个旧机制的静态相关上下文。** 四个首次 guarded Bun 分组共 **71 pass / 187 expect / 0 fail / 0 skip**，43 个既有测试加 28 个 focused。仅记录，没有修改产品。

| 分区 | 新确认 / 候选 / related | 实际首跑 | 报告 |
| --- | --- | --- | --- |
| Review prompt | 1 / 0 / 2 | 15 tests / 44 expect | [report](reviewprompt-report.md) |
| Stream timing | 0 / 0 / 0 | 10 / 37 | [report](timing.md) |
| Simple diff | 0 / 0 / 0 | 17 / 57 | [report](simplediff.md) |
| Undo selectors | 0 / 0 / 0 | 29 / 49 | [report](undo-selectors.md) |

`REVIEWPROMPT-R19-01`：TUI `/review` usage 提示 `--dimensions=security,perf,...`，实际 parser 只接受 `performance`。`security,perf` 只选 security，性能维度被静默丢弃；`perf` 单独输入则回退全部维度。实际叶 parser/builder 与 canonical controls 支持该帮助/解析合同矛盾；普通 CLI/UI 传递链仅静态核对，没有运行命令或模型。通过的两个 characterization 测试断言当前错误行为，不表示修复。

围栏和 UTF-16 上限截断分别关联旧 `R2-03`、`DESKTOP-R12-01`，只记录 builder 中的静态上下文，没有新增测试、重复计数或宣称旧修复覆盖此处。其余分区在有限纯函数对照下未建立可登记缺陷，不据零项宣称无 bug。

第一组合 raw 与 exit 均先保存再检查；本批没有产品失败或重跑。导航猜测、source 范围及只读输出截断等 metadata 事项单独保留。旧 recorder、TUI Diff、parser/dependency 等失败方向继续跳过；simple-diff 已知 O(n*m) 方向完全排除。详见 [coverage](coverage.md)、[validation](validation.json)、[findings](findings.json)、[related](related.json)、[evidence index](evidence-index.json)。

全历史查重覆盖本批外 prior docs/bugs（含 archives）**2,050 文件 = 1,161 MD + 889 parsed JSON，260,970 字符串叶 / 363,859 scalar 叶，0 parse errors**。总计数与 capped 上下文分开；这是读取当时的库存，关键词不证明全仓语义完备，最终 main 的并发文档变化也不会回写为旧库存验证。

结束前刷新 origin 并将任务分支快进到并发 main `40141406c1314510a9ed6d6fbd851e1822e6530f`；两条外部提交仅变更 release 文档，已选产品源码仍等于冻结字节。初始与最终合并前 primary 快照分别保存，原有删除及四个未跟踪文件的字节未变。详见 [integration plan](evidence/integration-plan.json)。没有 push、build、typecheck、lint、full suite、E2E、真实模型/账户/网络/native/用户数据或权限类实验。

本批是持续全仓审查的一次证据检查点；全仓目标仍在进行。下一批静态 frontier 辅助任务发生模型容量错误，未产出新验证，保留 [metadata note](evidence/frontier-capacity-skip.md)，未重试该辅助任务。
