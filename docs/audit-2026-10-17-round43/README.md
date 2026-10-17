# 第43批：数据编辑与草稿选段；正式历史问题目录

本批 **0新增正式问题、0新增候选、0新关联**。普通dataset editor DTO与表单选段未建立新反例；ChatView受控草稿/键盘选段同样是有限negative。异步插件展开覆盖另一草稿的疑点精确对应旧D5/R04，排除1项，不重复编号、不更新旧运行状态。

[Dataset作者](evidence/dataset-frontier/report.md)与[Root反证](evidence/dataset-review/review.md)、[草稿作者](evidence/draft-frontier/report.md)与[独立旧因排除](evidence/draft-review/review.md)分账：后者当前产品body0，仅支持旧因排除，不能冒称独立审过作者键盘448行。Root反证不是盲审；作者阶段概述先知、自己读前pin与正文范围另存。测试声明不当pass，未改产品。

正式父提交 `c2db5d9259afcc4c7264d190ab6bb673d49d5fe0`。原3696/3773历史快照不改；正式3869纳入96份冻结42新增MD/JSON，初扫共享字节0变化；刷新后release TODO有1份真实字节漂移，原库存不回写。主分支刷新到07e5791b1fc1ad1fcfd5c55c2913d8a45f1b20cb的22条路径与本批47个source pins无交集，原源证据不变。前置gate及关键词不构成全历史语义穷尽。冻结source-excerpts.txt有27处编号空白行尾随空格，已在暂存前识别并完整保留；仅此文件作窄例外，完整whitespace实际退出码与其余文件检查分别记录。

0产品/helper/import/Buffer或事件语言fixture/测试、React/UI/native/模型/训练/权限身份/业务网络执行，0pass/expect。worker Git0，Root Git元数据操作另列。只增审查文档、未push，整体审查继续。[Root汇总](evidence/review-aggregate.md)、[范围](coverage.json)、[验证](validation.json)、[证据索引](evidence-index.json)。

## 前42批正式历史记录目录

**111条原正式记录：44条P2、67条P3，ID无重复。** 这里只索引本次审查前42批canonical findings，排candidate/related及嵌套副本；包含旧known和后来source-addressed的记录，**不能当作111个当前未修或111个首次新因**。原分类、条件、证据、运行边界及处理状态以链接的原报告为准，本表没有重做当前状态或根因判定。[机器目录](recorded-findings-catalog.json)保留每条原始时点字段与42份源文档指纹，[独立metadata核对](evidence/catalog-review/review.md)仅核目录映射。

最近新增4项P3为MARKETPLACE-R37-01、MCP-R38-01、MCP-R39-01、TRANSCRIPT-R42-01，均是源码审查确认，未做实际产品运行复现。

