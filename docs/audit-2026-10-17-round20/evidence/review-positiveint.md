# 第20批 positiveint 独立只读复核

结论：本分区可按 **0 formal / 0 candidate / 0 related，13 pass / 36 expect** 收录。没有需要作者更改的计数、合同、范围或收据问题。本次复核没有运行新测试、产品 import、CLI、消费者或模型，没有产品修改或 Git 写操作；`git show` 仅用于只读核对冻结 blob。

完整读取 `positiveint.md`、focused fixture、现有 29 行测试、24 行 production leaf、validation / preflight / exit / source-manifest / artifact-receipt / dedup-decisions、raw 以及 round15 `cli.md`。静态复核 `main.ts:1–155`、`commands/runs.ts:15,90–120,265–290`；没有读取范围之外的消费者来支持全模块结论。

- 实际 leaf 的唯一 runtime import 是 Commander `InvalidArgumentError`；focused fixture 绝对导入真实 leaf，没有 mock。原测试同样导入 leaf。错误类实例/名称、label、原始输入 JSON 转义确由测试断言；这只能支持该错误类在 leaf 的使用，报告正确排除了 `program.parse`、CLI 格式化/exit 行为和全 Commander 集成。
- 普通静态接线与报告一致：`main.ts:71/101/131` 使用 wrapper，run/session action 传递解析后数值；`runs.ts:101/276` 使用 wrapper，事件路径在 286–287 行读取 limit 并 slice。没有执行对应 store、wait、模型或 CLI action。
- focused 8 项 / 30 断言来自纯字符串输入：空白 trim、ASCII 十进制/前导零、拒绝各种语法及非 ASCII 数字形状、错误类/message、两个独立 label 闭包，以及两个精确整数返回值。最大输入 `9007199254740991` 等于 `Number.MAX_SAFE_INTEGER`，另一个 `2147483648` 仍精确；没有超过 exact-integer 范围、触发真实 timer/大列表/模型轮次或推断下游上限。round15 已明确的精度缺口没有恢复或重复新增。
- first raw 中确为 **13 pass / 0 fail / 36 expect、Completed、0 skipped**；原有 5 / 6 加 focused 8 / 30 的拆分吻合原始代码。exit 收据是首尝试退出 0、0 reruns，声明 combined raw 与 exit 在查看前保存；复核只读取现有证据。raw 的 1,542 bytes / SHA256、fixture 的 2,592 bytes / preflight SHA256 均一致，没有修改或重跑。
- 独立核对 source-manifest **4 个文件**的冻结 Git blob SHA256、当前文件 SHA256、行数及 selected ranges，全匹配冻结 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。核对 artifact receipt **13 个非自身文件**的 bytes / SHA256 全通过；报告 **11 个本地链接**均存在，行锚点不越界；findings / candidates / related 三个数组均为空。
- dedup collector 的代码确遍历 docs/bugs 的 MD 行和 recursive JSON scalar value leaves，排除本批，包含 archive。只核对已保存统计与 capped contexts 设计，没有重新运行历史扫描：2,109 文件 = 1,176 MD + 933 JSON，267,491 string leaves / 373,239 scalar leaves、0 parse error；精确 leaf 模式 16 条全部保留，广义模式 1,040 条只保留前 100 上下文，每条最多 1,200 字符。报告正确把关键词当导航而非语义穷尽。round15 旧 parseInt/NaN/trailing garbage、旧精度缺口和 CLI data 失败动态方向均明确排除。

复核没有证明整仓无 bug，也没有把叶函数/错误类控制扩大到完整 CLI、实际运行过程或权限/网络/native 行为。原始日志与 fixture 保持不变。
