# 剩余模块补审：问题优先队列与覆盖记录

本轮新增 **33 项：1 P1、26 P2、6 P3**。已按优先级及数据/任务影响排序，未修复产品。全部发现都有对应源码位置、触发条件、正常/失败对照和证据层级；seam、SDK、静态UI调用链与真实PTY/浏览器/子进程结果分别标明。

审查基线：CodeShell `62a58ac8702835f848108e152234a6bdd6c3eb3f`，Panel Apps `aabba34ca94f7081fd7de4e20c52443f08f36d5e`。本次未改动本地 main、其他任务和旧冻结工作区，产品代码零改动；报告在独立 review 分支。交付时本地 CodeShell main 已由其他任务前进至 `3b3e7ba1`，本轮发现仍以冻结基线为准，未宣称验证这些后续提交。

**先处理 N01 的消息持久接受，再并行修 N02–N08 的预算/数据完整性。** 角色/策略组合、凭据刷新、运行与退出生命周期随后推进。P3按可恢复和低启用范围排后。旧86项的 [原优先队列](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/priority-and-coverage.md) 保持冻结；旧R35是原报告P1，但本轮未把旧86全部在新基线复测，不能将新旧数量相加当作当前main验证结果。

## 按优先级的完整新增清单

| 编号 | 级别 | 问题、触发与影响 | 主位置 | 详细证据 |
| --- | --- | --- | --- | --- |
| N01 | P1 | **Slack/钉钉确认了未被持久接受的消息**。队列已满或落盘失败仍 success ACK；应用没有该消息的重试副本，原平台消息仍可手动重发。 | [lifecycle.ts:17](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/lifecycle.ts:17) | [C2](coding-tui-chat.md) |
| N02 | P2 | **Anthropic 透明重试保留失败输出并漏计已知用量**。流已输出后 overloaded 重试成功；Web/TUI留失败前缀，Goal=6时已知物理14tokens仍再发送。两种影响合并1项。 | [anthropic.ts:189](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/llm/providers/anthropic.ts:189) | [C4](core.md) |
| N03 | P2 | **Design失败批处理仍删索引页，下一次保存落盘**。先delete_page再无效rename返回错误；cache未回滚，12页变11，dirty仍false，随后save持久化。 | [app.js:7457](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/app.js:7457) | [D1](design.md) |
| N04 | P2 | **Design打开索引分片迟到覆盖新编辑**。打开另一文档等待part时在当前文档编辑；resolver后缺revision复核，返回覆盖新文字。 | [app.js:3986](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/app.js:3986) | [D2](design.md) |
| N05 | P2 | **Job简历保存切项目后继续写到新项目**。readText期间A→B，PROJECT_CHANGED被当缺文件吞掉；用A文件名写B正文/证据。限不存在同名文件。 | [app.js:11893](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:11893) | [QJ-02](quant-job.md) |
| N06 | P2 | **Quant交易保存回执丢失后重复记账**。既有账本写入已提交但ACK丢失；保留表单重试生成新交易ID，100股→200股。 | [portfolio-store.mjs:144](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/quant-lab/app/portfolio-store.mjs:144) | [QJ-01](quant-job.md) |
| N07 | P2 | **Job第81条岗位静默淘汰旧投递进展**。新增后slice(0,80)删除末尾旧岗位及结构化备注，简历jobId仍指旧项，返回projectSaved:true。 | [app.js:14327](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:14327) | [QJ-04](quant-job.md) |
| N08 | P2 | **Notebook替换正文丢掉metadata和cell id**。replace新建cell而非保留属性；tags/id/attachments丢失，4.5格式也不补必需id。 | [notebook-edit.ts:105](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/tools/notebook-edit.ts:105) | [C10](coding-tui-chat.md) |
| N09 | P2 | **子代理冷续接丢掉原角色的额外限制**。进程registry消失后原角色不在Session持久状态，续接落回general-purpose。父级基础限制仍在；registry-reset seam证据。 | [agent.ts:1425](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/tool-system/builtin/agent.ts:1425) | [C3](core.md) |
| N10 | P2 | **Hook改参后未重验plan与MCP参数策略**。可信pre_tool_use normalizer改变最终参数，先前计划只读/同server禁用工具检查不重跑。仅fakehandler；不声称防恶意hook隔离。 | [executor.ts:382](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/tool-system/executor.ts:382) | [C1](core.md) |
| N11 | P2 | **AgentCancel缺少直属会话归属核对**。另一会话的全局registry child可被当前内建工具取消；真实注册+fakechild，未运行真实子代理。 | [agent.ts:1262](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/tool-system/builtin/agent.ts:1262) | [C2](core.md) |
| N12 | P2 | **authCommand令牌被SDK实例永久缓存**。resolver缓存已换新token，同一OpenAI/Anthropic SDK仍发旧header，新实例才恢复。未运行真实命令/等待真实到期。 | [openai.ts:330](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/llm/providers/openai.ts:330) | [C5](core.md) |
| N13 | P2 | **Run冷恢复未向执行器传用户答案**。waiting_input无livehandle时答案仅写run_resumed事件；fresh EngineRunner仍只跑原objective。覆盖RunManager SDK及TUI managed-run CLI，不外推Desktop审批。 | [RunManager.ts:299](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/run/RunManager.ts:299) | [CL1](core-lifecycle.md) |
| N14 | P2 | **Codex运行中退出后done永久pending**。turn已接受再进程退出，failAll只拒绝RPC，不结束activeTurn；新发送busy，关闭runtime可恢复。 | [app-server-client.ts:272](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/codex/app-server-client.ts:272) | [C1](coding-tui-chat.md) |
| N15 | P2 | **LSP启动失败可使Host退出或遗留子进程**。spawn error无监听导致Node退出；initialize失败的活child未纳入manager，shutdownAll无法清理。合并启动生命周期1项。 | [client.ts:48](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/client.ts:48) | [C4](coding-tui-chat.md) |
| N16 | P2 | **LSP缓存死客户端且并发启动误报不可用**。子进程自然退出仍isAlive；并发get固定等2秒，2.2秒合法初始化使第二次返回undefined。 | [manager.ts:42](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/manager.ts:42) | [C5](coding-tui-chat.md) |
| N17 | P2 | **Claude关闭只发TERM便返回**。owned忽略TERM子进程在close返回700ms后仍活着，done仍pending；缺等待/升级终止。未运行真实Claude。 | [runtime.ts:223](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/claude-code/runtime.ts:223) | [C6](coding-tui-chat.md) |
| N18 | P2 | **Chrome native未认证连接阻塞Desktop退出**。已accept但未完成握手的owned本地TCP peer不在client集合；server.close持续等，quit未执行；关闭peer即完成。 | [chrome-native-server.ts:88](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-native-server.ts:88) | [N01](hosts.md) |
| N19 | P2 | **首次TUI引导Ctrl+C退出界面但进程不结束**。实际PTY下Ink已unmount且raw=false，外层promise/keepAlive仍pending；Esc正常退出。 | [onboarding-runner.tsx:16](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/tui/src/ui/onboarding-runner.tsx:16) | [C7](coding-tui-chat.md) |
| N20 | P2 | **Telegram白名单检查晚于附件下载落盘**。实际adapter先getFile/download/spool，再gateway拒绝发送者；无模型接受但已做附件工作。owned HTTP协议替身。 | [chat-gateway.ts:162](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/chat-gateway.ts:162) | [C3](coding-tui-chat.md) |
| N21 | P2 | **视频查询回执丢失后新key重复启动任务**。Host已接受但start抛错后清taskId及恢复键，当前页再查创建第二份running任务。实际模块DOM+fakeHost。 | [video-search.js:730](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/video-download/app/video-search.js:730) | [V1](root-and-video-download.md) |
| N22 | P2 | **Chat串行同目标队列重试被后消息越过**。maxPerTarget=1时A失败backoff，B先发送，再retryA；仅generic serial SDK合同，当前Mimi并发路径不承诺串行。 | [delivery-queue.ts:247](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/delivery-queue.ts:247) | [C8](coding-tui-chat.md) |
| N23 | P2 | **Notebook不能读取标准string source**。合法source为string时无条件.join报错，string[]正常；Jupyter官方格式对照见专项。 | [notebook-edit.ts:77](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/tools/notebook-edit.ts:77) | [C9](coding-tui-chat.md) |
| N24 | P2 | **Design前端导出永久丢掉完整textSource**。ellipsis导入保留完整textSource但HTML仅导出截断text，缺overflow映射，变宽也无法恢复后缀。 | [frontend-export.mjs:373](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/frontend-export.mjs:373) | [D3](design.md) |
| N25 | P2 | **Design前端导出遗漏项目字体资源**。有效fontRef及resourceDataUrls不生成font-face；新文档用fallback，加载同alias有效本地字体后宽度不同。 | [frontend-export.mjs:319](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/frontend-export.mjs:319) | [D4](design.md) |
| N26 | P2 | **Design中文首个长token缩窄不换行**。真实Inspector将frame宽200→50，中文长段仍一行19.2高；后续长token有正常拆分对照。 | [layout.mjs:65](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/layout.mjs:65) | [D5](design.md) |
| N27 | P2 | **Video Studio全源倒放丢首帧图层**。reverse把exclusive duration映射tick0，evaluator删图层；1帧clip唯一帧空，3帧[0,1,1]。实际MP4像素未验证。 | [clip-edits.ts:1079](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/video-studio/src/editor/clip-edits.ts:1079) | [V1](video-studio.md) |
| N28 | P3 | **并发自动dream重复消费cadence计数**。两个fire-and-forget pipeline同批启动dream，完成时重复减旧计数，飞行中新增session数被吞。无真实模型/记忆正文损失断言。 | [memory-orchestrator.ts:418](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src/services/memory-orchestrator.ts:418) | [CL2](core-lifecycle.md) |
| N29 | P3 | **Job同一批相同JD不去重**。匹配只看existingJobs看不到本批inserted；同批2项，分批正确1项。 | [job-opportunities.mjs:89](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/job-opportunities.mjs:89) | [QJ-03](quant-job.md) |
| N30 | P3 | **Design索引文档完整Undo仍显示dirty**。真实Meta+Z后文档与已保存内容deep-equal，cache表示差异仍显示未保存；无内容丢失。 | [app.js:1267](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/app.js:1267) | [D6](design.md) |
| N31 | P3 | **Design非目标标题被归到目标/需求**。非目标/Non-goals/Out of scope的短alias提前匹配，PRD handoff分类错误；没有真实Agent执行。 | [product-brief.mjs:29](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/product-brief.mjs:29) | [D7](design.md) |
| N32 | P3 | **Optimization Lab冷停止终态误为interrupted**。已失owner持久active快照stop只记标志，下一次get改interrupted；窄窗口，未证明继续执行/付费。 | [controller.ts:785](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/optimization-lab/src/controller.ts:785) | [O1](root-and-video-download.md) |
| N33 | P3 | **Arena git_show把对象引用放到路径参数**。git show -- HEAD:file无法取对象正文，直接git/read_file正常。私有保留源码，Host不加载。 | [context-tools.ts:226](/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/arena/src/context/context-tools.ts:226) | [A1](root-and-video-download.md) |

