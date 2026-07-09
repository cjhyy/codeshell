# 今晚优化工作 GOAL（2026-07-10）

> **唯一事实源**。编排 agent 每开一项前先重读本文件；用户可随时 update 本文件（加项 / 改优先级 / 划掉），以文件为准。
> 工作流见同目录 `WORKFLOW.md`（codex 三角色流水线：做 → 审 → 合 → 清）。
> 基线分支：`worktree/optimize-nightly-s-mrdrvs`（基于 `80eef6e6 chore: release 0.7.0-beta.1`）。
> 任务来源：`TODO.md` 的「小 feature（体量 M 及以下）」全量 + 「rc.18 发版遗留」作为附加区。

## 状态图例
`[ ]` 待做 · `[~]` 进行中 · `[x]` 完成 · `[!]` 阻塞/搁置

---

## A. 小 feature（本区全部要做，按下列顺序串行推进）

- [x] **A1. DriveAgent 后台任务可查询/可取消 + 并发警告可用化**（体量 M）— ✅ DriveAgentJobs(list/inspect/cancel)，reviewer 首轮 BLOCK（cancel pre-spawn 竞态）→ 修复 eb439725 → 复审 SHIP，回归 437 pass，已合并。Low(权限拆分)记后续
  - 锚点：`packages/core/src/tool-system/builtin/drive-claude-code.ts`、`background-jobs.ts`、`background-work.ts`
  - 目标：给 DriveAgent job 增 list/inspect/cancel（复用 backgroundJobRegistry）；list/inspect 至少返回每 job 的 prompt 摘要 / cwd / 启动时间 / 预计改动范围；把并发防撞从「事后 warning」改为「派发前可查询」。
  - 验收：并发场景下编排方无需回头问用户就能判断是否冲突（看得见、判断得了）。不强制阻断/排队。

- [x] **A2. 拆 `engine.ts` 本体（第一步）**（体量 M）— ✅ 抽出 run-image-input.ts（图片输入处理），engine.ts 3712→3534 行，纯 refactor 零行为变化，reviewer SHIP，297 pass 已合并。后续继续逐块抽
  - 锚点：`packages/core/src/engine/engine.ts:768`、`:2068`（现 3626 行）
  - 目标：一次抽一块到独立模块（图片策略 / sandbox / subagent / runtime config / run 装配），每块配 core 测试，保留 Engine 只做生命周期和装配。
  - 验收：本项**先只抽 1 块**（选边界最清晰的一块，如 image-policy 或 sandbox 装配），带测试、typecheck 新增 0 错、回归绿。避免一次动太大。

- [x] **A3. 侧边栏快速聊天（btw / quick-chat）**（体量 M）— ✅ quickChat dock panel，独立 sessionId+bucket 隔离，reviewer SHIP-with-nits（隔离真严格），已合并
  - 锚点：`packages/desktop/src/renderer/view.ts:18`、`panels/PanelArea.tsx:90`
  - 目标：独立 sessionId、严格 bucket/session 隔离、可选只读主线程快照，面板生命周期复用现有 PanelArea 持久化规则。
  - 约束：**不做 Pi 式 parent 指针树状 session**；快聊用完即走，合并靠 fork/复制派生。

- [x] **A4. MCP HTTP Auth / OAuth / Link 认证体验**（体量 M）— ✅ oauth credential 类型+SafeStorageCipher 加密存储+MCP Bearer 注入+设置 UI，reviewer SHIP-with-nits（凭证不泄漏、向后兼容 OK），已合并。真实授权码登录/自动 refresh 留后续
  - 锚点：`packages/core/src/credentials/types.ts:6`、`types.ts:718`、`tool-system/mcp-manager.ts:99`、`desktop/.../settings/McpSection.tsx:960`
  - 目标：加 OAuth credential 类型、登录状态/刷新/退出、认证方式选择 UI，保持 Codex 风格字段兼容。

