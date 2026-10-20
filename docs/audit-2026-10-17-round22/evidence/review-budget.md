# budget 独立交叉复核

复核冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86` 的 [budget.md](../budget.md) 与 budget-* 证据。结论：**未发现需修改的计数、证据或范围问题；保留 0 新正式、0 新候选、0 新关联。** 本复核新增产品运行、模块 import、测试、模型/网络/native/Git 写均为 0；唯一新增文件为本记录。

- [首跑 raw](budget-first.raw.log) 完整 1,124 字节，SHA-256 `98864a76576bdc9ccac2e45e6e0ea93d8f5fe5d3bd4d18d59c05ad432620baec`，同时符合 exit 与 validation。8 条 pass 及结尾明确的 `8 pass / 0 fail / 17 expect`、`Completed Bun shard: 8 tests, 0 skipped; 0 failures` 支持一条成功 guarded shard；argv 指向既有 threshold 测试和 focused fixture。既有 4 个 case/6 次 expect，focused 4 个 case/11 次 expect，合为 **8/17**。333 累加序列是一个测试，未按 15 次循环或实际函数调用计数。
- 完整静态读取真实 reactive-threshold 22 行、既有测试 28 行、focused fixture 与 token-budget 60 行。focused 直接绝对路径 import 零运行时依赖的真实 threshold 叶子，无 mock、消费者镜像或 Engine 导入。四项依次覆盖精确正边界、多桶跳跃、非整除单调序列和独立计数；没有把多桶跳跃仅返回当前桶认定为产品缺陷。
- 对 [source manifest](budget-source-manifest.json) 的 **5 个 source pin** 分别读取冻结 Git blob 并核对当前字节，全部与声明的 SHA/bytes 相符。TurnLoop 和 ModelFacade 的 coverage 明确为 selected，未扩大成全文或动态覆盖。复核了 TurnLoop 911 的 tracker 创建、1889–1926 的预算分支、2107 的方法边界、2118–2146 的累计/探针/warning 接线及 ModelFacade 270–271 的累计 token 合同。只警告、不流中执行 compact 的描述与实际源码相符，onStream 条件及真实 callback 未运行的边界也已披露。
- [round9 usage:18](../../audit-2026-10-17-round9/usage.md#L18) 已写明有限/无限预算、90% nudge→stop 两个纯函数控制和 diminishing 难达的静态观察。本批预算 helper 只读，无旧控制重跑或新增问题计数；首跑 argv/fixture/raw 也只包含 threshold 方向。没有通过修改 tracker 或强行执行 Engine 来扩张证据。
- 实际对照 deep-dive v2:218、旧版 deep-dive:88、core-complete-review:386 与七月状态机:211。前两者有“流中紧急压缩”措辞，后两者已记 warning 边界。作者将其留作历史文档措辞矛盾，未升级成新的运行时故障、候选或严重级别，处理合理。
- [author receipt](budget-artifact-receipt.json) 所列 **18 个 artifact** 的 SHA 和字节长度全部匹配。报告内 **12 个本地 Markdown 链接** 均存在，四个行锚点均在文件范围内且对应相关文字。findings/candidates/related 三个文件均为空数组。递归历史计数与本人静态方向同批独立扫描一致：2,232 文件、309,994 string leaves / 436,035 scalar leaves、0 JSON parse errors；不据此宣称语义穷尽。

[首跑保存脚本](budget-run-first.py) 在执行前禁止覆盖已有 raw/exit，先用同一 raw 文件接收 combined stdout/stderr，再写 exit/hash；没有本次复核重跑。保存顺序的代码与作者记录一致；这不是对未保存的外部行为作额外保证。第一次将多份材料合并显示的工具输出被截断，本复核没有将截断部分视作已读：随后分别读取完整短文件和有界源码/历史片段，并按实际 JSON schema 核对全部 source/artifact hash，未运行产品或修改作者材料。
