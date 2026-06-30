# 后台面板 / DriveAgent 问题修复清单

> 来源:会话 `s-mr04gdim-08c69a33` 日志诊断(engine + desktop bridge + 流事件)对照源码核实。
> 日期:2026-06-30。所有结论均有日志/代码证据,未改任何代码。
> ⚠️ Electron 改 renderer 必须 rebuild renderer + 重启 app 才能验证。

---

## #4 工具卡 args 显示 `{}`(真 bug,优先修,一行)

**现象**:主聊天里调用 `DriveAgent` / `DriveClaudeCode` 时,工具卡展开后 args 显示 `{}`,看不到 prompt / cwd / cli。

**真因(已确认)**:
- 引擎侧 args 完全正常:日志 `tool.exec.end` 里 args 是全的;流里也正常发了 `tool_use_args_delta`(args 是分两步来的:`tool_use_start` 先发空 `{}` 快照,再由 `tool_use_args_delta` 流入真正的 args)。
- `DriveAgent` 在卡片分发(`tool-cards/index.tsx`)里无专用匹配 → 兜底到 **`GenericToolCard`**。
- `GenericToolCard.tsx` **直接读裸 `message.args` 字符串**:
  - L17 `summarizeArgs(message.args)`(单行摘要)
  - L35 `prettyJson(message.args)`(展开详情 `<pre>`)
- 而 `message.args` 只是 `tool_use_start` 那一刻的快照 = `{}`(`types.ts:482`)。真正的 args 经 `tool_use_args_delta` 合并进了 `argsLive`(`types.ts:535`),`message.args` **从不回填**。
- 其他所有专用卡(Bash/Agent/File/Search/Web)都用 `parsedArgs(message)`(`utils.ts:29`,优先 argsLive 再回退解析 args 字符串),**唯独 GenericToolCard 漏了**。

**影响面**:不止 DriveAgent —— **每个落到 GenericToolCard 的工具**(非 bash/read/view/write/edit/grep/glob/search/web/fetch/agent/task)live 显示时 args 都会是 `{}`。

**修复**:`packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx`
- 改成用 `parsedArgs(message)` 取 args 对象,而不是裸 `message.args` 字符串。
- summary 和 details 两处都要改:
  - `summarizeArgs` 改成接收 object(或先 `JSON.stringify(parsedArgs(message))` 再喂进去)。
  - L35 `prettyJson(message.args)` → 用 `JSON.stringify(parsedArgs(message), null, 2)`。
- `detectAttachments(message.toolName, message.args, ...)` 也传的是裸 args,顺带核一下是否也该用 parsedArgs。

**注意**:commit `59301da7`("工具调用透传完整 args")**只修了 cc-room 路径**(messageMappers / resident-agent 透传 input),没碰主聊天通用卡这条路,所以那次修复后这里仍是 `{}`。

**验证**:rebuild renderer + 重启 → 主聊天调一次 DriveAgent → 展开工具卡确认能看到 cli/cwd/prompt/permissionMode。

**回归隐患**:replay(重开会话)时 `message.args` 来自持久 transcript 的 tool_use_start,可能本就带全 args(那时无 argsLive)。`parsedArgs` 已是 `argsLive ?? 解析(args)`,两种情况都覆盖,所以改动安全。顺手加一条 streamReducer/types 的测试覆盖 live 态。

---

## #2 / #5 后台 job 完成即消失、无结果、无详情(设计缺口)

**现象**:
1. 后台面板里 cc/codex 任务只显示一行 description + 脉冲点,**内容被省略,点不开看详情**。
2. 「只看见 codex」是时序假象,**不是过滤**:claude 和 codex 的 job 日志里都有(`DriveAgent(claude)` / `DriveAgent(codex)` 都被记录)。但完成的 job 会被立刻删掉,你看的时候 claude 那个多半已跑完消失,只剩还在跑的 codex。