- [x] **A5. 命名收口 repo / workspace / project / cwd**（体量 M）— ✅ 方案文档已产出并合并（naming-consolidation-plan.md，merge 25970519），机械改名留后续
  - 锚点：`packages/desktop/src/renderer/repos.ts:14`、`core/src/types.ts:248`、`settings/schema.ts:361`
  - 目标：先定概念表和迁移边界，再机械改名 / 适配旧 localStorage 与 state.json。
  - 验收：本项**先只产出概念表 + 迁移方案文档**（写进 `docs/nightly-2026-07-10/naming-consolidation-plan.md`），机械改名作为后续。避免大范围改名夜里失控。

- [x] **A6. Prompt cache 深化（第一步）**（体量 M）— ✅ 修 compaction 后 dynamicContext 残留（改用压缩输入侧剥离，覆盖 summary 路径）+ cache_read 暴跌诊断（LRU 上限）。3 轮 review：泄漏 Blocker→summary 漏剥 Blocker→anchor 记账 Blocker，逐一修复复审 SHIP，336 pass 已合并。prefix hash 分离/粘性锁定/OpenRouter 双 marker 留后续
  - 锚点：`docs/todo/prompt-cache-optimization.md:91`、`prompt/composer.ts:242`、`llm/providers/anthropic.ts:484`、`engine/engine.ts:2264`
  - 目标：系统分离 cacheable prefix、审计动态开关锁定、检测 cache_read 暴跌。**已知 bug**：`compactedMessagesBySession` 落缓存时只 `stripUserContextMessage` 没剥旧 dynamicContext（engine.ts:2264）→ 陈旧 skills/gitStatus/memory/goal 残留污染上下文并膨胀 prompt。
  - 验收：本项**先修 dynamicContext 残留 bug + 加 cache_read 暴跌诊断**（最小、可测），大改 prefix hash 作为后续专项。

- [x] **A7. [低优] 升级 GitHub Actions 到 Node 24**（体量 XS）— ✅ checkout@v7/setup-python@v6/upload-artifact@v7/download-artifact@v8，reviewer SHIP 已核实版本真实性，已合并
  - 锚点：`.github/workflows/release.yml`、`ci.yml`
  - 目标：checkout@v5 / setup-python@v6 / artifact 新版，消 Node 20 弃用 warning。纯 warning 不影响构建。

---

## B. rc.18 发版遗留（附加区，A 区做完后继续；发 0.7.0 正式版前应处理）

- [x] **B1. 发版 workflow 加固**（体量 S）— ✅ verify-version 加 core VERSION 正则断言+bun.lock 校验、release needs [package,npm-publish]、CI 签名失败 throw，reviewer SHIP-with-nits（正常发版无误阻断），已合并。nit：本地 CI="false" 字符串被 Boolean 判 true，留后续
  - 锚点：`.github/workflows/release.yml:45-59`（verify-version）、`:61-65`/`:257-263`、`packages/desktop/scripts/after-pack-adhoc-sign.cjs:45-68`
  - 目标：verify-version 加断言 core VERSION==tag、bun.lock 无旧版本；release 依赖 `[package, npm-publish]`；CI 下签名/verify 失败 exit non-zero。

- [x] **B2. 补几条安全回归测试**（体量 XS）— ✅ symlink 逃逸/非视觉结构化附件仍调LLM/non-streaming redaction 三条，16 pass，纯测试已合并
  - 锚点：`engine/input-attachments.test.ts`、`engine-structured-image-vision-gate.test.ts`、`model-facade-recorder-redaction.test.ts`
  - 目标：①目录内 symlink 指向外部文件的附件逃逸显式用例；②Engine「非视觉+非图片结构化附件仍调 LLM」回归；③non-streaming recorder redaction 直接单测。纯补测试无代码改动。

- [x] **B3. release-checklist-beta.md 文档纠偏**（体量 XS）— ✅ core files=["dist","THIRD_PARTY_NOTICES.md"]、示例改 0.7.0-rc.1/0.7.0，纯文档已合并
  - 锚点：`docs/release-checklist-beta.md:48`、`:92-95`
  - 目标：core `files` 已含 THIRD_PARTY_NOTICES.md 需更新；发版示例从 `0.6.0-beta.1` 改为 rc/0.7.0。

---

