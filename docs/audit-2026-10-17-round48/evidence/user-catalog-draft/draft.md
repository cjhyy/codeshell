# 已记录问题完整列表与审查进度

截至正式47归档，已记录 **111 项正式历史问题：44 项 P2、67 项 P3**。下表逐项列全，ID 可打开原报告。优先级沿用原记录；这不是“当前仍有111项未修复”的判断。候选、关联项和本轮尚未正式归档的计时提案不纳入。

**目前无法给出可靠的剩余未审数量。** 现有可复算覆盖台账截至冻结45，范围为4643个TS/TSX路径（含测试和辅助文件）：

| 台账分类 | 路径数 | 含义 |
| --- | ---: | --- |
| 有同SHA全文记录 | 304 | 保留原审查目的和范围，不代表所有行为正确 |
| 只有选段记录 | 169 | 有已读范围，未标全文 |
| 索引无法确认覆盖 | 4170 | 可能包含旧阅读、MD-only或未适配记录，不能视为未读 |

**4339=169+4170** 仅表示这份台账不能标为全文的路径数，不是未读数、剩余工作量或剩余bug数。非TS/TSX文件、依赖、构建/运行环境及权限/native等机制不计入这个分母；46及以后没有倒填到该覆盖快照。来源：[正式47覆盖说明](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round47/README.md)。

修复状态边界：带 † 的三项在正式44已记录 **源码已针对原条件处理（07e5791…），运行尚未复验**；WEB-R8-01 的 ‡ 表示原目录已有并发源码处理记录，同样未运行复验。其他项没有本稿可用的最新状态认证，不能据此判为仍未修复。原记录中的“已确认”“fixed=false”等均属于当时版本。