**真因(已确认)**:
- `packages/core/src/tool-system/builtin/background-jobs.ts`:`finish(jobId)` **直接 `this.jobs.delete(jobId)`(L47)** —— job 只在运行期存在,**完成即蒸发,不留历史**。
- `BackgroundJobEntry` **只有 `jobId / sessionId / description` 三个字段,根本不存结果**。结果只进了 `notificationQueue`(`drive-claude-code.ts:91-96`),作为下一轮注入的 `<background-agents-completed>` system-reminder 给模型,**从不回到面板**。
- 渲染侧 `BackgroundShellPanel.tsx` 的 "job" 类(L263-283)只渲染单行 `truncate` description + 脉冲点,**无展开、无 detail view、无结果**。只有 "shell" 类(L368-383)点击可展开看完整输出。

**修复方向(需先拍方案)**:
- **保留完成的 job 一段时间 + 存结果**:`background-jobs.ts` 不在 `finish` 时删,改成标记 `status: completed/failed` + 存 `finalText` / `ccSessionId`,面板可见已完成项。需考虑何时清理(turn 结束?数量上限?)。
- **job 可展开看详情**:`BackgroundShellPanel.tsx` 给 "job" 类加点击展开,展示 finalText（对齐 shell 输出的展开区交互）。
- **保留 cli 标识**:description 已是 `DriveAgent(claude/codex): ...`,展开时可解析出 cli 显示徽标。