## C. codex 能力对标 → 补齐 CodeShell 缺失能力（A、B 全部完成后再开）

> 目标：借鉴 codex 的成熟能力，找出 CodeShell 还缺的「好用的东西」并补上。全程让 codex 做，减少主上下文污染。

- [ ] **C1. codex 能力全清单调研**（调研，纯文档）
  - 让 codex（后台，只读联网）把 **codex CLI / codex 生态自身所有 feature** 尽量完整列出来（交互模式、exec 无头、resume、sandbox 分级、image 输入、MCP、hooks/notify、审批模型、rollout/session 文件、slash 命令、配置项等），逐条给官方来源。
  - 产出：`docs/nightly-2026-07-10/codex-capability-catalog.md`。

- [ ] **C2. 对标 CodeShell，找差距 + 排能做的**（调研，纯文档）
  - 让 codex 拿 C1 清单逐条对照本仓库现状，标注「CodeShell 已有 / 部分有 / 缺失」，对缺失且「好用」的能力给出：价值、落地难度、锚点、体量。
  - 产出：`docs/nightly-2026-07-10/codeshell-capability-gap.md`，末尾给一份**按性价比排序的候选清单**。
  - 收口：候选清单交回编排 agent，**由卡密sama 圈定**哪些真正进入实现队列（不自动开工）。

- [ ] **C3. 实现被圈定的能力**（视 C2 结果，逐项走 WORKFLOW 四步流水线）
  - 每项独立 worktree/分支，串行做→审→合→清；合并冲突由 codex 自行处理（见 WORKFLOW 第 2/4 节）。

## D. 细化 TODO.md 大 feature（体量 L）→ 拆出可先做的细节（C 之后）

> 目标：把 TODO.md「大功能升级（体量 L）」区各项拆成可单会话落地的子项，挑出能先做的。

- [ ] **D1. 大 feature 拆解调研**（调研，纯文档）
  - 让 codex 逐个读 TODO.md 大 feature 区（core 通用化+插件面板、IM gateway、Workspace/Profile/数字人、Workspace 数据源绑定、worktree session 隔离深化、工程质量 P7、架构债 P1/P2）及其锚点 `docs/todo/*.md`，把每个大 feature 拆成有序子任务，标注依赖、体量、可否独立先做。
  - 产出：`docs/nightly-2026-07-10/large-feature-breakdown.md`，末尾汇总一份**「可先做的子项」候选清单**（按依赖/性价比排序）。
  - 收口：候选清单交回编排 agent，**由卡密sama 圈定**进入实现队列（不自动开工）。

- [ ] **D2. 实现被圈定的子项**（视 D1 结果，逐项走 WORKFLOW 四步流水线）

## E. open-connector 调研 → 补齐 connector 能力（D 之后，最后做）

> 目标：研究 open-connector，看 CodeShell 的 connector（数据源/外部服务接入）这块能力要怎么补。

- [ ] **E1. open-connector 调研**（调研，纯文档）
  - 让 codex（后台，联网）研究 https://github.com/oomol-lab/open-connector/blob/main/docs/README.zh-CN.md ——connector 的概念模型、能力边界、协议/schema、鉴权、可复用点。
  - 结合 CodeShell 现状（MCP、credentials、LinkTab 静态壳、TODO「Workspace 数据源绑定」体量 L）分析：connector 这块要补什么、怎么补、与现有 MCP/credentials 的关系。
  - 产出：`docs/nightly-2026-07-10/connector-capability-plan.md`，含：open-connector 要点、CodeShell 差距、补齐方案（分阶段）、候选可先做项。
  - 收口：交回编排 agent，**由卡密sama 圈定**是否进入实现队列。

---

## 执行顺序总览

`A（小 feature 7 项）` → `B（发版遗留 3 项）` → `C（codex 能力对标 → 补齐）` → `D（大 feature 拆解 → 先做子项）` → `E（open-connector → connector 能力）`

- C/D/E 的**调研阶段全程交给 codex 后台做，产出文档**，不进主上下文。
- 每个调研阶段的候选清单**都要回到卡密sama 圈定**后才进入实现，不自动开工。
- 所有实现项统一走 WORKFLOW.md 四步流水线；合并冲突由 codex 自行处理。

