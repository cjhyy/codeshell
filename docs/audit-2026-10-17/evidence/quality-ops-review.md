# Sources / Desktop 数据审查的只读复核

复核者：operations_memory_round2。冻结基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`。只读当前 `sources.md`、`desktop-data.md`、各自源码/fixture/原始日志与计数清单；没有重跑任何测试、修改他人报告、执行模型/网络/权限实验。本文件不产生额外缺陷编号或通过测试数。

## 结论与计数

- 当前两个报告均可保留：Sources **3 项（P2=2/P3=1）**，Desktop/Web **3 项（P2=2/P3=1）**。两报告合计 **6 项（P2=4/P3=2）**；没有发现应撤销的正式条目或彼此重复项。
- Sources 最终 6 个首次 shard：5/10、15/44、3/10、2/5、1/6、1/10（测试数/expect）；合计 **27 tests / 85 expect / 0 fail / 0 skipped tests**，6 份原始日志均有 Completed。两个语义候选与未执行 engine/query 线索不计正式条目。
- Desktop 4 个首次 shard：2/3、2/8、3/8、2/6；合计 **9 tests / 25 expect / 0 fail / 0 skip**，4 份日志均有 Completed。两个报告合计 **36 tests / 110 expect** 是作者既有运行的汇总，不是本次复核新增执行。
- 独立只读核验 Desktop manifest 的 17 个生产源码和 10 个证据文件：SHA-256 均匹配清单，17 个源码逐字节匹配冻结 Git blob。没有把这次哈希核验计作 Bun 测试。

## 需保留的条件与证据边界

### Sources

1. **S01：目标路径解析问题保留 P2。** 当前 `orderedParts` 直接拼 `${root}/${Target}`，混合一个可匹配相对关系和一个 `/` 或 `./` 关系时，仅返回相对项而 `truncated=false`，三个 parser observation 与原日志吻合。Office 保留标签及关系顺序的项目约定确实存在于 `docs/todo/workspace-upload-document-index-delivery.md:7`，不是复核者新增预期。S01 的微软链接是 package-level API，不应写成已成功读取 PackagePart API；当前报告明确保留该失败与范围限制。fixture 是真实 ZIP 容器和有关 XML 部件，缺少完整 OOXML 包 schema 验证，不应宣称真实 Office 应用已打开/保存验证。
2. **S02：namespace 别名前缀问题保留 P3。** SAX 已启用 namespace 解析，但保存 `attr.name` 而 lookup 固定 `r:id`；XLSX fixture 只改变前缀而保持 URI。日志证实按 ZIP 文件名 fallback，正文未丢、标签/顺序改变。报告正确限定动态 XLSX，PPTX 共用路径只为静态推断。与 S01 分别是 URI 解析和 XML expanded-name 识别，不应合并成单一动态样例，也不能把二者测试再按格式拆成更多发现。
3. **S03：初始证据是纯函数组合，后追加了实际 handler/本地 worker。** 初读报告时只有 `searchDocumentIndex → JSON.stringify → scrubSecrets` 组合 2/5；复核期间作者同步了已执行的 `sources-handler` 1/6 和正常 `sources-local-document` 1/10。已只读核对新增原始日志和最终 `sources-receipts.json`。因此最终不能再写“仅纯函数、未运行 handler/worker”；当前最终报告已正确写成真实 ReadSource handler 和本地 parser worker，但没有 UI/完整 executor 审批/外部服务/真实秘密。此次复核没有执行追加实验或扩大 secret/security 方向。格式损坏本身的 before/after JSON 与 `JSON.parse` 失败/跨文件正常对照一致。
4. Han+Latin/digit 的检索假阴性、注音串入正文，虽各有动态观察，报告因预期语义未定仍保留候选；不计正式发现是恰当的。

### Desktop / Web

1. **UI-01 保留 P3，限定显示投影。** 多行 Textarea 正常输入、编码保留全文、解析器只识别单行“评论:”的接线与 fixture 一致；第三行冒号被分类为 locator 的日志吻合。模型 wire 与磁盘原文未证明丢失，报告没有把投影截断写成用户请求永久丢失。
2. **UI-02 保留条件 P2。** 必须明确是大小写敏感文件系统 Host（例如 Linux），且存在两个仅大小写不同的合法注册项目根。当前纯函数运行在本机并不能证明 Linux 项目注册已实际完成；报告已限定这一点。静态 `canonicalKey` 只对 darwin/win32 转小写，Linux 保留大小写，与条件相容。`targetForCwd` 使用错误的 `projectForCwd` 返回值并在无精确 root 时只传错误 projectId，后续主根选择是静态接线，不可改称新会话实际创建/工具实际写错项目。
3. **UI-03 保留 P2，限定合法 legacy、无 output journal、tail 不完整。** 512 KiB 来自生产常量；真实自有 tmp transcript reader 返回 hasMore=true，显示首任务为 RECENT，完整 raw 首任务为 OLD，而 UI 用同一零基 index 取 raw turn。fixture/原始日志与 MessageStream 点击及 fork 提交接线吻合。现代 journal 路径有 exact legacy base/replay，不能笼统说“所有长会话”；当前报告已作正确收窄。没有实际 fork/provider 或真实内容外发，不宜使用已泄漏用户资料等措辞。

## 与本分审的重复/失败边界

- UI-02 的 Web path lowercase 与本分审 OM5 的 Core memory 分隔符编码碰撞是两个不同生产 key、两个独立修复点；不能因都涉及项目归属而互相当作复现，也不应重复计同一个 fixture。
- 本分审 OM2 已因 pending 快照契约不明确降候选；本分审首次 round1 的 1 pass/3 fail 日志不能加进上述两个报告的 Completed 统计，也没有在本复核中重跑。
- 对旧 audit/review 的“没有重复”均限既有有限关键词/报告对照；本复核未穷举所有历史报告，不能把有限查重升级为绝对首次发现。

## 最后追加：Root 摘要候选与收据只读复核

依父任务最后要求，只读 `root.md` 候选区、`root-summary-json.test.ts/.log` 及十份成功日志；没有任何动态重跑，没有改 Root 报告。

- `summaryFixture()` 实际调用 `listSessionMemories(baseDir)`，当前 API 签名为 `listSessionMemories(limit=50, baseDir?)`。这里把字符串当 limit 且漏传存储根，正常对照也得到空数组；因此两条摘要服务影响都不能由该 fixture 可靠证实。Root 当前候选描述准确。
- 原始失败组确为 **1 pass / 2 fail / 6 expect / 退出1 / 无 Completed**。第一项 direct `extractJSON` 返回跨围栏合并文本的日志有效，但该项 pass 不能把整组、实际 session 摘要未保存或尾逗号正文损坏提升成正式确认。R2-12/13 只存在于测试临时标题，不应分配为正式问题编号。
- 逐份解析已有日志核对成功组：adjacent 8/8、changed-files 3/6、copy 2/6、export 2/5、history 2/4、parser-baseline 72/186、rollout 2/6、session-discovery 2/8、TUI-tables 3/10、unified-diff 4/13（测试/expect）。恰为 **10 个 Completed shard / 100 pass / 252 expect / 0 failure**，Root 总计正确。
- `root-adjacent-baseline` 只代表实际被 Bun 选中的 external-agent-changes 8 条；Root 已说明误写的 MessageContent 文件未被选择，不把 TUI 既有 suite 冒记为已执行。摘要失败组三条未加入成功总数。
- 本追加未发现需要 Root 改动的计数或候选条件。仅复核上述指定区域，不声称完成 Root 全部 11 项的源码审计。