**相关文件**:
- `packages/core/src/tool-system/builtin/background-jobs.ts`(registry 数据结构 + finish 行为)
- `packages/core/src/tool-system/builtin/drive-claude-code.ts`(L82-105 后台启动 + 完成回调,结果在这里有 `r.finalText`)
- `packages/core/src/tool-system/builtin/background-work.ts`(`agent/backgroundWork` 统一列表 RPC)
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`(L263-283 job 渲染)
- 类型:`packages/desktop/src/preload/types.d.ts`(`BackgroundWorkInfo`,L49-61)

---

## #1 刷新无 spinner / 不知道刷没刷(体验缺口)

**现象**:点后台面板顶部刷新按钮没有任何视觉反馈,不知道刷新了没有。

**真因(已确认)**:`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`
- 刷新按钮(L195-203)`onClick={() => void refresh()}`,但 **顶部按钮本身无 loading 态**。
- 唯一的 `loading` 文案 `读取中…` 只挂在 **单条 shell 输出的展开区**(L370-371),不是整面板。
- 面板本就有自动刷新(turn 结束 `codeshell:files-changed` 触发 L79-83 + 有任务在跑时每 3s 轮询 L155-167),手动按钮存在感更弱。

**修复**:给刷新按钮加 loading 态 —— 点击时 `RefreshCw` 图标转圈(`animate-spin`)直到 `refresh()` resolve;或加个短暂的成功反馈。用现有 `loading` state 或新加一个 `refreshing` state 驱动。

---

## #3 / #5 goal 是否还在工作不可见(可见性缺口)

**现象**:对话进行中不知道 goal 还在不在 work。

**真因(已确认)**:goal **功能正常**——日志 `goal_stop.waiting_on_background_task` 反复触发,每次后台任务完成都唤醒引擎(`engine.run` @06:08、@06:11)继续跑 turn,stop-hook 一直在挡。**问题是没有 UI 告诉用户「goal 还在、正等后台任务」**。

**附带小瑕疵**:`05:56:55` 有一次 `goal_stop.unparseable`(`relevance-judge.ts:40` 那条 fallback)——goal 裁判有一轮输出没解析成功,回退 continue。偶发,不影响主流程,但值得留意是否要更鲁棒的解析。

**修复方向(需拍方案)**:
- 在 StatusPopover / 顶栏的 Goal 区块里显示 goal 当前状态(active / 等后台任务 N 个)。复用现有 goal 状态展示组件。
- 后台 job 结果不回卡(见 #2/#5)也属同一可见性问题,可一起设计。

---

## 修复优先级建议

| # | 问题 | 性质 | 改动量 |
|---|------|------|--------|
| **4** | args 显示 `{}` | **真 bug** | 一行级(GenericToolCard 用 parsedArgs) |
| **1** | 刷新无 spinner | 体验 | 小(按钮加 loading 态) |
| **2/5** | job 完成即消失、无结果详情 | 设计缺口 | 中(registry 存结果 + 面板可展开,需拍方案) |
| **3/5** | goal/后台结果不可见 | 可见性 | 中(状态展示,需拍方案) |

#4 最划算:一行级改动,且顺手修好所有落到通用卡的工具。建议先修 #4(+#1),#2/#3 偏设计取舍先拍方案。

---

# 追加(2026-06-30 第二批):已编辑文件只显示一个 + 生成图片 link 点不开

---

## #6 完成任务后「已编辑文件」只显示一个(不是 aggregator 的 bug,是后台外部 agent 的盲区)

**现象**:goal 跑完一个大任务后,文件变更摘要只列出一个文件,实际改了多个。

**真因(日志已确认,推翻"streaming race"猜测)**:
- 用日志核实:会话 `s-mr04gdim-08c69a33` 自己只跑了**一个** edit 工具——`Write docs/core-deep-dive/README.md` @06:22:14。其余文件全是 **backgrounded 的 Claude Code / Codex(DriveAgent 任务)改的**,它们的 Edit/Write 调用在**外部 CLI 自己的 transcript 里,根本不在本会话的 transcript**。
- `fileChangeAggregator.ts` 只扫**本会话自己的 `tool` 消息**(L298-311 从最后一条 user 消息往后遍历)。外部 agent 的编辑从不产生本会话的 `tool` 消息——只有一个不透明的 `DriveAgent` 工具调用 + 一条完成通知。
- 所以摘要"正确地"只显示了本会话自己改的那一个文件。其余文件**对宿主 UI 完全不可见**(无 diff、无计数、无文件名)。
- aggregator 本身**没有 bug**:parseArgs 优先 argsLive、按 path 去重进 Map、MultiEdit/ApplyPatch 多文件都正确处理。(有 subagent 报告说是 argsLive streaming race 导致 path 为空被 skip——但那只会在 turn_complete 之前发生,turn_complete 时 args 早已流完,且日志显示本会话本就只有一个 edit。这个猜测不成立。)

**本质 = 和 #2/#5 同一个架构盲区**:backgrounded 外部 agent 的工作对宿主 UI 不透明,它们碰过的文件没有任何地方surface。

**修复方向(需拍方案,与 #2/#5 一起设计)**:
- DriveAgent 完成通知里其实带了 `ccSessionId`(`drive-claude-code.ts:93-94`)。可以读外部 CLI 的 transcript(`~/.claude/projects/<cwd>/<ccSessionId>.jsonl` / codex 的 rollout)解析出它改了哪些文件,回填进本会话的文件变更摘要 / 后台 job 详情。
- 或者至少在 DriveAgent 工具卡 / 后台 job 详情里展示"该外部任务编辑了 N 个文件: …"。
- 相关:`packages/desktop/src/renderer/messages/fileChangeAggregator.ts`(本会话聚合,不用改)、`drive-claude-code.ts`(完成回调有 ccSessionId)、外部 transcript 读取参考 `cc-orchestrator/`。

**注意**:如果某次确实是本会话自己改了多个文件却只显示一个,那才是另一个真 bug,需要另抓日志复现(本次不是)。

---

## #7 生成图片渲染出 link 但点击打不开(真 bug,decodeLocalPathHref 误杀 dot 开头目录)— ✅ 已修(2026-06-30,未 rebuild 验证)

**现象**:生成图片后,回答里渲染出一个图片链接,点击没反应、打不开。

**真因(已用脚本复现确认)**:
- 生成图片存在 **`<cwd>/.code-shell/generated_images/<timestamp>.png`**(`generate-image.ts:11`),工具返回**绝对路径**。
- 渲染链路:`Markdown.tsx` 的 `a` 渲染器(L153-210)先用 `decodePathHref`/`decodeLocalPathHref`(`markdown/remarkPathLinks.ts`)判断 href 是不是路径;是图片路径就渲染成 `InlineImageLink` 缩略图(点击开 Lightbox / 文件名开文件);不是路径就退化成普通 `<a>`,而那个 `<a>` 的 onClick **只处理 `http(s):`**,本地路径点了**什么都不做**(L191-205)。
- **bug 在 `decodeLocalPathHref`(remarkPathLinks.ts:325-326)**:
  ```ts
  const bareLocal = /^[\p{L}\p{N}_@.-]+\//u.test(pathPart) && !firstSeg.includes(".");
  ```
  那个 `!firstSeg.includes(".")` 本意是排除域名形状的首段(`example.com/`),**但它把 dot 开头的合法本地目录也误杀了**——`.code-shell/`、`.github/`、`.config/` 全中招。
- **实测复现**(脚本验证):
  | href | 结果 |
  |------|------|
  | `/abs/.../.code-shell/generated_images/x.png`(绝对) | ✅ 识别 |
  | `.code-shell/generated_images/x.png`(相对,首段含点) | ❌ **null → 死链** |
  | `generated_images/x.png`(相对无点) | ✅ 识别 |
  | `x.png`(裸文件名无斜杠) | ❌ **null → 死链** |
  | `./generated_images/x.png` | ✅ 识别 |
- 所以当模型用**相对路径引用 `.code-shell/generated_images/...`**(生成图的标准位置,首段 `.code-shell` 含点)或**裸文件名**引用时,链接不被识别 → 渲染成死 `<a>` → 点击无反应。

**两个失败形状**:
1. 首段 dot 开头目录(`.code-shell/...`)——最可能命中,因为生成图就在 `.code-shell/` 下。
2. 裸文件名无斜杠(`x.png`)——`bareLocal` 正则要求有 `/`。

**修复**:`packages/desktop/src/renderer/markdown/remarkPathLinks.ts:325-326`
- 收窄"域名形状"判定:不要用 `!firstSeg.includes(".")` 一刀切。改成只在首段**像顶级域名**时才排除(例如 `firstSeg` 匹配 `xxx.com/.io/.org` 这种已知 TLD 形状,或"无路径分隔且含点且不以点开头"),放行 `.code-shell` / `.github` 这类 dot-prefix 目录。
- 顺带考虑裸文件名(无 `/`)+ 图片扩展名的情形是否也该识别(可能影响面更大,先评估)。
- `attachments.ts` 的 `PATH_RE`(L46-50)是另一套独立匹配器(用于工具结果文本),核一下是否同病。

**验证**:rebuild renderer + 重启 → 生成一张图 → 让回答用相对路径 `.code-shell/generated_images/...` 引用 → 确认渲染成缩略图且可点开 Lightbox。加 `remarkPathLinks` 单测覆盖 `.code-shell/x.png` / `.github/x.md` 应被识别、`example.com/x.html` 仍被排除。

**关联记忆**:`[[project_cjk_path_regex_w_bug]]`(同文件 CJK 正则坑)、`[[project_inline_code_path_links]]`(反引号路径可点)。

---

## 更新后的优先级

| # | 问题 | 性质 | 改动量 |
|---|------|------|--------|
| **4** | 工具卡 args 显示 `{}` | 真 bug | 一行级 |
| **7** | 生成图 link 点不开(.code-shell 被误杀) | 真 bug | 小(收窄域名判定正则) |
| **1** | 刷新无 spinner | 体验 | 小 |
| **6** | 后台外部 agent 改的文件不显示 | 架构盲区(同 #2/#5) | 中,需拍方案 |
| **2/5** | job 完成即消失/无结果详情 | 架构盲区 | 中,需拍方案 |
| **3/5** | goal/后台结果不可见 | 可见性 | 中,需拍方案 |

真 bug 是 **#4、#7**(都小,可直接修)。#6 与 #2/#5/#3 都是同一个根:**backgrounded 外部 agent 对宿主 UI 不透明**——建议合并成一个"后台外部任务可观测性"设计一起做。

---

## #8 定时任务总是起一个全新 session,无法"在同一 session 里继续做"(设计缺口,需拍方案)

**现象**:让"3点继续做",定时任务到点会**重新起一个新 session** 来跑,和预期不符。预期是:有些定时任务应该能**在原 session 里接着做**(带上原对话的上下文/goal/已设置的外部 resume)。

**真因(日志 + 源码已确认)**:
- 日志:本会话 @06:54 `CronCreate` 创建了 "3点续跑 Codex v2 配图"(`0 3 * * *`, `once:true`, prompt="继续 …"),后又改成 @07:06 的 15 点版。args 里**只有 name/schedule/prompt/timezone/cwd/permissionLevel/once**,没有任何 session 绑定。
- `packages/core/src/tool-system/builtin/cron.ts`:CronCreate 的 schema **根本没有 `sessionId` / `resumeSessionId` / `continueInSession` 字段**。
- `packages/core/src/automation/scheduler.ts`:`CronJob` 接口也没有 session 字段(只有 id/name/schedule/prompt/cwd/timezone/permissionLevel/lastRunId/once)。
- `packages/core/src/automation/runner.ts`:cron 执行器(`bindCronToRunManager` L101-114 / `bindCronToEngine` L62-75)**每次 fire 只拿 `job.prompt` + `job.cwd` 提交一个全新 run**——`runManager.submit({ objective: job.prompt, cwd })`,**没有任何 resume/续接 session 的概念**。
- 所以 agent 想"继续做"只能把"继续 …"写进 prompt,但那个 prompt 跑在一个干净 session 里:**没有原对话 transcript、没有原 goal、没有它之前设好的 DriveAgent `resumeSessionId`(7e7a7bb9-…)**。这正是 [[project_cc_orchestrator]] 记的铁律"CC 侧无时间,所有定时/续接裁决在 codeshell 层"留下的缺口——codeshell 层目前也没给 cron 提供续接能力。

**需要先拍的设计决策(两种"session"别混)**:
1. **续 codeshell 自己的聊天 session**(这次观察到的"新 session"):cron fire 时 resume 指定的 codeshell session,把新 prompt 作为新一轮 user 消息追加进原对话(带 transcript/goal/上下文)。需要:CronCreate 加 `resumeSessionId`(默认空=老行为新建)+ CronJob 存它 + executor 走 resume 而非 submit-new。坑:原 session 可能已被用户关闭/在用,要定义"续接已关闭 session"和"session 正忙"的语义(参考 [[project_send_input_concurrency_gap]] 的并发守卫)。
2. **续外部 CLI session**(claude/codex 的 DriveAgent 工作):其实已可做——agent 可以把 DriveAgent 返回的 `resumeSessionId` 写进 cron prompt,让新 session 里的 DriveAgent 带 `resumeSessionId` 续外部工作。但这依赖 agent 自己记得传,且外部续接 ≠ 原 codeshell 对话续接。可能只需把这个用法写进 CronCreate 描述里引导。

**建议**:大概率你要的是 #1(在原 codeshell session 里继续)。这需要决定:
- 默认行为保持"新建 session",还是给 CronCreate 一个显式的"在当前/指定 session 继续"开关?
- "继续"时如果原 session 已关闭/不在内存,是冷启动 resume(从磁盘 transcript 回灌,参考 [[project_goal_rehydrate_on_load]] [[project_disk_authoritative_recovery]])还是降级为新建?
- 是否要区分"一次性提醒"(新 session 合理)vs"接着干同一件事"(应续接)?

**相关文件**:`cron.ts`(工具 schema)、`scheduler.ts`(CronJob 存储 + create/update)、`runner.ts`(executor:submit-new → 改成可 resume)、RunManager/Engine 的 resume 路径、desktop 侧 cron UI(若要暴露开关)。

**优先级**:设计缺口,改动中等且涉及 session 生命周期语义,**先拍方案再动手**。

### 已拍方向(2026-06-30,用户决策)
- **续哪个**:续**原 codeshell 对话 session**(不是续外部 CLI)。cron fire 时 resume 指定的 codeshell session,把新 prompt 作为新一轮 user 消息追加进原对话,带上原 transcript / goal / 上下文。
- **默认行为**:**默认仍新建 session**(保持现有定时行为不破坏);**只有显式传 `resumeSessionId`(或"在当前 session 继续"开关)时才续接**。不做"按 prompt 语义猜是否续接"。
- **落地草案**:
  1. `cron.ts`:CronCreate schema 加可选 `resumeSessionId`(描述:留空=新建 session 跑;填=到点续接该 codeshell 对话,带原上下文)。agent 在用户说"在这个对话里继续/接着做"时,把**当前 session id** 传进去。
  2. `scheduler.ts`:`CronJob` + `CreateJobOptions` + `UpdateJobPatch` 加 `resumeSessionId?`。
  3. `runner.ts`:executor 分支——有 `resumeSessionId` 走 resume 路径(把 prompt 作为新 user 轮注入已存在/从磁盘回灌的 session),无则走现有 `submit` 新建。
  4. **边界语义**(必须处理):原 session 已关闭/不在内存 → 从磁盘 transcript 冷启动回灌(参考 [[project_goal_rehydrate_on_load]] [[project_disk_authoritative_recovery]]);原 session 正忙 → 并发守卫,别两个 Engine 交错写同一 transcript(参考 [[project_send_input_concurrency_gap]],至少 running 时排队或拒绝)。
  5. desktop 侧:若要让用户手建定时也能选"续当前对话",cron UI 加一个开关(可后置)。

---

## #9 自主跑多轮后,「已编辑文件」只显示最后一轮的内容(真 bug,与 #6 不同)

**现象**:自主连续干了好多轮后,文件变更摘要只列出**最后一轮**编辑的文件,前面几轮改的看不到。

**与 #6 的区别**:#6 是"文件被**外部 agent**(DriveAgent)改的、不在本会话 transcript";**#9 是本会话自己跨多轮改的文件,也只显示最后一轮**——这是 aggregator 的作用域 bug,不是外部 agent 盲区。

**真因(日志 + 源码已确认)**:
- `fileChangeAggregator.ts` 的 `aggregateFileChangeSummary`(L268-274)**只从最后一条 `user` 消息往后扫**(倒着找到第一个 `kind==="user"` 就停,扫 `start+1 → end`)。即:它只聚合**一个 user-turn 的编辑**。
- `types.ts:896` 在每次 `turn_complete` 重算这个摘要;`turn_complete`(engine.ts:2260)**每个 `engine.run` 发一次**(不是每个内部 turn——内部 `turn.end` 一个 run 里发很多次,但 `turn_complete` 一个 run 只发一次)。
- **关键**:自主任务会跨**多个 `engine.run`**(每次唤醒/续跑/被 steer 都是一段),而**每段在 desktop 上都对应一条新的 `user` 消息**:
  - 普通续跑/唤醒 = 新 `engine.run` → 新 user 轮;
  - `steer_injected`(types.ts:418-423)直接 `appendUserMessage` 插一条 user 消息。
- 所以 `files_changed` 卡是**每 user-turn 一张、只扫最后一条 user 消息之后**。跨多轮自主任务时,只能看到**最后一段 `engine.run` 的编辑**。

**日志实证**(会话 `s-mr04gdim-08c69a33`,本会话自己的编辑分散在多个 run):
```
06:22  Write  README.md                     (engine.run @06:21:38)
07:39  Edit   README.md                     (engine.run @07:39:03)
07:52  Edit   v2-01-core-as-agent-harness.md ×6   (engine.run @07:51:24)
07:53-54  ApplyPatch ×3                      (同上 @07:51:24 那段长自主循环)
```
最后一段 run(07:51:24)的 `turn_complete` 只聚合了 v2-01 的编辑 + 3 个 ApplyPatch,**前面 06:22 / 07:39 改的 README.md 被排除**(它们在更早的 user 轮里)。共 25 个 `engine.run` 边界,编辑横跨好几段。

**这是设计作用域问题**:`files_changed` 卡本就定义为"自上条 user 消息以来"。对**自主 / goal 驱动**、会跨多个 user-message 边界(唤醒、续跑、steer)的任务,这个作用域太窄;而且目前**没有任何累计视图**——Files/Review 面板是另一套(走 git),`files_changed` 卡是唯一的"本轮编辑"来源。

**修复方向(需拍方案)**:
- 选项 A:让聚合作用域跟随**逻辑任务**而非单个 user 轮——例如一个持久 goal 期间的所有 `engine.run` 算同一组(按 goal 生命周期或 turnSeq 聚合,参考 [[project_undo_turn_level]] 的"一次 user 发送=一轮"和 [[project_goal_mechanism_wiring]])。难点:如何界定"同一逻辑任务"的起止(goal 设定→complete_goal?用户手动发的新指令该重置吗?)。
- 选项 B:保留每轮卡,**另加一个会话级/任务级的累计"本任务共编辑 N 文件"汇总**(不替换每轮卡,叠加一个累计视图)。
- 选项 C:`steer_injected` 不该重置文件聚合边界——区分"真用户新指令"vs"steer 注入/唤醒续跑",后者不算 user-turn 边界(给 user 消息打 origin 标记,aggregator 扫到 `origin:steer/wakeup` 的 user 消息不停步)。这条最小、最对症。

**关联**:与 #6 合看——#6 是外部 agent 的编辑不可见,#9 是本会话跨轮编辑被截断,两者都让"这次任务到底改了哪些文件"看不全。可在同一个"任务级文件变更总览"设计里一起解决。

**相关文件**:`packages/desktop/src/renderer/messages/fileChangeAggregator.ts`(L268-274 作用域)、`types.ts`(L830-912 turn_complete 重算 + L418-423 steer_injected 插 user 消息 + L1017 appendUserMessage)。

**优先级**:真 bug,但修法涉及"逻辑任务边界"语义,**先拍方案**(选 C 最小可先做)。

---

## #10 浏览器新标签页 localhost 端口探测刷控制台报错(设计放错进程,非 bug)

**现象**:打开浏览器面板新标签页时,DevTools 控制台刷一长串
`GET http://localhost:<port>/ net::ERR_CONNECTION_REFUSED` 和 `403 (Forbidden)`,
端口涵盖 3000/5000/5173/.../1313 整张候选表。