---

## 进度记录（每完成一项由编排 agent 追加）

| 项 | worktree/分支 | 实现 commit | review 结论 | 回归 | 状态 |
|----|--------------|------------|------------|------|------|
| A5 | task-naming-plan | bcb8b861 | 纯文档免审 | — | ✅ 已合并 25970519、worktree 已清 |
| A7 | task-actions-node24 | ff809c46 | SHIP（版本真实性已核实） | YAML 有效 | ✅ 已合并、worktree 已清 |
| A3 | task-quick-chat | 2e700c01 | SHIP-with-nits（隔离真严格） | 3 pass | ✅ 已合并、worktree 已清 |
| A4 | task-mcp-oauth | 660f320d | SHIP-with-nits（凭证加密不泄漏） | 89 pass | ✅ 已合并、worktree 已清 |
| A1 | task-driveagent-inspect | fb839656+eb439725 | BLOCK→修复→复审 SHIP | 437 pass | ✅ 已合并、worktree 已清 |
| B3 | task-release-checklist | adc01e74 | 纯文档免审 | — | ✅ 已合并、worktree 已清 |
| B2 | task-security-tests | 703537bd | 补测试直合 | 16 pass | ✅ 已合并、worktree 已清 |
| B1 | task-release-harden | 5ba15a46 | SHIP-with-nits（无误阻断） | YAML/JS 有效 | ✅ 已合并、worktree 已清 |
| A6 | task-prompt-cache | 13e0b826+f2caf918+b1bd98a3 | 3轮 BLOCK→复审 SHIP | 336 pass | ✅ 已合并、worktree 已清 |
| A2 | task-split-engine | 39d7f218 | SHIP（零行为变化） | 297 pass | ✅ 已合并、worktree 已清 |

**A 区 7 项 + B 区 3 项全部完成。** 下一阶段 C（codex 能力对标调研），需产出候选清单回卡密sama 圈定后才实现。

> ⚠️ **2026-07-10 编排暂停**：codex CLI 登录态失效（CheckQuota: no Codex token / DriveAgent 报 "logged out or signed in to another account, please sign in again"）。C1 能力清单调研因此中断（空文件已清）。**在此之前 A+B 全部 10 项已完成合并，无损失。** 恢复方法：终端跑 `codex login` 重新登录，之后即可继续 C1→C2→…。当前领先 origin/main 32 commits，未 push。

## 问题记录（遇到阻塞 / 非本任务引入的红测试记这里）

- **[新 bug 候选] 带附件插入的消息卡住**（卡密sama 2026-07-10 报告，待补现象细节）
  - 现象：带附件插入的消息发送后卡住。
  - 待确认：附件类型（图片/其它）、卡在哪一步（气泡不出现/转圈不结束/LLM 未调用）、是主线程还是 quick-chat 面板、有无 console 报错。
  - 处理：细节补齐后作为独立 bugfix 走 systematic-debugging → codex 流水线（可能与「输入附件管道统一」相关记忆有关）。

- **[新 bug 候选] 每轮编辑文件数统计不对**（卡密sama 2026-07-10 报告）
  - 现象：desktop 每轮（turn）显示的"编辑的文件"数量算得不对。
  - 待确认：是多算/少算/去重问题；涉及 DriveAgent 外部改动归因（readExternalChangedFiles）还是 in-session 聚合器；主线程 turn 聚合逻辑锚点。
  - 处理：走 systematic-debugging → codex 流水线定位聚合口径。
  - **📝 静态排查note（本会话主 agent，2026-07-10）**：`FilesChangedCard.tsx` 只是显示 `files.length`（如 :146 editedCount），**不是**计数源；真正聚合口径在上游（core 的 changedFiles 归因 readExternalChangedFiles + renderer 侧把多次 tool/turn 的改动合并的 reducer）。跨 core+renderer 两处，静态一次定位不到确切去重点，**需 codex 动态排查**：加日志看单个 turn 内 files 数组是"多次 Edit 同文件未去重"还是"跨 turn 累加/漏减"。不硬猜，留给 codex 实跑。

