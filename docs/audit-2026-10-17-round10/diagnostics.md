# Browser diagnostics 第十批补审

冻结源 `6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。本批新增 **1 个 P3 确认项**；没有修改产品代码。动态证据来自实际 inspector callback、内存 page adapter、Node VM 和自造 collection；生产 Desktop 适配器接线只做静态追踪。

## DIAG-R10-01 / P3：DOM 节点预算生效前，先完整枚举宽子树的 children collection

- **位置**：`packages/browser-devtools/src/inspector.ts:167–172`。`Array.from(element.children)` 和 shadow children 的 `Array.from(...)` 先完整生成数组，随后 `for` 内才检查 1000 项 queue cap。`:134` 的 visited 上限和返回节点 limit 不会限制这次枚举。
- **合同**：包 README `:43–44` 明确说明 DOM traversal 有界；已有设计记录 `docs/todo/browser-automation-library-reuse.md:81` 说明 DOM 遍历另有节点上限。源码 `:132–134` 也设定独立遍历预算。因此，本项针对遍历工作量，不把“返回最多 100 个 nodes”误读为“输出超限”。
- **正常触发**：大表格、列表或普通自定义元素的容器拥有很多直接子节点；调用 `inspect({mode:"dom",maxEntries:1})`。开放 shadow root 下同样可达。每个子节点均是普通元素，不需要畸形记录或适配器异常。
- **实际执行**：实际 page-evaluation callback 在 VM 内运行。代表可迭代 DOM collection 的自造对象计数每次 yielded element。light children 和 shadow children 各有 20,000 项时，均完整读取 **20,000 项**，返回仍只有 1 个 node、`truncated:true`。首跑日志包含计数。`Array.from` 对生产可迭代 HTMLCollection 的完整枚举是源码层推导；本轮没有真实 HTMLCollection/浏览器排版器。
- **同根因的静态变体**：`:145–150` 的 direct-text 提取也先对 `element.childNodes` 做完整 `Array.from`、filter/map/join，再把文本截为 160 字符；宽 DOM 的全部直接节点与文本拼接仍先被处理。本轮 fixture 的 `childNodes` 只有 1 条，**没有动态验证此变体**，不将 children 的计数结果外推为 childNodes/文本计数，也不新增 finding。
- **预期与修复方向**：在迭代 collection 时按剩余 queue/遍历预算停止，避免在只需极少输出时完整复制宽子树；direct-text 提取也应在节点枚举和文本收集过程中使用预算，而不是完整拼接后才截短。此处不主张精准的额外 1 项探测规则，只要求 collection 和文本提取的工作量受已有预算约束。
- **影响**：返回数量、queue 长度和主循环 visited 数都受限，但临时数组分配与 children 枚举随输入子节点总数增长，削弱这个诊断 API 承诺的遍历上限。没有测量真实浏览器延迟、内存峰值、8 秒超时或页面卡死，也不将这些潜在结果写成已发生事实。
- **对照**：4 个直接子节点的正常小 collection 完整返回 root + 4 children，顺序正确、`truncated:false`；Network response / failed-request 混合记录和 Performance timing 字段、100 条输出 cap 也通过。
- **消费者**：`packages/desktop/src/browser-library/browser-inspector.ts:9–10` 将 Puppeteer/Playwright page 直接交给此工厂；`puppeteer-browser-driver.ts:624–631` 的 `inspect()` 使用同一个 inspector。没有运行 Desktop、Puppeteer、Playwright 或真实 BrowserInspect 工具链。
- **证据**：[首跑夹具](evidence/diagnostics-bounded-projection.test.ts)、[原始合并日志](evidence/diagnostics-bounded-projection.first.log)、[exit receipt](evidence/diagnostics-bounded-projection.first.exit.json)。测试断言观察到的行为，因此 pass 不代表该问题已经修复。
- **查重**：完整遍历 `docs/`、`bugs/` 的 MD 与 JSON（包括 archive/_archive，JSON 字符串中的 JSON 继续解析）；[查重结果](evidence/diagnostics-history-search.json)。旧 `CDP-R3-03` 是 visibility:hidden 祖先过早剪枝、遗漏 visible 后代，与此项的 eager collection 枚举不同；没有重新验证或重复计数旧项。

## 范围、排除和证据边界

读完包内全部 `src` 文件、README/package metadata 和现有 unit tests；Console / Network 环形记录、普通事件 metadata、entry limit、DOM BFS 与 open-shadow 遍历、Performance 数据字段均做源代码审查。实际动态只执行下表两个 guarded shard。

Performance 先拼接 navigation/paint/resource 的数组、再截取前 N 条；没有找到其承诺“最新 N 条”或全局时间排序的合同，故不列缺陷。DOM direct-text 截取、非正常 page event payload、调用方篡改返回对象等未建立正常触发与明确合同，也没有凑作候选。没有恢复旧失败方向。

真实浏览器 integration 文件只读，用于确认现有使用方式；**没有执行**。未启动浏览器、网络/CDP连接、进程工具或原生 UI，没有真实模型、上传/下载或用户数据；没有进入权限、认证、custody/security/watchdog 方向。page-evaluation 8 秒等待没有新增动态验证，且本轮不把 Node VM 运行时间当作真实页面性能指标。

两次静态/元数据文件定位猜测失败，均保留工具响应转录，并跳过猜测文件方向：[失败定位转录](evidence/diagnostics-static-lookup-failures.json)。第一次猜测 `packages/core/src/browser` 导致 rg exit 2；第二次猜测前批 `attachments-findings.json` 导致 cat exit 1（同次读取到现存 validation 文件）。它们不是 Bun shard，不计产品失败或测试失败；没有修复路径后重跑对应命令。

## 首跑验证

所有合并 stdout/stderr 与 exit receipt 均先落盘，再读取内容；没有 fixture/dependency/assert 失败，没有重试。

| shard | 结果 | 材料 |
| --- | --- | --- |
| focused callback / metadata | 5 pass、20 expect、0 fail/skip、Completed、exit 0；2 个观察测试 + 3 个正常对照 | [log](evidence/diagnostics-bounded-projection.first.log)、[exit](evidence/diagnostics-bounded-projection.first.exit.json) |
| existing inspector unit baseline | 5 pass、24 expect、0 fail/skip、Completed、exit 0 | [log](evidence/diagnostics-existing-inspector.first.log)、[exit](evidence/diagnostics-existing-inspector.first.exit.json) |

合计 **2 个 clean first shards、10 pass、44 expect、0 fail/skip**。没有 typecheck、lint、dist 构建、全套测试或原生接受测试声明。详细计数和哈希见 [validation](evidence/diagnostics-validation.json)、[冻结源 manifest](evidence/diagnostics-source-manifest.json)、[artifacts](evidence/diagnostics-artifacts.json)。