**真因(已确认)**:`packages/desktop/src/renderer/browser/useLocalhostPorts.ts`
- 用「发 HTTP `fetch`」当端口扫描器。renderer 受浏览器沙箱限制开不了原始 TCP socket
  (注释 L3-5 自承),只能 `fetch(http://localhost:<port>, {mode:"no-cors"})` 探测。
- 对没人监听的端口 → TCP 被 RST → 浏览器记 `ERR_CONNECTION_REFUSED`;对有服务但拒探测的
  端口(5000/7000)→ `403`。这些失败**代码里 `catch {}` 吃掉了**(L21-23),逻辑没问题,
  但浏览器网络层在 `catch` 之前就把失败请求打进 DevTools——`catch` 拦 JS 异常,
  **拦不住浏览器自己的网络日志**。所以报错 ≠ bug,是「拿 L7 请求探 L4 端口」的副作用。

**附带设计问题**:
1. **进程放错**:端口探测本该在 main 进程用 `net.connect`(能开 socket、失败不进 DevTools、
   无 403 误报),却放在 renderer 用 fetch。
2. **误报/漏报**:`no-cors` 拿到 opaque response **读不到状态码**,所以 `403`(端口有服务但
   不是 dev server)也被当「端口在线」推荐 → 误报;某些 dev server 拒裸 fetch → 漏报。
   它只验证了「有 TCP 在听」却当成「这是个能打开的 dev server」展示。
