# Pet 只读交叉复核

冻结源 `6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。复核 `pet.md`、findings/validation/source manifest、fixture、两个首次原始合并日志及 exit 收据，并阅读真实 search/catalog/text reader、Core 消息写入和 Desktop/Mimi 消费段。**接受 2 项 P3；没有发现阻止收录的问题。** 本次只新增此 review，没有运行测试、产品代码、浏览器、Host 或 Git 写操作。

## PET-R10-01

`search.ts:94–95` 只在尚有未分配候选时设置 `truncated`；8 个异步 worker 可先分配完 21 个候选，再完成命中。实际首次日志明确记录 scanned=21、matches=20、truncated=false；fixture 还断言最新 work-20 保留、最旧 work-00 被裁掉，避免把目录排序差异当成丢行原因。20 个健康匹配会话的对照返回 20/20/false。最终 `:154` 的 slice 造成结果省略，却没有反馈该省略，合同和根因成立。

Desktop 入口 `main/index.ts:5031` 只改 budget，没有覆盖默认 maxSessions=20；Mimi `sessions-tool.ts:196` 传空选项。Modal `:179` 按 truncated 显示既有不完整提示，`:192` 使用首个 snippet；中文 i18n `panels.ts:301` 对应“结果不完整（已达搜索上限）”。这些是静态接线，报告已明确没有 UI/IPC/工具动态验证。

历史 R56/W22 的 500 候选问题在 catalog slice 之后仍有未被搜索的健康会话；本例只有 21 个候选且实际全被搜索，问题在已完成匹配的最终裁切。虽然共享 truncated 字段，两者阶段和根因不同，不重复计数。查重材料也指出既定 20 命中/500 候选设计；本报告合理保留容量限制，只要求已有不完整信号准确。

## PET-R10-02

`search.ts:59–63` 在 lowerText 中定位，却在原文中截取该坐标。真实字符串里的 İ 小写后扩长，符合普通 Unicode 字符串的受支持输入；240 个前缀只用来把偏移确定地放大到 80 字符 radius 之外。首次日志的 Unicode snippet 完全是 z，ASCII 等长前缀对照包含 TARGET；同次两个会话都被发现，排除目录缺失、预算、原始 JSON 预筛和查询大小写未匹配等不同解释。

Core `transcript.ts:537` 接受 string/ContentBlock[]，直接保存 content，并在 flush `:987` JSON.stringify。fixture 手写兼容 JSON 形状，没有动态经过 Core producer，报告已如实标注。正常内容可达性由该 producer 合同及 reader 保留 string 的实现支持；不需要真实土耳其用户或模型调用。原文命中并未丢失，仅展示片段坐标错误，P3 与证据相称。旧 TUI Unicode 覆盖不等于 Pet 此处已有发现。

## 统计与材料核对

- focused log：2 pass / 13 expect；existing baseline log：89 pass / 212 expect / 12 files。两者都有 guarded Completed、0 fail/skip 和 exitCode=0，与 validation 的 **91 pass / 225 expect / 2 clean shards** 一致。没有补跑。
- 32 个 source-manifest 条目的 frozen SHA-256 均与冻结 Git blob 相符；12 个 artifact receipts 的字节数及 SHA-256 均匹配当前材料。pet.md 的本地链接没有缺失。
- 所引用关键行号与当前冻结源码一致。候选数组为空，不将未验证的任意 SessionIndex 调用序列或 tail 设计充作缺陷。
- 旧 500 候选缺陷与 JSON 预筛缺陷有明确相关但不同根因说明。元数据查重的第一次过宽正则已在独立 note 披露，不是产品测试失败或重试。

复核期间的历史命中过滤曾因 IGNORECASE 与 İ 的 Unicode 等价产生过宽工具输出；随后仅在内存中过滤既有 metadata 的明确 R56/W22/500/PET-01 字面量以核对历史记录，没有改动其查重材料，也没有运行新的产品验证。
