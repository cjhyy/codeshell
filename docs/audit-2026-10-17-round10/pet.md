# Pet 普通数据投影与 disclosure 审查

冻结源码：`6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。本分审只新增报告、fixture 与证据；没有改动产品。确认 **2 项 P3**，无额外候选。两次 guarded 首跑合计 **91 pass / 225 expect / 0 fail / 0 skip**，均 Completed；其中 89 项是既有基线，2 项新增测试刻画当前错误行为，测试通过不代表产品已修复。

## PET-R10-01 [P3] 并发搜索超过默认结果上限后静默丢行

- **位置：** [search.ts:154](../../packages/pet/src/disclosure/search.ts#L154)，最终 `slice(0, maxSessions)` 没有把已找到但被裁掉的命中计入 `truncated`。94–95 行仅用 `cursor < candidates.length` 标记尚未分配的候选，无法覆盖已经分配并在异步读取后追加的命中。
- **正常触发：** 21 个普通 Work Session 均有相同查询词，单个 transcript 很小且健康；使用生产默认 `maxSessions=20`。此次首跑中，8 个并发 worker 已实际扫描全部 21 个候选，最终命中被截成 20 行却返回 `truncated:false`。并发情况下，已分配的读取在命中上限判断之后仍可能完成并追加结果，而最终裁切没有补记这些被省略的命中。
- **实际证据：** 真实 `searchSessionTranscripts()` 对自有临时目录得到 `{scannedSessions:21,matches.length:20,truncated:false}`；不同 transcript mtime 明确排序，最新 `work-20` 保留、最旧 `work-00` 被裁掉。20 个匹配会话的正常对照为 20/20/false。
- **预期与影响：** 保留 20 行上限合理，但有命中被省略时应返回不完整信号。Desktop 主进程 [index.ts:5031](../../packages/desktop/src/main/index.ts#L5031) 和 Mimi [sessions-tool.ts:196](../../packages/pet/src/sessions-tool.ts#L196) 都使用默认结果上限；Desktop [SessionSearchModal.tsx:179](../../packages/desktop/src/renderer/shell/SessionSearchModal.tsx#L179) 只在该布尔值为真时显示“结果不完整（已达搜索上限）”。本例会隐藏已有的提示；Mimi 同样收到错误的完整性字段。
- **查重：** 旧 R56/W22 是 500 候选带之外从未扫描的会话漏报；本项仅 21 个候选，全部实际扫描且全部命中，错误发生在并发命中后的结果裁切。旧 PET-01 是 JSON 编码预筛，本例内容只有普通 ASCII，未触发该根因。历史 `docs/bugs` 审查/归档 MD 和解析 JSON 共 1,054 文件逐层检索，未检出同根因记录。
- **边界：** 动态证据是生产文件 reader/search helper；Desktop IPC、modal 和 Mimi 字段转发仅源码接线核对，未挂载 UI、执行 Sessions 工具或启动真实 Host。没有要求无限搜索、改变 500 候选设计，也没有会话数据丢失。

## PET-R10-02 [P3] Unicode 小写扩长后用错原文坐标，snippet 不含命中词

- **位置：** [search.ts:59](../../packages/pet/src/disclosure/search.ts#L59) 至 63 行。`text.toLowerCase()` 中的索引直接交给原文 `buildSnippet(text, index, query.length)`；大小写转换并非恒长。
- **正常触发：** 用户正文包含多个大写土耳其字母 `İ`，之后出现 ASCII 查询词。`İ` 转为 `i` 加组合点（两个 UTF-16 code units），在匹配词之前累积的扩长会把 snippet 起点移到真实命中之后。
- **实际证据：** 健康字符串 `"İ".repeat(240) + " TARGET " + "z".repeat(240)` 查询 `target`。真实 helper 找到该会话，但返回 snippet 为省略号加一段 `z`，完全没有 `TARGET`。仅把前缀换成等长 ASCII `A` 的对照，snippet 正常包含 `TARGET`。两条都被扫描并命中，`truncated:false`；没有依赖 JSON 引号/反斜杠预筛缺陷。
- **预期与影响：** 命中片段应围绕原文中的匹配位置，保持可读的查询上下文。Desktop [SessionSearchModal.tsx:192](../../packages/desktop/src/renderer/shell/SessionSearchModal.tsx#L192) 原样展示首个 snippet；Mimi Sessions search 同样转发 snippets。用户看到会话命中，却无法从片段辨认实际命中内容。这里的重复前缀是便于确定偏移的合法 Unicode 文本压力样例，不声称所有土耳其文都受影响。
- **正常内容契约：** Core [transcript.ts:537](../../packages/core/src/session/transcript.ts#L537) 的 `appendMessage()` 接受字符串并原样放入 `data.content`，987 行 JSON.stringify 持久化。fixture 手写该受支持的 message/state JSON 形状，未通过 Core producer 生成；此处 producer 内容接线为静态验证，动态运行的是真实 Pet reader/search，不是重写实现。
- **查重：** 旧审查只有 TUI 搜索对 `İ` 的既有覆盖记录，未检出 Pet snippet 的大小写坐标问题。旧 PET-01 查询预筛及 R56 候选截断均为不同阶段与根因。
- **边界：** 仅确认检索摘要展示偏移；会话命中和正文均仍存在。没有真实 UI 输入、模型、账号、网络或外发行为。

## 已读范围与未新增发现

完整读取普通纯函数 `topic-segment`、`segment-closure`、`migration-summary`、`context-recall`、`session-visit-receipt`、`im-session-list`，以及 `session-index`、`projection-extension`、`types`、disclosure 的 `catalog/jsonl/latest-result/todo-snapshot/selector/search`。对 `sessions-tool` 做完整只读接线检查；Desktop 搜索入口、片段展示、提示文案以及 Core message producer 只查相关段，不能当成完整文件审查。

既有 12 文件基线覆盖 topic 阈值、closure range/parser、迁移顺序、memory 预算与排序、visit receipt、IM 状态/编号、投影运行归属及 generation/version fence、catalog/reader 的正常过滤和文本截断等，共 89 pass / 212 expect。未发现第二组强契约的新投影缺陷；没有把未被生产使用的任意 SessionIndex 调用序列，或有界 tail 的既定读取设计，当成正式发现。没有执行真实 DelegateWork、Host action、IM/outbound、服务器、模型、原生应用或实际用户状态读取。

## 原始证据与方法

- 新增首跑：[fixture](evidence/pet-search-display.test.ts)、[raw combined stdout/stderr](evidence/pet-search-display.first.log)、[exit 收据](evidence/pet-search-display.first-exit.json)：2 pass / 13 expect / 0 fail/skip。
- 既有基线首跑：[raw combined stdout/stderr](evidence/pet-pure-baseline.first.log)、[命令与 exit](evidence/pet-pure-baseline.first-exit.json)：89 pass / 212 expect / 0 fail/skip。
- 所有首跑仅使用 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILES`。先保存原始合并输出及 exit 再阅读，没有修支架重跑或另路恢复失败方向。新增 fixture 的临时目录在 finally 删除；既有测试自身使用隔离临时目录，没有改写其 cleanup 方式。
- [结构化查重](evidence/pet-dedup.json) 扫描历史 `docs/bugs` 审查、review、archive/_archive MD 与解析 JSON 叶节点，排除本批；保存有限上下文而非巨大 minified 行。第一次查重正则把 `İ` 放入 IGNORECASE，导致过宽匹配，随后只修正元数据，见 [说明](evidence/pet-dedup-first-metadata-note.json)。此操作没有重跑或修复产品测试。
- [源码 manifest](evidence/pet-source-manifest.json) 记录所读/所引文件的冻结 Git blob SHA-256，不能据此宣称每个大文件均完整阅读。[validation](evidence/pet-validation.json) 与 [artifact receipts](evidence/pet-artifact-receipts.json) 记录本分审交付。
