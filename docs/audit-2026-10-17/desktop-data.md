# Desktop / Web 普通数据状态审查（2026-10-17）

冻结基线：`ab8b03f86ad38835939d4125b56bf4513cae7f15`；分支 `codex/audit/remaining-20261017`。本文件与 `evidence/ui-*` 为本子任务唯一写入范围；未改产品代码、Git 或依赖。

已读取 `CODESHELL.md` 与 `docs/audit-2026-10-16/findings.json`。前轮的 @ 文件搜索、Chrome decoder、MemoryStore pin 不在本轮范围。没有网络、认证、权限或原生进程实验。

## 第一轮：会话历史窗口 / 搜索

- 静态阅读：`app/mergeHistoryWindows.ts`、`automation/hydrateOrder.ts`、`automation/mergeTranscripts.ts`、`app/useSessionHistorySync.ts`、`shell/sessionContentSearch.ts`、`shell/useSessionContentSearch.ts`、`shell/SessionSearchModal.tsx`。
- 聚焦动态实验已完成：`evidence/ui-history-window.test.ts`，只调用源码相对导入的历史折叠/合并纯函数；测试持久用户意图的历史前缀、缓存中断回答、重复 legacy 文本边界。首跑完整输出见 `evidence/ui-history-window.log`；2 pass / 0 fail / 0 skip，guarded runner 确认完整完成。
- 搜索模块确认了 debounce 取消、A→B→A 请求身份与不可用磁盘结果禁用路径；此阶段未提出可确认的新问题。

## 第二轮：普通编辑 / 设置状态

已静态阅读 `App.tsx` 草稿与图片附件异步归属、`ChatView.tsx` 图片读取/压缩/暂存、`settings/AdvancedSections.tsx` 的自定义指令和回复偏好、`useTargetedDebouncedSave.ts`、`useSettingsResource.ts`、`settingsCache.ts`、`subagents/SubagentSessionDetail.tsx`、`SubagentNavigation.ts`、`panels/FilesPanel.tsx` 文件根/预览选择，以及评论编解码与其 UI 接线。

- 图片异步附件可能跨会话与个性化初始读覆盖编辑值，均已发现旧报告相关家族：`docs/review-2026-10-12/desktop-round1.md` D2/D5（含异步归属建议）、`settings-recovery-round16.md:41` 初始加载覆盖诊断。此处仅记继续审查的边界，不重复列新增发现。
- 第二轮独立纯函数实验 `evidence/ui-annotation-roundtrip.test.ts` 经 guarded runner 通过 2 pass / 0 fail / 0 skip，完整首跑日志 `evidence/ui-annotation-roundtrip.log`。确认一个新 P3 显示投影缺陷如下。

## UI-01 [P3] 多行本地评论发送后只显示首行，带冒号的续行被显示为定位字段

- 位置：`packages/desktop/src/renderer/chat/anchors.ts:146–154`；生产编码位置 `:173`。输入入口为 `chat/CommentBox.tsx:39–60` 的多行 Textarea；显示接线为 `MessageStream.tsx:489` → `messages/AnnotationsBlock.tsx:17–41`。
- 触发：对文件/审查/浏览器位置添加多行评论，例如 `第一行说明\n第二行必须保留\nreason: 该字段是评论内容`，随消息发送。
- 预期：发送后的本地评论卡完整保留评论的所有行及语义。
- 实际：生产 `encodeAnchorsForWire` 保留完整评论，但 `extractAnnotations` 按行解析，只把 `评论:` 当作单行字段。第二行无冒号被丢掉，第三行变成 locator `{ key: "reason", value: "该字段是评论内容" }`；显示评论只剩 `第一行说明`。
- 影响：历史消息里的用户评论被截断/误分类，用户复核先前要求时看到不完整甚至错误的定位信息。模型实际收到的 wire 保留全文，因此不声称请求文本或磁盘数据已丢失。
- 证据：`evidence/ui-annotation-roundtrip.test.ts` 相对导入并调用真实生产编解码；包含单行对照，完整输出见 `evidence/ui-annotation-roundtrip.log`。动态证据为纯函数投影，Textarea 与消息卡为静态可达接线，未运行 React/Electron UI。
- 旧记录核查：2026-10-16 findings 与 2026-10-12 主报告/remaining 报告及 `docs/archive/todo/review-ui-v2.md` 未检出 `extractAnnotations` / `encodeAnchorsForWire` / 多行评论同项（有限查重）。

