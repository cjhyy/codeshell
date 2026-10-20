# Round 18 最终汇总只读复核

结论：接受本批 **0 formal / 1 candidate（UNREAD-R18-C1）/ 0 related** 及有限覆盖表述。未发现需要重跑产品或扩大缺陷结论的事项。最终 evidence index 尚需按既定流程刷新，纳入本复核、后生成的 integration plan 以及已明确的 review-traceapi 措辞校正；这属于材料收尾，不是产品验证失败。

本次先按真实库存及回执定位 README、四份专项/四份复核、findings/candidates/related、validation、source-manifest、worker-integrity、index、baseline-refresh、addressed-sources、main-refresh 和 root-qc。按 validation 的实际 raw/exit 指针阅读四份首日志与退出回执；只对既有文件做静态读取、哈希/字节/链接核验。**没有新产品 runtime、测试或任何 Git 命令。**

## 计数与证据强度

- 四个 first guarded shards 为 environment 6/22、presentation 10/58、traceapi 8/23、unread 9/35（tests/expect），合计 **33 pass / 138 expect / 0 fail / 0 skipped**。四个 exit 均为 0，实际命令逐项相同，raw SHA 与汇总匹配，guard 均 Completed。只有 presentation 含 5 个现有例子，另外 28 个为 focused；**32 个直接叶子测试 + 1 个明确手工镜像的未读组合**。先保存后阅读来自原作者首次回执；复核没有用第二次执行替代首证据。
- findings 和 related 的列表/计数均为 0；candidates 恰有 UNREAD-R18-C1，没有严重级别。独立静态核对 `useRemoteApp.ts:685–709`：清除 event.activeSessionId 的未读标记确在导航 guard 前。最后一个 fixture 实际调用三个叶子 helpers，但导航谓词为手工复制；所用非空 ID 使该谓词与源分支一致。静态 producer/stream 接线与 helper 组合支持候选，不能证明真实 hook、跨标签页时序或页面结果，更不证明消息丢失、错发或导航已实际发生。
- Presentation 对应 Web 显式类别与输入边界叶子；旧 Desktop duration/group/merge 和旧 Core backend/i18n 结果没有混入。Trace API 只有内存 requester 和部分自有返回对象，四次调用/两条路径的测试标题限制已披露；没有执行含 auth/scope 场景的现有整文件。Environment 已有先前完整静态阅读，本批只补普通 descriptor helper 控制，未调用无普通消费者证据的 projectReferenceKey。未读现有混合 replay/approval 测试未执行。

## 材料、源码与时间点

- 当前 **38 个去重 selected source/contract 路径**逐文件当前 SHA 与汇总 currentSha256 一致；**44 次 worker source checks** 与汇总冻结 SHA 对应一致；**36 个 worker artifact SHA** 均匹配当前字节（presentation 13 + traceapi 11 + unread 12）。冻结/main SHA 的采集来自既有 root/专项 Git-blob 收据，本次没有再次发起 Git 命令。pins 不是全文件、所有依赖或全仓覆盖证明。
- 唯一 frozen/current 差异为额外单列的 `packages/desktop/src/renderer/tool-cards/FileToolCard.tsx`；其 current/main SHA 相同，旧 DESKTOP-R12-C1 状态在 addressed-sources 单独记录。其他任务的 Write UTF-8 标签源码修改没有计入本批 candidate/related，也没有当作工具卡、Write、其他任务新增回归或 UI 已复验修复。
- main-refresh 记录独立任务推进及五个变化路径；integration-before 与 integration-premerge 除 HEAD 外全部字段一致，包括 tracked/staged diff hashes、statusHex 和四份普通 untracked 元数据。这里只核对保存的快照一致性；实际提交、快进和提交后字节保护仍由 root 的最终集成收据证明。
- 历史查重描述 FF main 前的冻结语料：1,995 文件 = 1,148 MD + 847 JSON，253,680 string leaves；三个专项另明确 353,952 scalar leaves。归档、当前 batch 排除、匹配次数与上下文 cap 均有独立字段。后续验收 Markdown 随 main 改变已在 baseline-refresh 说明，不能要求旧完整语料 inventory hash 全部等于最终 main。该时间差不改变本批材料、selected source 与首跑时点证据。关键词不证明语义穷尽。
- 首次检查的 **66 项 index 快照（自身除外）**中，65 项字节/SHA 一致；唯一待刷新项是 root 随本次反馈已修正的 `evidence/review-traceapi.md`。该修正将先前过宽的“无 Git 操作”改成“无 Git 写操作”，并如实记录此前用了只读 git show 核 frozen pins；fixture、raw 与 worker artifacts 均未改变。后生成 integration plan 与本复核不要求旧 index 预先包含，root 将统一刷新并检查最终索引/暂存 blob。所有现存 Markdown 的 **75 个本地链接**及附行号/行式锚点范围均核验无错误。

## 元数据与剩余集成步骤

汇总首轮批量读取的函数输出总预算触发 `Warning: truncated output (original token count: 10179)`，其中 review-environment 的一段被缩略；随后仅对该已知存在文件有界重读完整内容。没有将截断响应当完整阅读，也没有产品执行、fixture 修复或失败方向恢复。其他 worker 已披露的猜测路径、元数据范围校正与旧输出截断保持原记录，不计作 Bun 失败。

root 应在本复核后刷新 index，核实仅本批路径暂存、raw 原字节、full/non-log whitespace 与 staged Git blobs，再保存实际提交/primary 快进/dirty 保留/owned worktree clean 的外部收据。当前复核不提前宣称这些未发生的最终步骤已完成，也不将本批 checkpoint 当作全仓审查完成。