3. **硬编码端口表**(L6-8,14 个端口):既不全(用户起 :4321 就漏)又浪费(每次全量 fetch)。
4. **探测时机**:`useEffect(…, [])` 面板挂载即跑,即使用户没看新标签页。

**修复方向(需拍方案)**:把端口发现整体下沉到 main——
- 最小:main 加 `net.connect(port)` 真 TCP 探测 + preload 暴露 + renderer 改调它(三处),
  彻底不产生 DevTools 网络日志、无 403 误报。
- 更彻底:main 直接枚举系统监听端口(macOS `lsof -iTCP -sTCP:LISTEN` / `netstat`),
  不用猜端口表,有什么列什么。renderer 纯展示(符合本仓库「renderer 是 thin client、
  不碰底层」的架构约定,见 packages/desktop/CLAUDE.md)。

**相关文件**:`packages/desktop/src/renderer/browser/useLocalhostPorts.ts`(探测逻辑)、
`BrowserPanel.tsx`(L277 `NewTabLanding` 消费)、`packages/desktop/src/preload/index.ts`(若要暴露 main 探测)、
`packages/desktop/src/main/index.ts`(若加 net.connect 探测)。

**优先级**:**非 bug,纯控制台噪音 + 功能正常但不精确**。改动量小~中(下沉到 main),
但优先级低于真 bug。临时可在 DevTools 控制台过滤框输 `-useLocalhostPorts` 屏蔽。
