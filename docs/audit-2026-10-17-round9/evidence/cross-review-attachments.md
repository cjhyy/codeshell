# Attachments 独立只读复审

结论：**ATT-R9-01 支持 P3，表述边界准确。** 本复审没有运行、修改或新增测试，没有调用图像生成器、平台桥接或 native open，也没有产品改动。

已逐项核对 `attachments.md`、focused fixture、两个首次 raw stdout/stderr、exit 文件、validation receipt、21 文件冻结 source manifest；两个 raw SHA 与 receipt 相符，exit 均 0，冻结 Git blob 的 21 个 SHA 均相符。统计为 focused 5 pass/24 expect + baseline 40 pass/79 expect，共 45 pass/103 expect/0 skip/0 fail，均有 Completed。静态 metadata 诊断：只读 verifier 最初读取错 hash 字段而未比较；该调用输出为 `sourceFiles 21 badFrozenHashes []`，不能作为已核验 21 个 hash 的证据。随后仅修正只读字段选择（`frozenSourceSha256`）再比较冻结 blob，独立调用输出 `verifiedFrozenSourceHashes 21 mismatches []`。此段为工具响应 transcription；不是测试/fixture重跑，也没有据空比较声称通过，所有首次 raw logs 保持不变。

核对生产来源与消费：`generate-image.ts:485–496` 把 cwd 直接 join 入完整路径，并写入真实 result formatter；`attachments.ts:56,115–119` 以不含空白的 token 扫描，`:85–89` 允许残余带目录+扩展名。GenerateImage 不在 Write args 兜底集合（`:93–110`），dispatcher `index.tsx:132` 走 GenericToolCard。`GenericToolCard.tsx:39,82–83` 原样消费 detector path；`AttachmentCard.tsx:55,119–131` 将其交给 openPath 或拼 cwd 请求缩略图，没有在这条链恢复被分词截断的前缀。

focused fixture 的正常 POSIX 工作区含空格，实际合成文件存在，真实 detector 返回 `spaces/.code-shell/generated_images/1782-audit.png`；同 cwd resolve 后不存在。该差异在实际数据函数层确定，不依赖图像解码器或假定的 native open 返回。完整 CJK/no-space 路径与 Write 结构化含空格 args 正常，足以定位 prose token 根因。路径名内含空格导致遗漏是同根因变体，不应另计 finding。

原始结果仍含完整正确路径，故影响限定通用产物卡定位/缺失；不升级为产物文件丢失或整任务失败。完整 generator/UI/open 消费仅源码证据，Windows 与目录深度 truncated 两点继续保留静态 notes，不计已确认。历史 ArtifactTracker shell redirect 分词、Write success heuristic 与本 detector 输入/消费者不同；报告说明了去重局限，没有声称全历史语义穷尽。无需修改报告。