| 原ID（原报告） | 原级别 | 问题简题 |
| --- | --- | --- |
| [A01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | ApplyPatch 成功重命名后丢失脚本执行权限 |
| [A02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | ApplyPatch 失败回滚会损坏被删文件的字节和权限 |
| [A03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P3 | Git status 的首条未暂存路径被截掉首字符 |
| [A04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P3 | 合法提交标题中的竖线破坏 Git log 字段 |
| [A05](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /commit 在模型返回 error 时仍实际提交 |
| [A06](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /commit 提示不含已暂存内容，提交却包含它 |
| [A07](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /permissions 宣称 live 切换，实际只改无会话引擎 |
| [A08](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 自定义会话存储时 /undo 读取错误目录，无法撤销 |
| [A09](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | /undo all 忽略新建文件，不能撤销整个会话 |
| [A10](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | headless run 的显式模型参数被 seed Engine 覆盖 |
| [A11](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | release --push 在任务分支可能推送未合入 main 的标签 |
| [A12](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P3 | JSON 最终结果的空正文后备混入子代理输出 |
| [C01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | OpenAI 流提前正常 EOF 被当作完整回答，TurnLoop 发布 completed |
| [C02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | pre_tool_use 改写参数后未重复 Plan/MCP 参数权限门禁（旧报告已知，仍存在） |
| [C03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Bash 的只读分类接受可执行程序/安装修改的 rg、npm 选项，Plan 模式直接放行 |
| [C04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 相对 Write/Edit 路径的备份按进程 cwd 定位，撤销成功却没有撤销实际修改 |
| [D01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Git 项目的中文及带特殊字符文件名被当成 Git 转义字面量，@ 搜索找不到真实文件 |
| [D02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 多根项目先全局截断，再筛当前根，使当前根匹配文件无故消失 |
| [D03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Chrome Native 的 JSON-lines 分片解码会静默损坏中文或 emoji |
| [SWC-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 同渠道多账号排序改变后，持久消息会交给另一个账号 |
| [SWC-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 不同账号的消息共用去重键，第二个账号被当作重复成功接收 |
| [SWC-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 小附件 spool 发生 I/O 错误时仍返回接收成功，重启后消息消失 |
| [SWC-04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | Matrix botUserId 可省略，正常回复会再次进入输入并触发回复回环 |
| [SWC-05](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P2 | 一个有效 JSON 但非对象的 state.json 让整个磁盘会话目录查询失败 |
| [SWC-06](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-16/findings.json) | P3 | 相同目录 mtime 的混合大小写会话，分页会漏项 |
| [R2-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Claude 项目编码碰撞导致会话归属错误 |
| [R2-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Codex 列表选新 rollout，历史定位选旧文件 |
| [R2-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Markdown 导出围栏被工具正文提前闭合 |
| [R2-04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Claude null 记录中止该会话健康历史 |
| [R2-05](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 复制为纯文本会修改 fenced code 正文 |
| [R2-06](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | TUI 将 fenced 表格示例当成真实表格 |
| [R2-07](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | TUI 转义管道符导致表格错列并隐藏后列 |
| [R2-08](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Codex patch rename 变更归属遗漏新路径 |
| [R2-09](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Review 将 hunk 正文误判为文件头并丢失改动 |
| [R2-10](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Review 纯重命名丢失两个文件路径 |
| [R2-11](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Review 未解码 Git quoted 中文路径 |
| [S01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Office 关系路径拼接静默遗漏 sheet/slide |
| [S02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Office 写死 r:id 前缀导致标签和顺序错误 |
| [S03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | ReadSource 单文件查询脱敏破坏已序列化 JSON |
| [OM1](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 全局记忆 ADD 按名称覆盖项目另一条 dream |
| [OM3](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Session summary 对有效时区时间按字符串排序 |
| [OM4](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 并行工具进度复制另一工具的开始时间 |
| [OM5](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 不同自然项目路径共用持久 memory 根 |
| [UI-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 多行本地评论显示截断并误分类续行 |
| [UI-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Web/Mobile 对 cwd 转小写合并不同项目 |
| [UI-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | 历史尾窗口选择新任务却匹配旧 raw turn |
| [PET-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Pet JSON 原文预筛漏掉引号代码和反斜杠路径 |
| [TIME1](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | Cron 多余分隔符被截断且 update 接受错误计划 |
| [TIME2](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | CronCreate 的 Host 钟面时间贴上 job 时区 |
| [CHD01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P2 | Slack thread 身份丢失使回复落到频道顶层 |
| [CHD02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17/findings.json) | P3 | 长附件标签截断拆开 Unicode 代理对 |
| [R3-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex file_change完成事件丢失修改文件投影 |
| [R3-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex MCP结果与失败原因变成不可读摘要 |
| [R3-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Codex JSONL null记录未隔离 |
| [R3-04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Windows格式默认room名使用整段cwd并可生成不可读metadata |
| [HL-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 精确GitHub文件路径被trim并合并引用 |
| [HL-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 长路径默认标签截断Unicode代理对 |
| [CDP-R3-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 旋转quad点击/hover取到元素外的点 |
| [CDP-R3-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Shift组合的logical key与text矛盾 |
| [CDP-R3-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P2 | DOM hidden祖先剪枝漏掉显式visible子节点 |
| [LAB-R3-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Lab反思输入仍选取已更正的旧评分 |
| [ARENA-R3-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | 缺失或非法peer verdict默认agree并verified |
| [ARENA-R3-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round3/findings.json) | P3 | Arena裁决早退跳过unresolved收尾 |
| [CTX-1](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | Fallback snip切掉已保留tool call的结果 |
| [CTX-2](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | 摘要转换丢失结构化tool_result中的文字 |
| [SET-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | user单字段保存遮蔽YAML中的其他配置 |
| [SET-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P3 | Config接受错误类型并落盘，后续settings读取失败 |
| [CODING-R4-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | LSP Definition/References把编码URI当文件路径 |
| [CODING-R4-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P2 | LSP重复diagnostics未同步已打开文件的编辑 |
| [LOG-R4-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/findings.json) | P3 | 日志轮转按bucket前缀删除最近engine历史 |
| [WEB-R5-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | 子代理事件改写主任务全局运行状态 |
| [WEB-R5-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round5/findings.json) | P3 | 乱序结果回填遗漏正常显示清理 |
| [PROFILE-R5-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | 不同catalog source键碰撞并互相删除缓存 |
| [PROMPT-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round5/findings.json) | P3 | 祖先local和后代project指令优先序违背声明 |
| [CHAT-R5-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round5/findings.json) | P2 | LINE原生按钮投影超过平台label/URI限制 |
| [FILES-R7-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round7/findings.json) | P2 | Edit单次替换解释字面replacement token并写入错误内容 |
| [FILES-R7-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Grep Node fallback以basename匹配目录glob导致假阴性 |
| [FILES-R7-04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Read超限错误建议无法穿过size gate的分页恢复 |
| [PROV-R7-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round7/findings.json) | P3 | Anthropic SDK参数事件路由落后一个工具并污染进度卡片 |
| [GIT-R8-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 带引号路径在committed/dirty摘要中重复计数 |
| [PLUGIN-R8-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 空引号命令参数消失并使后续位置左移 |
| [PLUGIN-R8-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | ARGUMENTS前缀抢先匹配完整命名placeholder |
| [PLUGIN-R8-03](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 已接受Windows marketplace路径派生非法name |
| [WEB-R8-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | 根项目不能匹配后代cwd ‡ |
| [WEB-R8-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/findings.json) | P3 | image/jpg alias提前返回跳过客户端每图大小检查 |
| [ATT-R9-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 空格工作区中的完整产物路径被截断成错误附件路径 |
| [COST-R9-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 独立CostTracker记录丢失完整模型标识并采用错误估价 |
| [SESSION-R9-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round9/findings.json) | P3 | 超工具调用上限的完成会话留下未配对持久化调用并阻断full fork |
| [DIAG-R10-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | DOM 限额遍历在队列截断前先枚举全部子节点 |
| [PET-R10-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | 并发搜索超过默认结果上限后静默丢行 |
| [PET-R10-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round10/findings.json) | P3 | Unicode 小写扩长后 snippet 不含命中词 |
| [CHAT-R11-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round11/findings.json) | P3 | 通知进度首次 load 失败的 rejected Promise 被缓存，同一 watcher 后续重试不再读取已恢复的 store |
| [TUI-R12-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | modifyOtherKeys 将非 Ctrl 大写文本降为小写 |
| [TUI-R12-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | KeyboardEvent 未将编码可打印键还原为字面字符 |
| [DESKTOP-R12-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | 工具卡摘要截断拆开 Unicode 代理对 |
| [PATCH-R12-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round12/findings.json) | P3 | 首个 Update chunk 省略可选 @@ 时丢失显式空白 context |
| [HIST-R13-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round13/findings.json) | P3 | 当前 session 新输入在 Up 历史导航中排在旧 session 后面 |
| [HIST-R13-02](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round13/findings.json) | P3 | 中断撤销后现有历史 navigator 仍返回被撤销输入 |
| [CHAT-R17-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round17/findings.json) | P3 | 显式 loopback HTTP 80 端口被配置生成器误判成缺少端口 |
| [REVIEWPROMPT-R19-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round19/findings.json) | P3 | /review 用法提示给出未被 parser 识别的 perf 维度名 |
| [ERROR-R22-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round22/findings.json) | P3 | 账单/配额 HTTP 429 原因丢失，被提示为临时限流 |
| [PRODUCT-R23-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round23/findings.json) | P3 | 公开运行工厂的 cwd 未作为提交运行的默认目录 |
| [OUTPUT-R25-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round25/findings.json) | P2 | 进度折叠使以 CRLF 结束的输出行正文消失 |
| [TUI-R26-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round26/findings.json) | P2 | 分支创建标记应按完整参数识别 |
| [RENDERER-R26-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round26/findings.json) | P3 | 多文件审查中不能单独选择根目录的 __all__ 文件 |
| [AGGREGATOR-R27-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round27/findings.json) | P3 | 隔离 DriveAgent 的变更链接丢失 cwd，打开父聊天文件 |
| [STREAMING-R28-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round28/findings.json) | P3 | 流式 Markdown 在代码块内部空行再次拆分已闭合围栏 |
| [MARKETPLACE-R37-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round37/findings.json) | P3 | 合法 local 市场名被误路由到直接本地插件卸载 † |
| [MCP-R38-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round38/findings.json) | P3 | 重开并保存 stdio MCP 表单时丢失参数数组边界 † |
| [MCP-R39-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round39/findings.json) | P3 | 重命名 MCP 服务丢失表单之外的受支持字段 † |
| [TRANSCRIPT-R42-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round42/findings.json) | P3 | 后台子代理转录把撤销当作封口，保留已经作废的部分回复 |

† 源码阶段更新：[正式44复核](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round44/evidence/source-status-review/review.md)；只覆盖原触发条件，不是整个功能或真实操作验证。

原始汇总：[111项历史目录](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round43/recorded-findings-catalog.json)。本稿仅整理已归档元数据，没有重新验证根因、去重、产品源码、测试或运行状态；没有给出仓库审查百分比。
