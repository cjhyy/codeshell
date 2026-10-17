# Round28 流式 Markdown 分块静态审查

冻结点由 Root 提供：`32c633e58c20b3853f49bb0e43264b4577281eac`。本方向 **1 个 P3 静态正式发现、0 候选、0 新关联**。只读取源码、测试声明、历史文档和 JSON/hash；0 产品/import/测试/fixture/React/browser/parser/VM/native/Git/网络/模型执行。下述文本和块边界均为人工源码推导，没有实际 HTML 或 UI 观测。

## STREAMING-R28-01 / P3：流式二次分块从内部空行拆开完整代码围栏

普通触发是助手仍在输出尾部文字，`done:false`，此前已输出一个内部含空行的完整代码块。富流式默认开启。源内容例如：

````text
```js
const a = 1;

const b = 2;
```

still typing
````

[真实 stream producer](../../packages/desktop/src/renderer/types.ts:1080) 建立 `done:false` 的 assistant message，[text_delta](../../packages/desktop/src/renderer/types.ts:1153) 把普通事件文本直接累加；[AssistantMessageView](../../packages/desktop/src/renderer/messages/AssistantMessageView.tsx:63) 将完整 `message.text` 和 done 交给 StreamingMarkdown，没有关闭默认 rich stream。不需要构造畸形 DTO、调用原生工具、模型或真实 UI。

[fence-aware leaf](../../packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:81) 本身会把这个已闭合围栏整体保留在 stablePrefix，把后续 prose 留在 activeTail。但 [StreamingMarkdownBody](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:124) 随后调用 [splitIntoChunks:143–148](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:143)，无条件按 `\n{2,}` 切整个 stablePrefix，再 trim。它不保留 fence 状态，因此上面的内部空行产生两个独立输入（以下仍是源码推导）：

```text
chunk 1 = "```js\nconst a = 1;"
chunk 2 = "const b = 2;\n```"
```

[每个 chunk](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:167) 都是一次独立 ReactMarkdown 调用，没有共享前一块的围栏上下文。这直接违反 [140–142 行](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:140) 所声明的“每块自包含，含完整闭合代码块，单独解析等价于一起解析”。原本完整的代码块在交给 renderer 前已经变成两个不完整 Markdown 文档，代码块结构不能保持。具体 HTML tag 数量、视觉样式和 React 渲染结果未实测，不把静态输入值称为 captured output。

影响严格限于受影响的**富流式阶段**：当 throttle 缓存中出现该前缀且消息仍未 done 时，完整代码块被分成不同 Markdown 片段。非常快完成、未展示该帧的消息未必可见此现象。[done:true 分支](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:50) 直接把原始完整 text 交给 Markdown，绕开 chunker，可恢复完成态的完整结构；不是最终内容丢失或持久化损坏。此函数不改原 message.text、磁盘文件或剪贴板；流式本来就没有代码块 copy/collapse 控件，不声称复制错误。

反证保留：没有内部空行的闭合围栏不会被这个分隔符从中间切开；尚未闭合的围栏被 leaf 留在 activeTail，走普通 `<pre>`，属于已保护的另一分支；[streamingRichRender:false](../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:61) 也走完整 source `<pre>`。120ms throttle 本身没有做时序实验。其它 trim/缩进/list 分块可能性未建立独立普通合同，不凑第二项。

修复方向是让稳定前缀的第二次分块也保留 Markdown 块/fence 边界，或将不能证明独立的块合在一起；本轮只记录，没有修改产品、添加 fixture 或运行验证。

## 历史与覆盖边界

[全历史检索](evidence/streaming-dedup.json) 覆盖 `docs/`、`bugs/` 全部 MD 与递归 JSON value scalars（排除 round28，含169个 exact archive/_archive 路径）：**2677=1262 MD+1415 JSON，506929 strings /740424 scalars，0 parse error**。leaf/consumer、blank-fence-chunk、缺陷词、旧 parser 边界总命中 **35/67/2/3**，全部保留；完整35项 leaf/consumer 组中没有 exact `splitIntoChunks` 记录。两个“缺陷词”命中是 done/error 说明和旧 cwd 修正，不是这个原因。关键词和有限旧文选读不证明历史语义穷尽。

[旧 walkthrough](../archive/review-2026-07-09/02-desktop-stream-walkthrough.md:129) 描述了 fence-aware leaf 与 chunk；[设计 C4/C1](../archive/todo/desktop-streaming-markdown-autoscroll-plan.md:608) 分别要求 memo chunk 与不拆围栏，未记录二次切分会破坏完整代码块这一组合缺口。C2 引用式链接/脚注跨分块是明确已知限制，本项不复报。旧 [ReviewPrompt R19-R1/R2](../audit-2026-10-17-round19/reviewprompt-report.md:15) 是向固定外层提示围栏插正文及 UTF16 截断；本项是 renderer 把原来有效的闭合围栏拆成文档，来源与需要的修复不同，也没有把旧模型/prompt/lexer 证据借来使用。

旧 [parseDocument 动态方向](../audit-2026-10-17-round15/evidence/docinput-preflight-skip.md) 的猜测依赖 metadata 失败仍保持 SKIP。本方向没有 import/执行 parser、React server renderer、Markdown库或替代验证，也没有检查/修复依赖或恢复旧 Thinking/TUI/i18n 路线。详见 [历史判断](evidence/streaming-history-decisions.json)。

[源码清单](evidence/streaming-source-manifest.json) 为13个 pins：5个产品/测试全文（124+151+173+83+98），types91行及 Markdown props/classes36行选读，共 **756行产品/合同**；另 CODESHELL217行、历史合同103行。没有通读大型 types/Markdown 文件或做 authority/security 审查。whole-file SHA 只证明字节，不扩大语义范围；已先读的文件 first semantic-read SHA 保持 null，早期 coverage prep SHA 只是独立字节来源，Root 负责绑定冻结 Git blob。

已有 leaf18、component8，共26个 test 声明只读，**0执行/0pass/0expect**。它们的普通围栏、尾部与 done/fallback 意图是静态反证，不能充当本例已通过的验证。没有产品日志或 exit 可提供；[validation](evidence/streaming-validation.json) 的 runs 为空，不伪造空跑成功。Root 先前 Round27 failed compose shard 也不支持本项。

[作者材料收据](evidence/streaming-artifact-receipt.json) 校验本方向文档/evidence 字节；[metadata notes](evidence/streaming-metadata-notes.json) 保留 pin 时点与 source-only 范围。材料 hash 与本地链接检查不是产品测试或全仓完成证明。