## 第三轮：Web / Mobile 项目归属纯函数

静态阅读 `packages/web/src/lib/format.ts`、`app/drafts.ts`、`app/useLatestMessages.ts`、`app/MessageContent.tsx`、`app/DesktopApp.tsx` 的 cwd→project→新会话目标接线，以及 Mobile `components/SessionList.tsx`；没有执行网络或权限流程。对项目归属与分组执行独立纯函数实验：`evidence/ui-web-project-case.test.ts`，完整首跑日志 `evidence/ui-web-project-case.log`；3 pass / 0 fail / 0 skip。

## UI-02 [P2，条件触发] Web / Mobile 对 POSIX cwd 一律转小写，不同项目被合并并可能生成错误新会话目标

- 位置：`packages/web/src/lib/format.ts:18–20`；同长度候选只取首项 `:43–45`。
- 触发条件：连接大小写敏感文件系统的 Host（例如 Linux），已注册两个合法不同根 `/srv/Example` 和 `/srv/example`，大写根先列出，打开小写根或其子目录。
- 预期：`projectForCwd("/srv/example")` 返回小写项目；各项目会话分别分组。
- 实际：`isSameOrInside` 无条件把路径转小写，两根都匹配，同长度只保留首项。实际匹配为大写项目；反转列表则结果反转。实际 `groupByProject` 把两边会话归到一个 `Upper project` 分组。
- 影响：Web/Mobile 项目标题/过滤/会话归属错误。`packages/web/app/DesktopApp.tsx:117–121` 的生产 `targetForCwd` 还用这个结果构建 `{ projectId }`，小写 cwd 在错误项目中没有精确 root，因而会落入错误项目的主根作为新会话目标；这段影响是静态接线，未运行创建会话或真实 Host。Mobile `SessionList.tsx:50–63` 实际消费错误分组与 currentProject。
- 证据：guarded 源码相对导入纯函数，`evidence/ui-web-project-case.test.ts` 三项：错误归属/列表顺序影响、两个会话合成一组、普通不同根与最长前缀正常对照。没有使用真实磁盘或模拟 Host 平台来验证目录注册；结论明确以大小写敏感 Host 为条件。生产 `packages/core/src/workspace/canonical-key.ts:4,32–34` 只在 darwin/win32 小写化，Linux 的 ProjectStore 根比较保留大小写（静态核对）。
- 旧记录核查：2026-10-16 findings、2026-10-12 Web 主报告与 remaining 主报告未找到 `projectForCwd` / 项目大小写同项（有限查重）；SWC-06 是磁盘会话分页排序，与此处不同。

## 第四轮：历史尾窗口与上下文选择映射

`evidence/ui-context-tail-selection.test.ts` 使用隔离 runner 的自有 tmp 会话文件，真实 `getSessionTranscriptPage` / `getSessionEvents` reader、`foldTranscript` 与两个上下文选择纯函数。没有 fork、新建会话、模型调用或真实 IPC。完整首跑日志 `evidence/ui-context-tail-selection.log`；2 pass / 0 fail / 0 skip，自有 tmp 在 finally 删除。

## UI-03 [P2] 部分聊天历史窗口按位置匹配全量 raw turns，选择可见新任务却打包旧任务