| 原优先级 | ID | 原标题 |
| --- | --- | --- |
| P2 | [A01](../audit-2026-10-16/findings.json) | [P2] ApplyPatch 成功重命名后丢失脚本执行权限 |
| P2 | [A02](../audit-2026-10-16/findings.json) | [P2] ApplyPatch 失败回滚会损坏被删文件的字节和权限 |
| P2 | [A05](../audit-2026-10-16/findings.json) | [P2] /commit 在模型返回 error 时仍实际提交 |
| P2 | [A06](../audit-2026-10-16/findings.json) | [P2] /commit 提示不含已暂存内容，提交却包含它 |
| P2 | [A07](../audit-2026-10-16/findings.json) | [P2] /permissions 宣称 live 切换，实际只改无会话引擎 |
| P2 | [A08](../audit-2026-10-16/findings.json) | [P2] 自定义会话存储时 /undo 读取错误目录，无法撤销 |
| P2 | [A09](../audit-2026-10-16/findings.json) | [P2] /undo all 忽略新建文件，不能撤销整个会话 |
| P2 | [A10](../audit-2026-10-16/findings.json) | [P2] headless run 的显式模型参数被 seed Engine 覆盖 |
| P2 | [A11](../audit-2026-10-16/findings.json) | [P2，静态确认] release --push 在任务分支可能推送未合入 main 的标签 |
| P2 | [C01](../audit-2026-10-16/findings.json) | OpenAI 流提前正常 EOF 被当作完整回答，TurnLoop 发布 completed |
| P2 | [C02](../audit-2026-10-16/findings.json) | pre_tool_use 改写参数后未重复 Plan/MCP 参数权限门禁（旧报告已知，仍存在） |
| P2 | [C03](../audit-2026-10-16/findings.json) | Bash 的只读分类接受可执行程序/安装修改的 rg、npm 选项，Plan 模式直接放行 |
| P2 | [C04](../audit-2026-10-16/findings.json) | 相对 Write/Edit 路径的备份按进程 cwd 定位，撤销成功却没有撤销实际修改 |
| P2 | [D01](../audit-2026-10-16/findings.json) | Git 项目的中文及带特殊字符文件名被当成 Git 转义字面量，@ 搜索找不到真实文件 |
| P2 | [D02](../audit-2026-10-16/findings.json) | 多根项目先全局截断，再筛当前根，使当前根匹配文件无故消失 |
| P2 | [D03](../audit-2026-10-16/findings.json) | Chrome Native 的 JSON-lines 分片解码会静默损坏中文或 emoji |
| P2 | [SWC-01](../audit-2026-10-16/findings.json) | 同渠道多账号排序改变后，持久消息会交给另一个账号 |
| P2 | [SWC-02](../audit-2026-10-16/findings.json) | 不同账号的消息共用去重键，第二个账号被当作重复成功接收 |
| P2 | [SWC-03](../audit-2026-10-16/findings.json) | 小附件 spool 发生 I/O 错误时仍返回接收成功，重启后消息消失 |
| P2 | [SWC-04](../audit-2026-10-16/findings.json) | Matrix botUserId 可省略，正常回复会再次进入输入并触发回复回环 |
| P2 | [SWC-05](../audit-2026-10-16/findings.json) | 一个有效 JSON 但非对象的 state.json 让整个磁盘会话目录查询失败 |
| P2 | [CHD01](../audit-2026-10-17/findings.json) | Slack thread 身份丢失使回复落到频道顶层 |
| P2 | [OM1](../audit-2026-10-17/findings.json) | 全局记忆 ADD 按名称覆盖项目另一条 dream |
| P2 | [OM5](../audit-2026-10-17/findings.json) | 不同自然项目路径共用持久 memory 根 |
| P2 | [R2-01](../audit-2026-10-17/findings.json) | Claude 项目编码碰撞导致会话归属错误 |
| P2 | [R2-02](../audit-2026-10-17/findings.json) | Codex 列表选新 rollout，历史定位选旧文件 |
| P2 | [R2-09](../audit-2026-10-17/findings.json) | Review 将 hunk 正文误判为文件头并丢失改动 |
| P2 | [R2-11](../audit-2026-10-17/findings.json) | Review 未解码 Git quoted 中文路径 |
| P2 | [S01](../audit-2026-10-17/findings.json) | Office 关系路径拼接静默遗漏 sheet/slide |
| P2 | [S03](../audit-2026-10-17/findings.json) | ReadSource 单文件查询脱敏破坏已序列化 JSON |
| P2 | [UI-02](../audit-2026-10-17/findings.json) | Web/Mobile 对 cwd 转小写合并不同项目 |
| P2 | [UI-03](../audit-2026-10-17/findings.json) | 历史尾窗口选择新任务却匹配旧 raw turn |
| P2 | [CDP-R3-03](../audit-2026-10-17-round3/findings.json) | DOM hidden祖先剪枝漏掉显式visible子节点 |
| P2 | [CODING-R4-01](../audit-2026-10-17-round4/findings.json) | LSP Definition/References把编码URI当文件路径 |
| P2 | [CODING-R4-02](../audit-2026-10-17-round4/findings.json) | LSP重复diagnostics未同步已打开文件的编辑 |
| P2 | [CTX-1](../audit-2026-10-17-round4/findings.json) | Fallback snip切掉已保留tool call的结果 |
| P2 | [CTX-2](../audit-2026-10-17-round4/findings.json) | 摘要转换丢失结构化tool_result中的文字 |
| P2 | [SET-01](../audit-2026-10-17-round4/findings.json) | user单字段保存遮蔽YAML中的其他配置 |
| P2 | [CHAT-R5-01](../audit-2026-10-17-round5/findings.json) | LINE原生按钮投影超过平台label/URI限制 |
| P2 | [PROFILE-R5-01](../audit-2026-10-17-round5/findings.json) | 不同catalog source键碰撞并互相删除缓存 |
| P2 | [WEB-R5-01](../audit-2026-10-17-round5/findings.json) | 子代理事件改写主任务全局运行状态 |
| P2 | [FILES-R7-01](../audit-2026-10-17-round7/findings.json) | Edit单次替换解释字面replacement token并写入错误内容 |
| P2 | [OUTPUT-R25-01](../audit-2026-10-17-round25/findings.json) | CRLF-completed output loses visible line bodies during progress folding |
| P2 | [TUI-R26-01](../audit-2026-10-17-round26/findings.json) | Treat branch creation flags as complete argument tokens |
| P3 | [A03](../audit-2026-10-16/findings.json) | [P3] Git status 的首条未暂存路径被截掉首字符 |
| P3 | [A04](../audit-2026-10-16/findings.json) | [P3] 合法提交标题中的竖线破坏 Git log 字段 |
| P3 | [A12](../audit-2026-10-16/findings.json) | [P3] JSON 最终结果的空正文后备混入子代理输出 |
| P3 | [SWC-06](../audit-2026-10-16/findings.json) | 相同目录 mtime 的混合大小写会话，分页会漏项 |
| P3 | [CHD02](../audit-2026-10-17/findings.json) | 长附件标签截断拆开 Unicode 代理对 |
| P3 | [OM3](../audit-2026-10-17/findings.json) | Session summary 对有效时区时间按字符串排序 |
| P3 | [OM4](../audit-2026-10-17/findings.json) | 并行工具进度复制另一工具的开始时间 |
| P3 | [PET-01](../audit-2026-10-17/findings.json) | Pet JSON 原文预筛漏掉引号代码和反斜杠路径 |
| P3 | [R2-03](../audit-2026-10-17/findings.json) | Markdown 导出围栏被工具正文提前闭合 |
| P3 | [R2-04](../audit-2026-10-17/findings.json) | Claude null 记录中止该会话健康历史 |
| P3 | [R2-05](../audit-2026-10-17/findings.json) | 复制为纯文本会修改 fenced code 正文 |
| P3 | [R2-06](../audit-2026-10-17/findings.json) | TUI 将 fenced 表格示例当成真实表格 |
| P3 | [R2-07](../audit-2026-10-17/findings.json) | TUI 转义管道符导致表格错列并隐藏后列 |
| P3 | [R2-08](../audit-2026-10-17/findings.json) | Codex patch rename 变更归属遗漏新路径 |
| P3 | [R2-10](../audit-2026-10-17/findings.json) | Review 纯重命名丢失两个文件路径 |
| P3 | [S02](../audit-2026-10-17/findings.json) | Office 写死 r:id 前缀导致标签和顺序错误 |
| P3 | [TIME1](../audit-2026-10-17/findings.json) | Cron 多余分隔符被截断且 update 接受错误计划 |
| P3 | [TIME2](../audit-2026-10-17/findings.json) | CronCreate 的 Host 钟面时间贴上 job 时区 |
| P3 | [UI-01](../audit-2026-10-17/findings.json) | 多行本地评论显示截断并误分类续行 |
| P3 | [ARENA-R3-01](../audit-2026-10-17-round3/findings.json) | 缺失或非法peer verdict默认agree并verified |
| P3 | [ARENA-R3-02](../audit-2026-10-17-round3/findings.json) | Arena裁决早退跳过unresolved收尾 |
| P3 | [CDP-R3-01](../audit-2026-10-17-round3/findings.json) | 旋转quad点击/hover取到元素外的点 |
| P3 | [CDP-R3-02](../audit-2026-10-17-round3/findings.json) | Shift组合的logical key与text矛盾 |
| P3 | [HL-01](../audit-2026-10-17-round3/findings.json) | 精确GitHub文件路径被trim并合并引用 |
| P3 | [HL-02](../audit-2026-10-17-round3/findings.json) | 长路径默认标签截断Unicode代理对 |
| P3 | [LAB-R3-01](../audit-2026-10-17-round3/findings.json) | Lab反思输入仍选取已更正的旧评分 |
| P3 | [R3-01](../audit-2026-10-17-round3/findings.json) | Codex file_change完成事件丢失修改文件投影 |
| P3 | [R3-02](../audit-2026-10-17-round3/findings.json) | Codex MCP结果与失败原因变成不可读摘要 |
| P3 | [R3-03](../audit-2026-10-17-round3/findings.json) | Codex JSONL null记录未隔离 |
| P3 | [R3-04](../audit-2026-10-17-round3/findings.json) | Windows格式默认room名使用整段cwd并可生成不可读metadata |
| P3 | [LOG-R4-01](../audit-2026-10-17-round4/findings.json) | 日志轮转按bucket前缀删除最近engine历史 |
| P3 | [SET-02](../audit-2026-10-17-round4/findings.json) | Config接受错误类型并落盘，后续settings读取失败 |
| P3 | [PROMPT-01](../audit-2026-10-17-round5/findings.json) | 祖先local和后代project指令优先序违背声明 |
| P3 | [WEB-R5-02](../audit-2026-10-17-round5/findings.json) | 乱序结果回填遗漏正常显示清理 |
| P3 | [FILES-R7-03](../audit-2026-10-17-round7/findings.json) | Grep Node fallback以basename匹配目录glob导致假阴性 |
| P3 | [FILES-R7-04](../audit-2026-10-17-round7/findings.json) | Read超限错误建议无法穿过size gate的分页恢复 |
| P3 | [PROV-R7-01](../audit-2026-10-17-round7/findings.json) | Anthropic SDK参数事件路由落后一个工具并污染进度卡片 |
| P3 | [GIT-R8-01](../audit-2026-10-17-round8/findings.json) | 带引号路径在committed/dirty摘要中重复计数 |
| P3 | [PLUGIN-R8-01](../audit-2026-10-17-round8/findings.json) | 空引号命令参数消失并使后续位置左移 |
| P3 | [PLUGIN-R8-02](../audit-2026-10-17-round8/findings.json) | ARGUMENTS前缀抢先匹配完整命名placeholder |
| P3 | [PLUGIN-R8-03](../audit-2026-10-17-round8/findings.json) | 已接受Windows marketplace路径派生非法name |
| P3 | [WEB-R8-01](../audit-2026-10-17-round8/findings.json) | 根项目不能匹配后代cwd |
| P3 | [WEB-R8-02](../audit-2026-10-17-round8/findings.json) | image/jpg alias提前返回跳过客户端每图大小检查 |
| P3 | [ATT-R9-01](../audit-2026-10-17-round9/findings.json) | 空格工作区中的完整产物路径被截断成错误附件路径 |
| P3 | [COST-R9-01](../audit-2026-10-17-round9/findings.json) | 独立CostTracker记录丢失完整模型标识并采用错误估价 |
| P3 | [SESSION-R9-01](../audit-2026-10-17-round9/findings.json) | 超工具调用上限的完成会话留下未配对持久化调用并阻断full fork |
| P3 | [DIAG-R10-01](../audit-2026-10-17-round10/findings.json) | DOM bounded traversal eagerly enumerates complete child collections before queue cap |
| P3 | [PET-R10-01](../audit-2026-10-17-round10/findings.json) | 并发搜索超过默认结果上限后静默丢行 |
| P3 | [PET-R10-02](../audit-2026-10-17-round10/findings.json) | Unicode 小写扩长后 snippet 不含命中词 |
| P3 | [CHAT-R11-01](../audit-2026-10-17-round11/findings.json) | 通知进度首次 load 失败的 rejected Promise 被缓存，同一 watcher 后续重试不再读取已恢复的 store |
| P3 | [DESKTOP-R12-01](../audit-2026-10-17-round12/findings.json) | 工具卡摘要截断拆开 Unicode 代理对 |
| P3 | [PATCH-R12-01](../audit-2026-10-17-round12/findings.json) | 首个 Update chunk 省略可选 @@ 时丢失显式空白 context |
| P3 | [TUI-R12-01](../audit-2026-10-17-round12/findings.json) | modifyOtherKeys 将非 Ctrl 大写文本降为小写 |
| P3 | [TUI-R12-02](../audit-2026-10-17-round12/findings.json) | KeyboardEvent 未将编码可打印键还原为字面字符 |
| P3 | [HIST-R13-01](../audit-2026-10-17-round13/findings.json) | 当前 session 新输入在 Up 历史导航中排在旧 session 后面 |
| P3 | [HIST-R13-02](../audit-2026-10-17-round13/findings.json) | 中断撤销后现有历史 navigator 仍返回被撤销输入 |
| P3 | [CHAT-R17-01](../audit-2026-10-17-round17/findings.json) | 显式 loopback HTTP 80 端口被配置生成器误判成缺少端口 |
| P3 | [REVIEWPROMPT-R19-01](../audit-2026-10-17-round19/findings.json) | /review 用法提示给出未被 parser 识别的 perf 维度名 |
| P3 | [ERROR-R22-01](../audit-2026-10-17-round22/findings.json) | Billing/quota HTTP429 loses its cause and becomes a temporary rate-limit hint |
| P3 | [PRODUCT-R23-01](../audit-2026-10-17-round23/findings.json) | Public product/run factory cwd is never consumed as the submitted run default |
| P3 | [RENDERER-R26-01](../audit-2026-10-17-round26/findings.json) | A root file named __all__ cannot be selected alone in a multi-file turn review |
| P3 | [AGGREGATOR-R27-01](../audit-2026-10-17-round27/findings.json) | Isolated DriveAgent changed-file links lose their cwd and open the parent chat file |
| P3 | [STREAMING-R28-01](../audit-2026-10-17-round28/findings.json) | Streaming rich Markdown re-splits a closed fenced code block at an internal blank line |
| P3 | [MARKETPLACE-R37-01](../audit-2026-10-17-round37/findings.json) | A legal marketplace named local is routed to direct-local plugin uninstall |
| P3 | [MCP-R38-01](../audit-2026-10-17-round38/findings.json) | Reopening and saving a stdio MCP form loses structured argument boundaries |
| P3 | [MCP-R39-01](../audit-2026-10-17-round39/findings.json) | Renaming a settings-owned MCP server drops supported non-editor fields |
| P3 | [TRANSCRIPT-R42-01](../audit-2026-10-17-round42/findings.json) | 后台子代理转录把撤销当作封口，保留已经作废的部分回复 |