- **[新 bug 候选] 过程卡片被通知回来后全折叠、看不到最新进行中过程**（卡密sama 2026-07-10 报告，本会话实测）
  - 现象：后台 agent 完成通知回来时，消息流里正在跑/进行中的过程卡片被全部折叠起来；期望仍能看到最新的一些过程（进行中或最近的），而不是一律折叠。
  - 待确认：折叠是 background_agent_completed 通知触发的重渲染/reducer 行为，还是 TurnProcessGroupCard 的默认折叠策略；期望行为=保留最新 N 条/进行中的展开。
  - 处理：走 systematic-debugging → codex 流水线，定位折叠触发点（transcriptsReducer / TurnProcessGroupCard），改为"进行中/最新过程默认展开"。
  - **🔍 根因已锁定（本会话主 agent 静态定位，2026-07-10）**：`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:53-55` 的 force-collapse effect：`useEffect(() => { if (turnEpoch !== undefined && !group.isLive && !group.stopped) setOpen(false); }, [turnEpoch, group.isLive, group.stopped])`。`turnEpoch` 每次新 turn 边界（含 background_agent_completed 唤醒触发的新 turn）就变 → 该 effect 对**所有历史非 live 非 stopped group** 无差别 `setOpen(false)`，把用户手动展开的也强制折叠。**修法**：force-collapse 只应作用于「刚结束的那个 turn」，不应在每个 turnEpoch 变化时重折叠所有旧 group；且应保留用户手动展开态（区分"用户显式 open"与"默认态"，只折叠从未被用户交互过的、或只折叠最近刚 live→closed 的那个）。**验收**：通知回来后，用户之前展开的历史过程卡片保持展开，仅新结束 turn 按默认折叠。

- **[新 bug 候选 · 较严重] steer 带附件 → 完全没有 LLM 回应**（卡密sama 2026-07-10 报告，订正）
  - 现象：运行中 steer（插入消息）时**若带附件，整个 turn 完全没有 LLM 回应**（不是附件不生效，而是根本不回复——疑似 turn 卡死/静默中断）。不带附件的 steer 正常。
  - 待确认：带附件的 steer 入队后，turn-loop 装配该 message 时是否抛错被吞/生成了非法 message 结构导致请求未发或静默失败；backfill（turn-loop-steer-backfill）把 steer 并入历史时 attachments 是否破坏了 message；有无 console/后端报错。
  - 处理：走 systematic-debugging → codex 流水线。**优先级较高**（steer+附件直接断回复）。先加日志复现：steer 带附件时 turn-loop 是否进入 LLM 调用、请求体是否合法、有无异常被 catch 吞掉。可能与「输入附件管道统一」同底层。
  - **🔍 根因线索（本会话主 agent 静态定位，2026-07-10）**：steer 链路根本没有 attachments 通道——`SteerItem` 接口（`packages/core/src/engine/steer-queue.ts:9`，仅 id/text/clientMessageId）和 `Engine.enqueueSteer(sessionId, text, id, clientMessageId)`（`engine.ts:817`）都**不接收/不携带 attachments**；而正常 `run()` 走 `options.attachments`（`engine.ts:942`→`prepareRunImageInput`）。推测「无 LLM 回应」的机制：UI steer 带附件时，桌面/protocol 层可能在 steer 提交路径尝试携带附件但 core 端签名不接 → 要么附件被静默丢（退化成纯文本 steer，与「附件不生效」不符），要么 protocol 层因 steer payload 带了 core 不认的 attachments 字段而抛错/被吞 → 该 turn 静默不发 LLM。**建议修法**：给 SteerItem + enqueueSteer 加 attachments 字段，turn-loop 消费 steer 时把附件按与 run() 同一套 input-attachments 装配进 message（复用 prepareRunImageInput/buildRunUserMessageContent 的结构化附件路径）；并在 protocol/desktop steer 提交链核实附件确实透传。**验收**：steer 带图片 → 正常 LLM 回应且图片被看到。**待 codex 恢复后按此线索开 TDD 修复**。
