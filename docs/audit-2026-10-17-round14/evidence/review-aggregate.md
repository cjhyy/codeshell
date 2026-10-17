# 第十四批汇总：独立只读复核

复核对象：README、findings/candidates/related/addressed-sources/validation/source-manifest/worker-integrity JSON、metadata assembler 及对应分区报告/首日志/退出收据。结论：**汇总的 0 formal / 4 candidate / 1 related、两条独立旧源码变化及窄验证范围均有支持**。本复核没有新增、运行或修改任何测试，没有运行 assembler、产品代码或 Git 写操作；只新增本复核文档。

首次汇总复核发现一处 worker 元数据口径问题：`evidence/utils-validation.json` 原先对失败 Slice shard 的 run 和 failedFirstTotals 写 `expect: 0`，但 Bun raw 没打印 expect 总数。未进入测试体可支持“实际产品断言执行 0”的推断，不能称为 Bun 打印出的总数。根 `validation.json` 已使用 `expectations: null`。随后 Utils 作者仅修订元数据：两处 `expect` 均改为 null，另列 `testBodiesExecuted: 0`，同步 metadata assembler 和 artifact receipt。本复核再次只读核对当前最终值、生成器对应字段及 **18 个 Utils artifact bytes/SHA，0 错误**；问题已解决，fixture、raw、退出收据未修、无测试或产品重跑。

已完成的只读核对如下：

- 六个首次 raw 的 SHA-256、退出收据和具体 guarded 命令逐项一致；全部命令都为 `node scripts/run-bun-test-shard.mjs --timeout 30000` 加一个明确文件。四个 clean 有 Completed，依次为 trace **6/32**、bytes **11/31**、roomHistory **8/9**、Core format **6/6**，合计 **31 pass / 78 expect / 0 fail/skip**。其中 existing=8+6=14，focused=6+11=17。两个失败 raw 各 **0 pass / 1 fail / 1 error**、exit 1、无 Completed、expect/skip 总数未打印；没有把这些失败中 “Ran 1 test” 计入成功覆盖。
- Utils 和 Web 的失败均为自有 fixture 相对 import 多上一级，目标源模块和测试体未进入；源码候选没有实际结果或控制通过的主张。未执行的 cache/semver/toolDisplay fixture 单独记 `attempts=0`，没有对应 launcher/首日志、没有把预期算成观察结果。现有 Core format.test.ts 只有六个 `formatDuration` 案例，不能证明 intl、其他格式器、Slice 或 cache/semver 已动态验证；README 和根 validation 已明确这一限制。
- 四个 candidate ID 与分区标题/根表格/JSON 相符，全部不定级、不列正式。Slice 两项和普通 XML 一项保持静态；BYTES 项只取得自造 SOF3 序列被实际纯 probe 拒绝的 characterization，不具有独立解码有效性或普通 downstream lossless 支持合同。10 项正常内存 byte controls 和 1 项候选拒绝测试都不能把后者升格为已确认 bug。
- related 中 Core toolDisplay 的 UTF-16 截断只关联旧 DESKTOP-R12-01 家族；没有把 Desktop 修复当成 Core helper 已修复或已验证。addressed-sources 的两条旧 finding 分别指向 `9925b3282` 和 `3d6a1ec35`，与 baseline-refresh 的实际 diff/八条 incoming commits 相符；source-only 已变化状态与本批 bug/candidate/related 分账，runtimeRetested=false。旧实验或其他任务的 UI/native 验收没有被借算为本批证据。
- 根 source-manifest 的 **62 个唯一 source/contract pins**逐条重新从冻结 Git blob读取：bytes、SHA-256 和当前文件相符，0 错误。它明确是选定 source pins，不表示完整文件、传递依赖或全仓审查覆盖。worker-integrity 的 **45 个 worker artifact** SHA 逐条与现有文件相符，0 错误；此计数对应本次读取时材料，若修订 worker 注释需相应刷新收据与汇总。
- 根 Markdown 共 **72 个本地链接**核对存在，含 `:line` / `#Lline` 的代码链接行号均在实际文件范围内；candidate/related 对应 source 引用和报告标题无错位。外部标准来源保留原工具响应摘要和出处，复核没有重新下载、解码或把该出处当 fixture 有效性证书。
- 全历史库存为 1088 MD + 680 JSON = 1768；Root/Web/Bytes 的 185197 string leaves 与 Utils 的 260285 scalar leaves 口径区分。导航误猜和未就绪材料诊断有独立说明，metadata 指针解析不被称为恢复产品失败路线。assembler 静态内容只读写审查元数据及 Git blob pin，Python 语法可解析；本复核没有执行它，也没有增加任何产品运行。

证据 index 待 root 最后刷新，本次不以正在变化的 index 为最终提交字节证明。整合前后 primary 既有删除/untracked 保存与最终 Git index/commit 检查仍由 root 完成，不能从本次只读材料复核提前断言已经整合。全仓审查目标保持进行中，0 新 formal 是本批审查结果，不是仓库无 bug 的结论。