- 主位置：`packages/desktop/src/renderer/MessageStream.tsx:710`（`selectionTurns[index]`）；提交 `:377–383` 把同一索引对应的 raw event 范围交给 `forkSession`。
- 触发条件：打开保留合法 legacy transcript、没有 output journal 的较长会话，聊天初始 512 KiB tail 未包括开头，未点击“更早历史”即进入上下文选择。生产 `app/useTranscriptBuckets.ts:221–242` 为两个持久投影读取 512 KiB，`app/outputJournalRecovery.ts:30–45` 对合法无 journal/cursor/snapshot identity 的 legacy 返回 null，沿现有 tail 路径继续；不是强行让现代完整 journal 失效。
- 预期：点击屏幕上 RECENT 新任务后，只打包该任务的 raw 范围，或者加载/对齐历史后允许选择。
- 实际：显示分组从当前 tail 的用户任务重新编号 0，`MessageStream.tsx:297–299` 又独立读取完整 raw events。从可见分组的 index=0 直接访问 raw `selectionTurns[0]`，实际得到 OLD 老任务。没有用 durable event/client identity 对齐或尾窗口 offset。
- 最小实测：自有 transcript 含两轮，一条旧回答大于 512 KiB。真实分页读 `hasMore=true / loadedBytes=524288`，显示首用户为 `RECENT visible task to forward`；真实 raw reader 返回两轮，按生产索引取得 `{ fromEventId: "old-user", toEventId: "old-boundary" }`，对应 `OLD confidential unrelated task`。完整可见 transcript 的第二轮对照正确。
- 影响：上下文包会总结/转交用户没有选中的旧任务，漏掉实际选中的新内容。测试没有实际执行 fork/provider，错误范围到 `forkSession` 的提交为静态可达接线；不声称已经创建、发送或泄露真实用户内容。
- 证据层级：真实 tmp 文件 + 真实 reader/折叠/选择纯函数动态；UI click 与 fork bridge 静态接线。完整日志与代码为 `evidence/ui-context-tail-selection.{test.ts,log}`。
- 旧记录核查：2026-10-16 findings、2026-10-12 context-recovery round17 及质量复核覆盖摘要失败/迟到回包，没有这个窗口索引失配项；remaining findings 未检出同项（有限查重）。

## 第五轮：相邻普通 UI 的静态边界检查

补充选择性阅读 `packages/web/app/HubSessions.tsx:1–260`（历史页状态/焦点/请求身份）、`HubFiles.tsx:1–195`（目录/预览请求取消、切目录重置、定位）；Desktop `messages/time.ts`、`messages/CollapsibleContent.tsx`、`messages/agentGroup.ts`、`messages/streamGroups.ts` 关键纯状态路径、`transcriptsReducer.ts` hydrate 分支和 `sessionPersistence.ts:1–190`。另读 Core `turn-loop.ts` 已有 steer 与 turn_boundary 持久化段以排除误把模型内部 continuation 当新用户任务；没有运行 Core/Engine。

- HubFiles 目录/文件请求均有 AbortController 迟到回包检查，changeFolder 先取消预览，未确认新问题；本轮没有真正请求 API。
- 上下文选择的正常完整窗口有动态对照；steer 在 fold 层标 injected，不能简单把每条 raw role=user 都当用户任务差异来发布问题。
- draft 返回/保存失败家族、图片暂存归属家族在旧报告已有相关记录，未重复执行旧实验。
- 上述读段不是完整 Web/设置/持久化实现验收；没有借静态阅读扩大动态覆盖声明。

## 补充旧记录查重

`evidence/ui-dedup-scan.json` 保存对 2026-05-30 三份旧 JSON（findings / confirmed / backlog_confirmed）、2026-10-12 remaining findings、2026-10-16 findings 的结构化关键词查重；三项主函数/索引关键词与多行评论关键词未命中已有条目。这是有限文字查重，不能代替语义穷举。与前述 2026-10-12 Markdown 主报告阅读共同构成旧记录依据。

## 执行收据

4 个独立 guarded 首跑 shard，合计 9 tests / 25 expect / 0 fail / 0 skip。全部完整日志保留，无动态实验失败、修支架或重复运行。`evidence/ui-source-manifest.json` 记录证据哈希、17 个关键生产源码哈希，均逐字节匹配冻结 Git blob。

## 边界 / 尚未覆盖

未运行 Electron、浏览器 UI、真实 IPC、用户文件读写或真实设置保存；第四轮仅读写自有 tmp transcript。动态证据只代表明确列出的纯函数/内存状态路径；UI 端到端行为未验证。需要 React 的实验如遇缺包会直接跳过。
