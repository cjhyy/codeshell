# Glob 状态行被计入文件数：独立静态复核

支持单项 **P3 静态显示问题**，沿用作者 alias **TUI-R111-C1**，Root 拟正式编号 **TUI-R53-01**；这是同一项的复核，不新增第二个 ID。普通成功结果中的说明行被当作匹配文件计数。没有运行产品、表达式样例、fixture、tests、TUI 或模型，以下输出均为源码分支推导。

| 正常 producer 结果 | 活跃 consumer | 静态可推导摘要 |
| --- | --- | --- |
| 有效 Glob pattern 无匹配：`glob.ts:84–85` 返回 `No files matched the pattern.` | TUI `ToolCall.tsx:244–261` 只过滤非空行和数字 matched header | 该说明行留在 files，显示 `1 files`；默认折叠和展开分支相同 |
| 恰好一个普通匹配：`glob.ts:103–117` 生成数字 header 加一个路径行 | CLI `renderer.ts:138–146` 计算所有非空行数 | 两行计为 `2 files`；零匹配字符串同样计为 `1 files` |

普通生产链有实际绑定：builtin `index.ts:403/413` 将 Glob 定义绑定 `globTool`，`:196–208` 的字符串结果协议把这两类文本作为成功结果，registry `:243–267` 保留 result。TUI App `:883–905` 接收主 agent 的 `tool_result` 并保存 `r.result`；`:2166–2177` 的 VirtualMessageList 经其 `:166–167/235–236` 调 `renderEntry`，app-helpers `:261–271` 将字段原样交给实际 **ToolCallResult**。组件 `:106–107` 默认 localExpanded=false，`:134–152` 在成功非空结果调用 Glob renderer 并展示摘要。CLI run `:232–236` 默认 text、把普通 stream event 送入 renderer；factory `:119–125` 选择 TextRenderer，`:64–72` 对成功 tool_result 调 compactSummary。

反证与影响限定：TUI 对普通正结果已经过滤数字 header，正常单匹配在 TUI 仍计 1；它也保留无匹配说明正文，用户能看见与摘要矛盾的提示。问题是摘要误导，不据此推断文件丢失、工具执行失败、目录扫描或数据损坏。错误/空内容有独立分支；CLI JSON/JSONL 不走这个文本摘要。展开模式不改变 TUI 的计数过滤。未扩大到 >200 footer、排序、权限、身份、真实文件系统或未证活跃的 Core compactOutput helper。

历史 gate：fresh [原库存](history-inventory.json) **5150 = 1489 MD + 3661 JSON**，纳已冻正式52、排正式53+；JSON 2430509 strings / 3611347 scalars，递归 value、不把键当文本；exact archive 段162、substring174。原 R7对 ToolCall/glob/既有 glob test 同 SHA明确 full，原 R21 renderer 记1–163全文并保留仅 JSON 动态调用限定，所以本次只是具体新问题 **targeted selected 复核**，不是首次/full 新覆盖。[canonical 对象与旧因决定](canonical-history-decisions.json)保存原 May30 `/123`：它是 >200 producer 缺标题/单复数问题；R7 files.md22 与 cross-review-tui.md14仅引用该旧项，不是当前消费者计数原因。

[首轮 gate](history-gate.json)宽 query有 global 等误召回及 cap100，不能报成精确0。追加[词边界 gate](focused-history-gate.json)计68个宽上下文；零结果完整字符串与具体 renderer/helper 名称计数 query均0。实际看了68条有界匹配窗口（62条另存 [remaining windows](remaining-cause-window-review.json)，6条先前定向查看），巨型 scalar 未全文；关键旧项回到原 `/123` 直读，不把重复嵌套文本当独立旧 finding，也不承诺语义穷尽。CLI 额外 canonical 检索晚于其已 pin 的选段阅读，时序如实保留，没有回填为读前。

范围见[源码清单](source-manifest.json)：**9 产品 selected，273 产品语义行；2 既有测试文件选读 39 行声明；合计 312 语义行 / 736 唯一显示行**。导航、权限/取消机制边界及重复打印不增加语义；测试只读普通正结果/零结果声明和既有 CLI renderer 声明，未执行，也未称它们覆盖这次 UI count。[excerpts](source-excerpts.json)只保存已实际显示范围。两个指令文件本轮 hash-only，复用先前同字节阅读。源范围与旧作者/reviewer 可能重叠，不加到全局完整覆盖数。

[首诊断](metadata-diagnostics.json)保留两次历史元数据展示截断（退出均0，未伪造原始 raw）；后续仅自己的元数据范围/字节/链接检查，没有产品重试。[ending](ending-checks.json)保留原时点与当前字节；[validation](validation.json)记录所有产品/helper/fixture/test/React/DOM/clock/timer/native/network/model/Git执行0。父上下文 `524c0827a480132119b637aa87e16f0eab9895f3` 由 Root 提供，本 agent 未查 Git。旧 R7 TUI、R14/Slice 等失败动态方向均保持停止，没有转借旧 pass。