## 覆盖与证据

上一轮列出的模块均已有补审记录，具体深度及未执行边界见 [覆盖矩阵](coverage.md)。源码目录库存不等于逐行审查，测试数量不等于分支覆盖率。报告包含以下专项：

- [Core provider/hooks/agents/账本与41目录台账](core.md)
- [Core run/operations/profile/memory/sources/composition 生命周期](core-lifecycle.md)
- [Coding、真实TUI、Chat 12 adapter与Link独立包](coding-tui-chat.md)
- [Server/Desktop/Web与新账号差异](hosts.md)
- [Pet、Optimization Lab、Arena、CDP、打包与Video Download](root-and-video-download.md)
- [Video Studio及204文件审查深度台账](video-studio.md)
- [Quant Lab / Job Hunt HQ](quant-job.md)
- [Design Studio](design.md)
- [独立证据/级别/去重复核](evidence-audit.md)

主要正常控制包括：Pet 330通过；Video Download 147通过；Panel build 66通过；shared select 5通过；Quant/Job 300通过及16脚本；Design 30唯一用例通过。Video Studio默认1146通过、4跳过，扩展原生67通过、**6项画面渲染超时失败**。Core provider/auth为3通过7filtered及另5通过；Core生命周期90通过、237expect、0失败/跳过。Coding等自定义Bun7通过、native9观察、3次PTY运行。不同shard存在重复测试，不相加成唯一总数。

清洁安装后打包门禁验证9tarball、47类型入口、45runtime入口，packed auth/uploads合同通过。原始证据按字节归档，来源/大小/SHA-256见 [evidence-index.json](validation/evidence-index.json)；报告引用路径映射至本目录副本，原始作者报告另存 `validation/source-reports/`。首轮harness错误、修正和未采用候选保留，未把它们计作产品缺陷。通过测试表示稳定观察到当前缺陷与正常控制，**不表示问题已修复**。

## 仍有的验证边界

真实付费模型、外部账号/消息、Docker/公网relay/tunnel、移动设备、Windows/Linux/OS原生事件、真实自动更新/回滚没有启动。Video Studio超时的实际画面导出未验收。完整Core工具/所有UI与大型文件的全部分支仍需后续专项，具体列在覆盖矩阵；不宣称找到了所有可能问题。

部分命令/权限复现被平台内容检查中止，提示可能涉及网络安全风险；已停止相关动态实验，未换工具重试。相关已完成静态/seam证据及未覆盖边界保留在报告，不将其写成完整动态审计。
