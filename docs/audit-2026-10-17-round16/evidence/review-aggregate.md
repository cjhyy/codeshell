# 第十六批汇总只读复核

复核者 `tabstops_round16`。本次只读 README、四分区报告、findings/candidates/related/validation/source-manifest/worker-integrity/evidence-index、baseline-refresh/main-refresh、四份 scope reviews 与 root-qc。除文末明确授权的本分区报告行号及材料收据校正外，仅写本 review；没有产品 import、函数调用、测试、终端/平台实验、依赖 resolver 或 Git 写入。

结论：接受 **0 formal / 6 candidates / 0 related**，未发现需要阻止本批文档集成的证据冲突。全仓审查仍是未完成的持续目标，本批不构成全产品通过或修复结论。

- 从汇总 `validation.runs` 的实际 log/exit 路径逐一读取四份 first raw 与收据，未猜测后缀。独立核对 raw SHA、exit 0、实际命令、pass/expect 和 guard Completed：memoize 7/36、tabstops 9/27、tasknoise 17/27、bidi predicate 7/21，共 **4 clean first shards、40 pass、111 expect、0 fail/skip**。全部是新增 focused；**33 项调用实际纯 helper 模块，7 项仅编译源码提取谓词**。没有将静态算式、完整 Bidi export、既有 suite 或 UI 计作动态测试。
- README 的六项候选保留了证据强弱：TAB-C1 的 9 来自真实 helper，12 是静态 writer 公式的独立整数算式，最终 DOM/Yoga/writer 效果未运行；TAB-C2 是手造 SGR 在 ZWJ 内部分段，普通 producer 和终端 glyph 未验证。TASKNOISE 两项只证明真实 helper 分类差异，本地 renderer/协议定义仍是静态背景，穷尽 heuristic 合同和正常输入链未建立。`cleaned` 没有被外推成正常 `taskText` 改写。
- BIDI-C1 明确为 compiled-from-frozen-source predicate 的 Adlam 观察，没有执行实际模块、库或 platform/env gate；BIDI-C2 仅是静态对象重排及直接 writer 中缺少可见镜像步骤的疑点，未证明完整 embedding 或下游字体/终端责任。README 没有把 Unicode 的显示规则夸大为所有终端必须代码点替换。根 review 对外部 primary references 的阅读属于原审阅者证据，本复核没有重新浏览或声称独立验证当前外部文档。
- 独立以文本与 SHA 核对 bidi 提取记录的 original function、仅去除两个签名注解后的函数、实际 New Function 参数和带末尾换行的输出 artifact；全部相符。此步骤只处理字节，没有再次编译或调用谓词。最初双反斜杠猜测已被字节否定，正确未登记为 bug。
- findings 和 related 的数组均空，六个 candidate ID 唯一，无严重性评级。Memoize 为 0/0；同步 callback throw 属于预先捕获的正常控制，未误记失败 shard 或重跑。旧 scanner/Skill、ANSI Parser width、sliceAnsi/i18n 路线仅作排除，没有被写成新关联复现。
- 独立检查 **36 个去重源码/合同路径** 的冻结 Git blob bytes/SHA、当前工作树 bytes/SHA 与当时 `main=021f4e3b477fea9b0c46da2fb672ba57ac2c24c7` 的 blob SHA，全部一致；另核对 **49 条逐 worker source checks**。独立检查三份 worker receipts 的 **40 份 artifacts bytes/SHA** 及 worker-integrity 对应 SHA，全部一致。整文件 pin 只证明身份，未用来扩张 full-file/transitive/runtime 覆盖。
- 对现有 index 的 **70 个 entries** 独立核对 bytes/SHA，并检查当时 **97 个本地 Markdown 文件/行号链接**，均通过。`evidence/integration-plan.json` 在旧 index 之后新增，按 root 已声明的最终刷新流程处理；本 review 也由 root 后续纳入 index。没有要求未生成/后生成材料必须出现在早先 index。
- baseline-refresh 记录产品冻结基线不变、主分支只推进另一路 CI/验收文档。独立比较 initial/premerge primary snapshots，除 `head` 外字段完全相等，符合原 dirty/untracked 保留记录；这不是本 review 对尚未发生的最终 merge/commit 的确认，最终 staged blobs/集成结果仍由 root 收据证明。

## 已完成的报告定位校正

Root 逐行复核指出 tabstops.md 原 `[expandTabs:21]` 链接指向 `let result`，而 `column = 0` 的实际冻结行是 **22**；candidate JSON 本来已为 22。本复核按授权仅将自有报告 label/anchor 改为 22，并刷新 tabstops receipt 内该 report 的 bytes/SHA。源码、fixture、raw/exit 和其他作者材料未改，没有产品或测试重跑。上面的 70-entry/40-artifact 检查发生在此定位校正前；root 会在最终汇总中刷新 index/worker-integrity，再核验最终 staged bytes。

## 本复核的首次 metadata collector 失误

第一次只读 collector 在完成 raw/source/worker SHA 检查后，错误地要求旧 index 与此刻全目录文件集合相等，首个工具响应为：

```text
Traceback (most recent call last):
  File "<stdin>", line 30, in <module>
AssertionError
```

wrapper exit 1。随后只读差集显示 `70 indexed / 71 actual`，唯一差异是 root 同期生成的 `evidence/integration-plan.json`，无文件缺失。root 原任务已明确允许该项后续刷新，因此这是复核者的 metadata 门槛错误，不是材料缺陷、产品/Bun 失败或重跑。只纠正该集合要求，继续尚未执行的 index bytes、链接、提取 provenance 和快照比较；未修改原始日志、fixture 或任何作者材料。

除上述明确转录的 metadata 失误，已完成的字节/计数/链接检查无实质错误。无需额外产品运行、fixture 修复或扩大动态范围。
