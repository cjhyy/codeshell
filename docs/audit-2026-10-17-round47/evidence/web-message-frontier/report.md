# Prep59 Web MessageContent 静态普通展示审查

结论为有限范围 negative：0 formal、0 candidate、0 related。未建立一个同时具有正常输入、真实展示入口和独立新根因的反例。此结论不等于整个 Web 聊天、所有 Markdown、HTML、链接、身份或宿主机制正确，也不把历史未明确记录的文件称为未读。

这是 prep59，Root 提供的父上下文为 `ec1f6ae458d3646d07db20e876a2b9ce8c9939b9`，并非自行运行 Git 验证的正式新 baseline。本代理只写当前 exact 临时目录。产品/helper/语言样例/测试/React/UI/浏览器/native/模型/业务网络/Git 执行均为 0；没有 pass 或运行观察可报告。[validation](validation.json)

审查前先固定目标 `packages/web/app/MessageContent.tsx`：295 行、9846 字节、SHA256 `76d03d244e420ffef0921946267aa7f508b394ec78a5db356b4c827424ece87e`，时间 2026-10-17T15:32:14.440368+00:00。正文到 15:35:31 才开始显示；测试和普通 consumer 亦在各自首次源码显示前记录字节/SHA。CODESHELL/AGENTS 仅沿用此前已读指引并核当前哈希，未知的原首次语义时点没有回填。[initial pins](initial-pins.json)、[body pins](body-initial-pins.json)、[consumer pins](consumer-initial-pins.json)

先完成 fresh 历史 gate，再进入正文：全 docs/bugs MD 文本和递归 JSON scalar values，包括归档，不搜索 JSON key 来冒充 value 命中。纳入冻结45，排 mutable46 与 future52–59。初始 4162 文件 = 1416 MD + 2746 JSON，196575048 字节；1676345 JSON string values、2534677 scalar values，解析错误 0。175 是路径包含 `archiv` 的统计，历史输入没有按归档名称筛掉文件。遍历和关键字命中是导航，不是全文语义阅读全部历史。[history method/inventory](history.json)

Exact path / basename / SHA / display-contract 分别命中 20 / 100 / 17 / 42，均低于每组保留上限160。12 个同对象 exact path+SHA row 均逐项检查了整个对象，包含实际存在的 coverage、scope、review、inspectionScope 等字段：库存、旧 hash-only、rank、incidental 或 unknown 状态，没有明确同 SHA 全文审查证据。没有把旧排名或 no-row 当成未读证明。MD/JSON prose 中的旧 Web 引用是 cwd→project 的选段接线；其他同名 MessageContent 多为 TUI。基于本 gate 未找到明确全文记录，才读取当前正文。[whole rows](history-gate-selected.json)、[basename candidates](history-filename-scope-selected.json)

普通链条是当前 `Workbench.tsx` 的 controller.chat DTO → `chat.items.map` → assistant 的 text/reasoning/`!done` → MessageContent，实际调用在 806–817；tool 和 subagent 在 818–828。`streamReducer.ts` 的所选正常分支分别累加 text/reasoning，并在 assistant_message / turn_complete 标记 done；工具普通 start/result 分别提供结构化 args、结果字符串和完成状态。本轮不继续审传输、replay、身份分组或权限机制。[source ranges](source-manifest.json)、[captured excerpts](source-excerpts.json)

目标 295 行全部显示过，但只将普通复制标签/代码、text/reasoning、streaming/settled、tool/status 分支计入语义范围；HTML、链接、文件宿主回调及平台剪贴板分支只显示到边界，不给其安全/native 正确性结论。因此该 row 是 selected，不能升级为全文语义覆盖。三个产品文件合计454行语义，既有测试仅57行普通声明，合计511行；902行是正文与 rg 导航的去重显示并集。4 selected rows、3 hash-only rows、0 explicit semantic full rows。`useLatestMessages.ts` 仅 pin，正文0；没有扩展旧滚动方向。manifest 保留 body ranges、额外导航行和 canonical union，重复显示不重复计数。

所选正常合同未建立新反例：streaming 明确按纯文本分支展示，settled 将原 text 传给 ReactMarkdown；reasoning 独立折叠；工具 args/result 与单行摘要分离，result 使用 nullish fallback。现有声明包括普通标题/列表/表格/代码、streaming 保持纯文本、reasoning 分离、工作区路径标签、普通工具参数/结果，均只读未运行。安全相关断言也曾显示，但没有采用为安全审查或 pass 证据。

补充函数名和展示旧因检索使用相同 dated 4162 文件集。4 个显示 helper 名称命中0；Web/复制/展示词命中61、保留61，上限100，未发生 cap 截断。实际选读4个旧窗口；Desktop R2-05 是 stripMarkdown 纯文本复制改变 fenced-code 正文，TUI R2-06/R2-07 是另一消费者的围栏/表格问题，均未恢复运行或重报。旧 Unicode 截断、上下文路由、HTML/宿主机制不展开为新 candidate/related。旧 observed Web markup 只是历史输出片段，不能证明本版本全文审查或本轮运行。[cause scan](history-display-causes.json)、[selected windows](history-cause-selected.json)、[decisions](decisions.json)

结束核对7个 pin 的当前源码/指引 SHA 全相同。dated 历史的4162 included paths 及字节全相同；Root 正写的46被相同规则排除，ending excluded88 不回填初始 excluded0。没有改变或扩充原历史时点。[ending checks](ending-checks.json)

两次 metadata 控制台输出被工具截断，exit0；原 structured contexts 保留，相关遗漏窗口已分批重新显示，未把首次截断输出称为全部读完。没有产品失败、函数首跑或重试，具体 tool chunk、原 token 数与警告保存在 [diagnostics](metadata-diagnostics.json)。最终 author receipt 逐文件绑定字节与 SHA，自身不递归包含自身。
