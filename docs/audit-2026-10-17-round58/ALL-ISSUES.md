# 全部118项正式历史问题与未完成范围

本批新增CHAT-R58-01/P2，累计118项：45P2、73P3。原117机器对象原样保留；118不是当前未修复数。部分旧项已有源码处理记录，未逐项重验当前状态。

最新可靠语义台账仍为旧45同SHA迁移的4643路径：304完整范围、168部分、4171无法确认；4339不能标full不是精确未读或剩余量。46–53仍DEFERRED_UNPARSED、54–58未统一回填。当前同过滤库存4644，多出的1路径是旧57证据fixture，不是新增产品全文。非TS/TSX和完整运行机制不在分母。[覆盖报告](../audit-2026-10-17-round55/evidence/coverage-current/report.md)、[本轮hash绑定](evidence/coverage-snapshot-current-binding.json)。

| ID | 级别 | 历史问题 |
| --- | --- | --- |
| [A01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | ApplyPatch 成功重命名后丢失脚本执行权限 |
| [A02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | ApplyPatch 失败回滚会损坏被删文件的字节和权限 |
| [A03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P3 | Git status 的首条未暂存路径被截掉首字符 |
| [A04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P3 | 合法提交标题中的竖线破坏 Git log 字段 |
| [A05](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /commit 在模型返回 error 时仍实际提交 |
| [A06](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /commit 提示不含已暂存内容，提交却包含它 |
| [A07](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /permissions 宣称 live 切换，实际只改无会话引擎 |
| [A08](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 自定义会话存储时 /undo 读取错误目录，无法撤销 |
| [A09](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /undo all 忽略新建文件，不能撤销整个会话 |
| [A10](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | headless run 的显式模型参数被 seed Engine 覆盖 |
| [A11](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | release --push 在任务分支可能推送未合入 main 的标签 |
| [A12](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P3 | JSON 最终结果的空正文后备混入子代理输出 |
| [C01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | OpenAI 流提前正常 EOF 被当作完整回答，TurnLoop 发布 completed |
| [C02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | pre_tool_use 改写参数后未重复 Plan/MCP 参数权限门禁（旧报告已知，仍存在） |
| [C03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Bash 的只读分类接受可执行程序/安装修改的 rg、npm 选项，Plan 模式直接放行 |
| [C04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 相对 Write/Edit 路径的备份按进程 cwd 定位，撤销成功却没有撤销实际修改 |
| [D01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Git 项目的中文及带特殊字符文件名被当成 Git 转义字面量，@ 搜索找不到真实文件 |
| [D02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 多根项目先全局截断，再筛当前根，使当前根匹配文件无故消失 |
| [D03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Chrome Native 的 JSON-lines 分片解码会静默损坏中文或 emoji |
| [SWC-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 同渠道多账号排序改变后，持久消息会交给另一个账号 |
| [SWC-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 不同账号的消息共用去重键，第二个账号被当作重复成功接收 |
| [SWC-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 小附件 spool 发生 I/O 错误时仍返回接收成功，重启后消息消失 |
| [SWC-04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Matrix botUserId 可省略，正常回复会再次进入输入并触发回复回环 |
| [SWC-05](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 一个有效 JSON 但非对象的 state.json 让整个磁盘会话目录查询失败 |
| [SWC-06](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-16/findings.json) | P3 | 相同目录 mtime 的混合大小写会话，分页会漏项 |
| [R2-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Claude 项目编码碰撞导致会话归属错误 |
| [R2-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Codex 列表选新 rollout，历史定位选旧文件 |
| [R2-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Markdown 导出围栏被工具正文提前闭合 |
| [R2-04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Claude null 记录中止该会话健康历史 |
| [R2-05](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 复制为纯文本会修改 fenced code 正文 |
| [R2-06](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | TUI 将 fenced 表格示例当成真实表格 |
| [R2-07](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | TUI 转义管道符导致表格错列并隐藏后列 |
| [R2-08](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Codex patch rename 变更归属遗漏新路径 |
| [R2-09](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Review 将 hunk 正文误判为文件头并丢失改动 |
| [R2-10](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Review 纯重命名丢失两个文件路径 |
| [R2-11](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Review 未解码 Git quoted 中文路径 |
| [S01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Office 关系路径拼接静默遗漏 sheet/slide |
| [S02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Office 写死 r:id 前缀导致标签和顺序错误 |
| [S03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | ReadSource 单文件查询脱敏破坏已序列化 JSON |
| [OM1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 全局记忆 ADD 按名称覆盖项目另一条 dream |
| [OM3](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Session summary 对有效时区时间按字符串排序 |
| [OM4](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 并行工具进度复制另一工具的开始时间 |
| [OM5](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 不同自然项目路径共用持久 memory 根 |
| [UI-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 多行本地评论显示截断并误分类续行 |
| [UI-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Web/Mobile 对 cwd 转小写合并不同项目 |
| [UI-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 历史尾窗口选择新任务却匹配旧 raw turn |
| [PET-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Pet JSON 原文预筛漏掉引号代码和反斜杠路径 |
| [TIME1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Cron 多余分隔符被截断且 update 接受错误计划 |
| [TIME2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | CronCreate 的 Host 钟面时间贴上 job 时区 |
| [CHD01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Slack thread 身份丢失使回复落到频道顶层 |
| [CHD02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 长附件标签截断拆开 Unicode 代理对 |
| [R3-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex file_change完成事件丢失修改文件投影 |
| [R3-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex MCP结果与失败原因变成不可读摘要 |
| [R3-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex JSONL null记录未隔离 |
| [R3-04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Windows格式默认room名使用整段cwd并可生成不可读metadata |
| [HL-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 精确GitHub文件路径被trim并合并引用 |
| [HL-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 长路径默认标签截断Unicode代理对 |
| [CDP-R3-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 旋转quad点击/hover取到元素外的点 |
| [CDP-R3-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Shift组合的logical key与text矛盾 |
| [CDP-R3-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P2 | DOM hidden祖先剪枝漏掉显式visible子节点 |
| [LAB-R3-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Lab反思输入仍选取已更正的旧评分 |
| [ARENA-R3-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 缺失或非法peer verdict默认agree并verified |
| [ARENA-R3-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Arena裁决早退跳过unresolved收尾 |
| [CTX-1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | Fallback snip切掉已保留tool call的结果 |
| [CTX-2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | 摘要转换丢失结构化tool_result中的文字 |
| [SET-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | user单字段保存遮蔽YAML中的其他配置 |
| [SET-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P3 | Config接受错误类型并落盘，后续settings读取失败 |
| [CODING-R4-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | LSP Definition/References把编码URI当文件路径 |
| [CODING-R4-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | LSP重复diagnostics未同步已打开文件的编辑 |
| [LOG-R4-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round4/findings.json) | P3 | 日志轮转按bucket前缀删除最近engine历史 |
| [WEB-R5-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | 子代理事件改写主任务全局运行状态 |
| [WEB-R5-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round5/findings.json) | P3 | 乱序结果回填遗漏正常显示清理 |
| [PROFILE-R5-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | 不同catalog source键碰撞并互相删除缓存 |
| [PROMPT-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round5/findings.json) | P3 | 祖先local和后代project指令优先序违背声明 |
| [CHAT-R5-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | LINE原生按钮投影超过平台label/URI限制 |
| [FILES-R7-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/findings.json) | P2 | Edit单次替换解释字面replacement token并写入错误内容 |
| [FILES-R7-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Grep Node fallback以basename匹配目录glob导致假阴性 |
| [FILES-R7-04](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Read超限错误建议无法穿过size gate的分页恢复 |
| [PROV-R7-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Anthropic SDK参数事件路由落后一个工具并污染进度卡片 |
| [GIT-R8-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 带引号路径在committed/dirty摘要中重复计数 |
| [PLUGIN-R8-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 空引号命令参数消失并使后续位置左移 |
| [PLUGIN-R8-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | ARGUMENTS前缀抢先匹配完整命名placeholder |
| [PLUGIN-R8-03](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 已接受Windows marketplace路径派生非法name |
| [WEB-R8-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 根项目不能匹配后代cwd |
| [WEB-R8-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | image/jpg alias提前返回跳过客户端每图大小检查 |
| [ATT-R9-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 空格工作区中的完整产物路径被截断成错误附件路径 |
| [COST-R9-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 独立CostTracker记录丢失完整模型标识并采用错误估价 |
| [SESSION-R9-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 超工具调用上限的完成会话留下未配对持久化调用并阻断full fork |
| [DIAG-R10-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | DOM bounded traversal eagerly enumerates complete child collections before queue cap |
| [PET-R10-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | 并发搜索超过默认结果上限后静默丢行 |
| [PET-R10-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | Unicode 小写扩长后 snippet 不含命中词 |
| [CHAT-R11-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round11/findings.json) | P3 | 通知进度首次 load 失败的 rejected Promise 被缓存，同一 watcher 后续重试不再读取已恢复的 store |
| [TUI-R12-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | modifyOtherKeys 将非 Ctrl 大写文本降为小写 |
| [TUI-R12-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | KeyboardEvent 未将编码可打印键还原为字面字符 |
| [DESKTOP-R12-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | 工具卡摘要截断拆开 Unicode 代理对 |
| [PATCH-R12-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | 首个 Update chunk 省略可选 @@ 时丢失显式空白 context |
| [HIST-R13-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/findings.json) | P3 | 当前 session 新输入在 Up 历史导航中排在旧 session 后面 |
| [HIST-R13-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/findings.json) | P3 | 中断撤销后现有历史 navigator 仍返回被撤销输入 |
| [CHAT-R17-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round17/findings.json) | P3 | 显式 loopback HTTP 80 端口被配置生成器误判成缺少端口 |
| [REVIEWPROMPT-R19-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round19/findings.json) | P3 | /review 用法提示给出未被 parser 识别的 perf 维度名 |
| [ERROR-R22-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round22/findings.json) | P3 | Billing/quota HTTP429 loses its cause and becomes a temporary rate-limit hint |
| [PRODUCT-R23-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round23/findings.json) | P3 | Public product/run factory cwd is never consumed as the submitted run default |
| [OUTPUT-R25-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round25/findings.json) | P2 | CRLF-completed output loses visible line bodies during progress folding |
| [TUI-R26-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round26/findings.json) | P2 | Treat branch creation flags as complete argument tokens |
| [RENDERER-R26-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round26/findings.json) | P3 | A root file named __all__ cannot be selected alone in a multi-file turn review |
| [AGGREGATOR-R27-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round27/findings.json) | P3 | Isolated DriveAgent changed-file links lose their cwd and open the parent chat file |
| [STREAMING-R28-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round28/findings.json) | P3 | Streaming rich Markdown re-splits a closed fenced code block at an internal blank line |
| [MARKETPLACE-R37-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round37/findings.json) | P3 | A legal marketplace named local is routed to direct-local plugin uninstall |
| [MCP-R38-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round38/findings.json) | P3 | Reopening and saving a stdio MCP form loses structured argument boundaries |
| [MCP-R39-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round39/findings.json) | P3 | Renaming a settings-owned MCP server drops supported non-editor fields |
| [TRANSCRIPT-R42-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round42/findings.json) | P3 | 后台子代理转录把撤销当作封口，保留已经作废的部分回复 |
| [TUI-R48-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round48/findings.json) | P3 | 后台任务完成会重置仍在运行的前台计时，缩短状态栏与回合耗时 |
| [DESKTOP-R50-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round50/findings.json) | P3 | 工具回合的过程分组丢失目标“再续”按钮回调 |
| [DESKTOP-R52-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round52/findings.json) | P3 | 细长附件图片缩放为零短边，压缩回退原图而忽略所选尺寸上限 |
| [TUI-R53-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round53/findings.json) | P3 | Glob摘要把标题或无匹配提示当作文件，显示错误数量 |
| [TUI-R53-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round53/findings.json) | P3 | Windows绝对路径未按cwd缩短，长前缀吞掉工具摘要中的文件名 |
| [PET-R57-01](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round57/findings.json) | P3 | 定时续办生成被过滤的话题边界，跳过已关闭段的小结和自动记忆 |
| [CHAT-R58-01](findings.json) | P2 | 网关停机释放租约后仍写旧收件箱快照，覆盖新进程已确认消息 |

原源码处理记录、日期与运行界限见[机器目录](recorded-findings-catalog.json)及各原报告，不由本列表认证当前全部未修或已修。
