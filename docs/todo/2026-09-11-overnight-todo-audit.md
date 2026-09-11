# 2026-09-11 夜间 TODO 核查

状态：持续核查中的证据账本。范围是当前共享工作区，包含任务开始前已有的未提交改动；不把工作区实现误写成已发布，不把旧文档测试数字当作本轮验收。

## 覆盖与判定规则

- 读取 `CODESHELL.md`、根 `TODO.md`，枚举 `docs/todo/` 原有 **75 份 Markdown**，提取状态、验收和未勾项目；其中 **48 个未勾框**来自 2 份文档。原始设计没有逐项回勾，不等于 48 个功能都未实现。
- 扫描 `packages/`、`scripts/`、`tests/` 中独立单词 `TODO/FIXME/HACK/XXX`：开始时 **164 个命中行、166 个 TODO 单词**；未发现独立 `FIXME/HACK/XXX`。`TODOIST_API_TOKEN`、变量 `todo`、文档路径和产品 TodoWrite 状态不作为代码缺陷。
- 源码编号式 `TODO 3.1` 等主要是已实现功能或回归测试的来源标签。确认完成需要读实现/调用方/测试，不能仅靠搜索符号或删除注释。
- 设计文档里带“未来、尚未、待做”的阶段单独核实；外部账号、真实 provider、安装版、公开域名与生产部署的验收，不用单测替代。
- 文档中旧文件行号是历史定位。下文源码路径与符号以本次工作区为准，完整命中清单和全部文档清单见文末。
- 文档收口时重新核验根 `TODO.md`、`docs/todo/README.md`、本报告、跳过测试审计与 `memory-final-design.md`：**235 个本地链接均存在**，源码标记表的 91 个文件及全部命中行与扫描结果一致。机器可读核验结果为 `/tmp/codeshell-polish-20260911/document-final-audit.json`；这不替代主任务的最终全量测试、构建或长时间运行验收。

## 核查项目与处理状态

| 优先级 | 项目                            | 证据与可执行下一步                                                                                                                                                    | 状态                                                                                                                    |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P2     | TUI 搜索扫描重复实现            | 新 `packages/tui/src/render/searchMatches.ts:findRowSearchMatches` 统一 lowercase UTF-16→cell 映射、spacer/noSelect 排除和非重叠查找；两个消费者保留原有样式/范围语义 | 本轮完成；9 个字符边界回归 + 既有渲染共 15 pass，TUI typecheck 通过；移出根 TODO                                        |
| P2     | TaskGuard 同位置任务更新的年龄  | TodoWrite 每次产生全量新数组，位置 id 仅在快照内有效；`task-guard.ts` 现在按快照引用重置年龄，并保留 Engine 同一快照跨轮稳定引用的契约                                | 本轮完成；先复现 2 fail，再以真实 TodoWrite 和清空/重置等 12 项回归通过；提醒阈值仍是 3 轮                              |
| P2     | extraction description 类型边界 | `extract-memories.ts` 在截取有效候选上限前过滤非字符串 description，保留空字符串；原实现会持久化 number 等非法 metadata                                               | 本轮完成；6 类错误输入与真实 orchestrator 落盘回归先复现 7 fail，修后相关 32 项通过；该阶段未改 canonical，后续专项见下 |
| P2     | memory 严格同批重复             | `extract-memories.ts` 对校验/scope 归一后的完整结构去重，再应用数量/global cap；旧实现会把相同候选保存成不同 ID 并挤掉下一事实                                        | 本轮完成；解析和真实落盘先 3 fail，相关 4 文件共 39 项通过；不同字段、大小写、空白、否定和词序仍不合并                  |
| P2     | Link 断开与异步完成竞态         | `packages/core/src/links/link-action-tool.ts` 现在在发布 action_result 前同时重查 live binding 与 task AbortSignal，防止不响应取消的 provider 返回旧结果              | 主任务完成；5 个新增回归，run + links 专项共 76 项通过                                                                  |
| P2     | cc-room 加载更多失败后重试      | `CCRoomView.tsx` 已有 total/expanded 和加载更多按钮；本轮 Desktop 审计修复失败重试与过期异步响应隔离                                                                  | Desktop 专项 52 文件、299 项回归通过；room-list discovery/convergence 的真实架构 TODO 仍保留                            |
| P3     | TUI 子 agent Todo 展示          | `App.tsx` 的 task_update 已按 agentId 隔离，主列表隐藏于子 agent 详情；子 agent 自身快照尚未保存在详情状态中                                                          | 真实后续是展示子列表，不是“全局 singleton 尚无归属”                                                                     |
| P3     | runtime 级 MCP 连接池           | `core/src/cli/agent-server-stdio.ts`、`tui/src/cli/commands/run.ts`、`repl.ts` 各有一个占位 MCPManager；session Engine 仍各自接线                                     | 同一个架构项目的 3 处注释，不是 3 个独立 bug                                                                            |
| P3     | runtime 级成本汇总              | 上述 3 入口构造共享 CostTracker，Engine 的 session 计费尚未写入 runtime tracker                                                                                       | 同一个架构项目的 3 处注释；不得误写“当前没有成本统计”                                                                   |
| P2     | Arena 显式模型大小写            | 连接 ID→ModelPool 桥早已实现；`tui/src/cli/commands/arena.ts` 原先将整个 `--models` 转小写，导致精确 ID、与 preset 重名 ID 和原始模型路径被误选/改写                  | 本轮完成：精确 ID 优先，仅旧 preset alias 忽略大小写；真实 CLI 回归先复现再通过，旧注释与根 TODO 同步                   |
| P3     | Ink 兼容行为移除                | `packages/tui/src/render/events/input-event.ts:50,95` 保留 meta/escape 兼容                                                                                           | 需下一 major 兼容策略，不在本轮盲删                                                                                     |

## 已核实的过期描述

| 原描述                                                                | 当前证据                                                                                                                                                                    | 处理                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| TUI TaskCreate/Update 是全局 singleton，等待 ownerAgentId             | `core/src/tool-system/builtin/task.ts` 已是 TodoWrite + transcript；`core/src/types.ts` task_update 带 agentId；`tui/src/ui/App.tsx` 明确过滤 child 事件                    | 本轮仅改准确注释                                                                      |
| 视频只存在 fake provider                                              | `core/src/tool-system/builtin/video-providers.ts:getVideoProvider` 已注册 `FalVideoProvider`，默认 Kling 模型在同文件                                                       | 本轮仅改准确注释；不声称所有厂商直连已实现                                            |
| SpacerHead 要等软换行实现才有 producer                                | `packages/tui/src/render/output.ts:788` 已在最后一列放不下宽字符时写 SpacerHead                                                                                             | 局部注释过期；完整自动换行语义仍需独立评估                                            |
| cc-room 加载更多尚未做                                                | `packages/desktop/src/renderer/cc-room/CCRoomView.tsx:464` 已渲染按钮并调用扩大列表查询                                                                                     | 归为追溯标签，同时保留失败重试审查                                                    |
| 架构债 P1/P2 未排期                                                   | `architecture-debt.md` 本身已记录 07-14 完成；core 三入口、arena 包、SafeStorage、run-\* 模块都存在                                                                         | 索引需更正，Engine 进一步拆分仍是增量后续                                             |
| Session 累计缓存 usage 未动手                                         | `core/src/session/usage.ts`、`session-manager.ts`、`desktop/src/renderer/types.ts` 均有累计、持久化和恢复；`session/usage.test.ts` 与 renderer 测试覆盖                     | 设计状态过期，不再重复实现                                                            |
| 08-30 C4 记忆正文非原子写                                             | `packages/core/src/session/memory.ts:284` 已 `writeFileAtomic(filePath, content, 0o600)`                                                                                    | 旧候选已解决，不等于所有读改写并发问题已消失                                          |
| 08-30 C5 WS 无 maxPayload、pending 无界                               | `server/src/serve/headless-server.ts` 已 1 MiB、每 tab 64 pending、TTL reaper；对应 server 测试覆盖                                                                         | 旧候选已解决                                                                          |
| appendOnboardingResult 无锁读改写                                     | `packages/core/src/onboarding.ts:364` 已 `mutateJsonFile`，拒绝 malformed settings；并发测试已存在                                                                          | 旧候选已解决                                                                          |
| 数字人仓库只能移除再添加更新                                          | `settings/DigitalHumansSection.tsx:470` 已单独更新按钮；`profile/catalog-store.ts` 有 repo 锁与安全替换                                                                     | 原 TODO 过期                                                                          |
| requires 只能只读展示                                                 | `DigitalHumanEditorDialog.tsx` 已能编辑缺失 skill 的安装源并保存 requires；完整 tools/任意依赖编辑仍未开放                                                                  | 部分过期，应保留细分剩余                                                              |
| 数字人导入导出与远程分发全未做                                        | `DigitalHumansSection.tsx`、`profile/catalog-store.ts` 已 JSON 导入导出与 Git 仓库分发                                                                                      | plugin 降级、完整依赖编辑/运营仍可单独规划                                            |
| Pet 外部会话卡片禁用点击                                              | `petExternalSession.ts` 提供 locator，`SessionStatusSection.tsx` 与 `PetDesktopWindow.tsx` 已导航                                                                           | 原 TODO 过期；无法解析定位器的卡片继续禁用是正确降级                                  |
| Pet 外部可见性只能全局 scope                                          | `DigitalHumansSection.tsx` 支持 project override 与继承；`main/pet/external-session-visibility.ts:154` 按路径求有效值，`main/index.ts` 构造并调用 controller reconciliation | 原 TODO 过期；已核实 UI、设置、host 过滤链路，不重复排期                              |
| 委派 launch 就记 completed                                            | `pet-long-task-coordinator.ts` 按终态调 `onTaskWorkMemory`；`main/index.ts` 从 task.status 派生 outcome                                                                     | 旧 launch 完成信号描述过期；Mimi 更多可靠性问题见独立设计                             |
| 父子双向通知只有设计                                                  | `agent-notifications.ts` 已持久 mailbox、direction/progress/result；`agent.send-input.live.test.ts` 验证 running child 路由和 tree ACL                                      | 主体机制已落地；旧设计是实现依据                                                      |
| 多文件夹项目只是待门禁设计                                            | `session-manager.ts:migrateSessionMainRoot`、`session-workspace-rpc.ts`、`path-policy-multi-root.test.ts` 与 main project root 路由已实现                                   | 应写当前实现/验证范围，不能重新从 Phase 0 开工                                        |
| MCP OAuth/IM Gateway/Mimi 进入 Session/浏览器 Profile 租约都未动手    | `mcp-oauth-service.ts`、`packages/chat`、`conversation-session-route-store.ts`、`browser-profile.ts`、`tab-control.ts` 已有实际接线与测试                                   | 索引的未动手状态过期；逐项仍需保留外部验证/后续扩展                                   |
| Hub 共享客户端、Skills 安装、Web Panel、HTTPS 指引未做；Docker 未验证 | `Workbench.tsx`、server hub/skills-management、panels 服务、`docs/deployment.md`、`shared-web-workbench.md` 和 09-09 验收记录已覆盖                                         | 根服务端 07 月长段应由当前 Hub 后续清单取代；历史 Docker 验收不代表本轮新增代码已重建 |

## 48 个未勾验收的核查

### GitHub Link 设计（20 项）

原文：`github-link-local-first-tech-design.md:1126-1151`。**不能全量回勾**：实现选择已变化，而且真 token 验收需要独立证据。

| 原行 | 验收                                | 判定                                                                                                                   |
| ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1126 | PAT 连接入口                        | Desktop/Web Link provider catalog 与 token 连接服务已有；真凭据验收另计                                                |
| 1127 | 账户、local badge、仓库列表         | provider.validate 返回 identity/resourceLabels；界面已有连接卡。仍需真实账号外部验证                                   |
| 1128 | 列仓库                              | providers.ts 与 cli.ts 有 list_repositories 和测试                                                                     |
| 1129 | README/UTF-8 文件                   | get_readme/get_file 已实现                                                                                             |
| 1130 | Issues 读                           | list_issues/get_issue 已实现                                                                                           |
| 1131 | PR 读                               | list_pull_requests/get_pull_request 已实现                                                                             |
| 1132 | 每次创建 Issue 审批                 | link-action-tool.ts 对所有 write action 每次 askUser；账户展示细节与原设计不同，不机械勾满                             |
| 1133 | 拒绝不发请求                        | askUser 拒绝直接 cancelled；现有测试覆盖                                                                               |
| 1134 | 断开后不可用/LINK_DISCONNECTED      | live resolver 已 fail；错误使用 kind:error 文本，不是设计中的稳定码，属于契约差异                                      |
| 1135 | 无独立 Link Server 仍可用           | 当前就是 local-first；Node host Link service 已接通                                                                    |
| 1139 | PAT 不进入 renderer/messages/log    | purpose=link 凭据通道与屏蔽机制存在；属于持续安全边界，不能只靠一个 smoke 证明所有日志无泄漏                           |
| 1140 | UseCredential/env 不可取得 PAT      | credentials purpose 隔离及专门安全测试已有                                                                             |
| 1141 | endpoint 只能由 handler 构造        | providers.ts 固定 GitHub endpoint；owner/repo/path 校验有回归                                                          |
| 1142 | WorkspaceLinkGrant + 逐次写审批     | 逐次审批已实现；原设计中的 WorkspaceLinkGrant schema 没有实现，当前是 credential scope + capabilityIds，不应误宣称等价 |
| 1143 | 断开 abort + 丢弃旧结果             | abort 已有；本轮补齐 action 完成后 binding/signal 复查，忽略取消仍 resolve 的 provider 回归通过                        |
| 1144 | 重连旧 receipt/request 不复用       | service mutation revision 与工具执行前后 freshness 已有；本轮旧绑定异步结果回归通过，真实账号重连操作仍按外部验收处理  |
| 1148 | packages/link 仅依赖 core extension | **原设计已替代**：packages/link 是无 core 依赖的 manifest 包，执行在 core/server，见 CODESHELL.md                      |
| 1149 | MCP OAuth 语义独立                  | 当前独立模块成立；非待新增能力                                                                                         |
| 1150 | 共用 Action registry                | provider catalog/action 注册与 Desktop/Web 管理已接通；当前命名与原 ActionSpec 方案不同                                |
| 1151 | ActionSpec local/server 双 runtime  | 当前 LocalLinkActionSpec 仅 local；独立双向 OAuth Link Server 明确未实现，留作后续设计                                 |

### 可靠性与上下文方案（28 项）

原文：`agent-reliability-and-context-optimization.md:584-623`。这组主要是真实设计待办，但缓存部分已有后续实现，不能把 09-03 快照当当前状态。

| 原行 | 项目                                     | 判定 / 下一步                                                                        |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| 584  | 发布包含修复的安装包                     | 本轮不替换安装版；需把候选构建与实际运行 Build Identity 对齐验收                     |
| 585  | Runtime Build Identity                   | 未找到统一 schema/日志接线，仍待设计实施                                             |
| 586  | 真实 OpenRouter/GPT cache contract       | 09-06 已有真实 6 请求证据与客户端回归；持续自动 contract 门禁尚未建立                |
| 587  | Cache Plateau Detector                   | 09-06 只做缓存读数下降检测，明确未做无前缀证据的停滞归因；保留待办                   |
| 588  | 固定 20+ 轮缓存基线                      | 09-06 只有短样本；长程基线仍需专项                                                   |
| 589  | 本事故脱敏 Replay Fixture                | Mimi 微信/聊天回放存在，但不等于此事故全链路 replay；保留                            |
| 593  | Capability Resolver                      | 原方案的统一解析器未实现；不能与现有 composition compiler 混称                       |
| 594  | GitHub 幂等 Star Action                  | 当前 GitHub actionIds 没有 star/unstar；真实待办                                     |
| 595  | 飞书表格结构化读写/验证                  | 当前 Link catalog/handlers 未提供该完整 action 集；不以临时本地脚本替代产品实现      |
| 596  | Operation Controller + Ledger            | 未实现统一 operation 状态机；需设计                                                  |
| 597  | 工具错误分类/熔断                        | 已有各工具防护，原方案跨工具统一熔断未实现                                           |
| 598  | VerifiedWriteResult                      | 无统一契约；需与 operation 状态机一并落地                                            |
| 599  | on_stop 检查 verified                    | 前置 operation 契约不存在；保持依赖顺序                                              |
| 603  | Task Capability Router                   | toolAllowlist 已存在；按任务动态路由尚未实现                                         |
| 604  | 非核心工具统一 deferred                  | 当前 ToolSearch 以 MCP deferred 为主；完整扩展未完成                                 |
| 605  | 去逐工具重复 description                 | 已有 prompt 重组；需以实际模型 payload 测量是否仍重复，不单凭文档勾选                |
| 606  | Skill listing 预算/排序/name-only        | 已按 namespace/name 稳定排序；buildSkillListing 仍完整输出 description，预算降级待做 |
| 607  | Session/Credential/Provider 目录移出定义 | LinkAction 已支持按需发现；其他动态目录需要 payload 级逐项核实，部分完成             |
| 608  | 活动工具集 Run 粘性/变更日志             | prompt/cache 诊断已有；通用 task router 的活动集粘性未完成                           |
| 612  | Browser Observe/Act/Postcondition 宏     | browser library 已替换，但原方案统一闭环宏仍是独立后续                               |
| 613  | Runtime 超时恢复/重启预算                | 外部 runtime 重试与取消是本轮并行核查范围；不因存在启动代码就回勾全局策略            |
| 614  | OS 自动化权限预检                        | 需明确平台/工具范围，不扩大为本轮默认改系统权限                                      |
| 615  | Operation 状态投影 Todo                  | 依赖 Operation Controller，当前无统一投影                                            |
| 616  | TaskGuard 降 re-nag/非持久化噪声         | 本轮已修同位置快照年龄语义；频率策略仍保持 3 轮，降频/持久化策略仍是产品后续         |
| 620  | GPT Responses API 评估                   | OpenAI provider 仍 Chat Completions；外部 Codex runtime 不等于原生 Responses 迁移    |
| 621  | previous_response_id/persisted reasoning | 与上一项同一评估阶段，未接入                                                         |
| 622  | Replay Suite 比模型/effort/cache/cost    | 三份 eval/optimization-agent 设计尚未有统一运行器                                    |
| 623  | 只有 Eval 证明才改默认模型               | 是采用规则，不是能通过删 TODO 完成的代码任务                                         |

## 应保留的大功能与外部验证

- 独立 Link Server、下游 OAuth client/grant/refresh/revoke：明确未实现。当前 Hub 内 Link 管理不是独立授权服务器。
- Hub 语义协议统一、Electron 原生窗口选择远端宿主、完整 Panel SDK 的 Web 适配、多管理员/租户隔离：保持后续范围；当前产品仍先单管理员/单 Workspace。
- AgentModule Phase C lifetime/disposer、Phase D 请求边界证据：`composition/types.ts` 明确保留 Phase C；不能因 compiler 已完成而勾完。
- Profile 经验运营、dream 按数字人分桶、完整依赖编辑、降级 plugin：需要重新按现有数字人实现拆分；Git 仓库导入导出/更新已存在。
- Source Profile 求交、真实 provider adapter、写操作、文件解析索引：`sources/resolve.ts` 明确 profile 参数预留且当前不参与求交，真实待办。
- memory P2 背压/rate-limit/注入 cap：`memory-final-design.md` 明确按产品决策挂起；不要为凑数量抢做。description、严格同批重复、baseDir 透传和保守 canonical fallback 已完成；真实剩余是同批不同表述候选的决策上下文刷新，以及写决策 prompt 的有界旧正文对照。模型失败时允许暂留重复，避免凭词袋相似覆盖不同事实；manual 相近主题继续保守跳过。
- 聊天历史的长程流式恢复：当前 Main 每个 Session 保留最近 2000 个事件，renderer 的重放链与本地动作保留链分别设有 8192 项 / 8 MiB 估算体积上限。必要前缀被淘汰、或超限重试仍有缺口时，`transcriptHydration.ts` 保留当前可见投影并保持恢复失败，`useTranscriptBuckets.ts` 阻止该状态写入缓存；`ChatView.tsx` 继续渲染现有消息，并显示“聊天记录暂时未能加载，已有内容已保留。”及重试入口。完整从 durable raw 历史重建正在生成的长段内容仍需设计；本轮不能宣称任意长度无缝重放。
- Mobile 跨来源的恢复边界：活跃会话识别新 Main epoch，或首次从 legacy 游标升级为带 epoch 后，会等待该代次完整前缀，再接续实时流；Main 已淘汰新代次 seq 1 时，保留可见内容并提示重新打开会话读取已保存记录。后台先发现新代次、再切回会话时，`useRemoteApp.ts` 的 `historyUnpaired` 分支仅展示 durable history，拒绝直接叠加可能重复的 full snapshot，并提示“已恢复保存的聊天记录。当前回复的实时部分暂时无法接续，请稍后重新打开会话。”；focus/reconnect 可以重读 durable history，历史返回后的全新顶层 `stream_request_start` 才恢复实时接收，迟到 history/snapshot 不得覆盖该新回合。让 `session.history` 与快照共享可靠游标、再合并历史与正在生成的内容仍是后续协议设计；旧 peer 没有 epoch 时也无法完全识别 Main 重启。
- 全部 Link provider 真账号/真 token、浏览器扩展重载、安装版升级后真实使用、公开域名 TLS、真实长程 cache/notes 质量与成本：需要专门实测证据，不等于源码未实现。

## 本轮专项验证

- TaskGuard、TodoWrite、Engine Todo resume：12 pass / 34 assertions / 3 files；先证明位置 id 复用导致旧年龄遗留，再修。
- memory extraction、orchestrator、dream guard：32 pass / 91 assertions / 3 files；证明非法 description 会进入落盘结果，修复发生在候选筛选边界。其后新增严格同批重复修复，连同 scope routing 扩展验证为 **39 pass / 125 assertions / 4 files**；这些是相继复核的重叠集合，不累加为 71 项。
- TUI search + 原渲染：15 pass / 63 assertions / 2 files，抽取前后结果一致；覆盖 CJK、emoji、组合字符、İ、noSelect、SpacerHead、空查询、非重叠和幂等高亮。TUI typecheck 通过；局部 ESLint 0 error，保留原文件已有的 `@ts-nocheck` warning。匹配仍逐行，未更改软换行或 vendored input 兼容。
- Arena 真实 CLI options、既有 main options 与 model connection pool：16 pass / 40 assertions / 3 files。临时项目设置 + 独立 preload 捕获 Arena 构造/运行参数，网络调用明确拒绝；覆盖 `TeamA`/`teama`、连接 ID 与 `GPT4O` preset 重名、`cLaUdE` alias、原始模型路径大小写、topic 原样与 mode。TUI typecheck/格式通过；局部 ESLint 0 error，3 个原有 unused warning 未扩大处理。
- Renderer 历史合并的 epoch/seq 配对：`mergeTranscripts.ts:mergeTranscriptCursor` 防止把旧 Main 或 legacy 的较大 seq 绑定到新 epoch，空/非空路径一致；同 epoch 取 max，双方无 epoch 保持旧兼容规则。先 3 个回归失败，修后 23 pass / 40 assertions；`hydrateOrder.ts` 同步复用 helper，联合验证 **30 pass / 51 assertions / 2 files**。Main cache 的扩页顺序、随机显示 ID、重复用户意图和未完成指针由主任务修复；交叉审查额外复现“首条重复回答抢在后续稳定锚点前面”后补修，cache 专项 **19 pass / 66 assertions**。没有 durable intent 且全部内容重复的 legacy 数据仍沿用连续/尾部匹配兼容策略，不能从内容或跨 epoch 序号证明绝对新旧。
- Renderer 恢复链交叉复审：正式 `transcriptHydration.test.ts`、合并/挂载基线测试和 5 个独立临时场景联合 **47 pass / 94 assertions / 4 files**（包含上一条的重叠集合）。两个 bucket 的独立恢复通过；独立复现并由 runtime 修复了超限后本地输入丢失、已有流式指针掩盖序号缺口、首个超大 batch 取消时删除失败窗口、换 epoch 后旧指针误接新后缀四类边界。正式用例已覆盖这些修复；独立日志为 `/tmp/codeshell-polish-20260911/hydration-cross-review.log`。恢复失败时继续展示已有内容，未通过“推进高游标”冒充前缀已恢复。
- Mobile 协议与 Main 快照路由：`mobile-remote-types.ts` 的 `session.sync`、`session.snapshot`、`session.stream` 现在传递可选 epoch；`mobile-client-event-validator.ts` 拒绝空白、空值、错误类型、超长等无效代次。`handle-client-event.ts` 在客户端和 Main 代次均已知且不同时，从 0 重取当前快照，避免旧进程高游标过滤掉新事件；同代次保持增量读取。正式路由回归使用真实 `SessionSnapshotStore`，覆盖新旧代次、旧客户端、旧服务端和重启空快照；校验与路由合计先 **12 pass / 5 fail**，修后 **17 pass / 70 assertions / 2 files**，连同快照存储为 **28 pass / 97 assertions / 3 files**。core/server 无产物类型检查、局部 lint/format 通过，日志 `/tmp/codeshell-polish-20260911/mobile-server-epoch-suite.log`。Web 消费端联合验证见下一条；旧 peer 未携带 epoch 时只能维持增量兼容，无法保证跨 Main 重启的游标有效性。
- Mobile Web 恢复与路由组合：最新专项为 **91 pass / 297 assertions / 6 files**，日志 `/tmp/codeshell-polish-20260911/mobile-epoch-combined-final.log`，与上一条为重叠集合。真实 hook 回归覆盖活跃会话跨 Main 重启、首次 legacy 升级、snapshot/live 两种顺序、旧 socket 消息、复用工具 ID、被淘汰前缀，以及后台新代次切回后的 durable/snapshot 重叠。独立审查再修复第三个 epoch 错误清除 `historyUnpaired` 的情况：已经进入仅历史模式后，即使再次重启也继续保留屏障，直到历史返回后的新顶层 start。该分支是有提示的受限恢复，当前不宣称历史与实时内容在所有场景中无缝合并；最终全量构建与 Electron 验收另由主任务记录。
- 基线 65 skip 已按实际记录分组并逐项列入 [跳过测试审计](2026-09-11-skipped-test-audit.md)。其中 51 项 Panel 原本也由隔离 wrapper 执行；本轮另行显式执行并通过。真实本地 Whisper 与 HyperFrames 各 1 项额外开启并通过，全部使用已有运行时和合成临时样本。
- 后续 Panel 存储锁回归使默认 fixture 门控增加 1 条：最终门控构成为 66 条，其中 Panel 52 条全部在隔离子进程通过，本地 ASR/HyperFrames 2 条已额外通过，真实环境/外部验证仍为 12 条。原始 65 条的基线表与日志保留不变；这不是把默认 skip 减成 12，也不是出现一个未测功能。
- 上述均为单独专项结果，不与主任务全量测试数字相加，也不把 11231 pass / 65 skip / 23 fail / 1 error 的首次基线称为全绿。全量修复与最终安装版/Electron 验收以主任务结果为准。

## 未定位的验证风险

- 第六轮全量实际为 **11,452 pass / 66 skip / 1 fail**，唯一失败是 `media-tts.test.ts` 的 `literal command-looking text cannot execute through file based synthesis` 在约 **30,002 ms** 触发测试框架 timeout，原始日志 `final-full-tests-6.log` 保留。随后三个全新 Bun 进程真实独立重跑分别 **1,250.35 / 1,119.50 / 1,108.50 ms** 通过；相邻三文件组合 **17 pass / 159 assertions / 12.01 s** 通过，其中该用例 **1,226.64 ms**。诊断未发现残留 `say` 或 fixture `ffmpeg`/`ffprobe`；但原日志缺少阶段与 PID，尚不能定位触发点，也不能据此归因系统语音服务或 Bun。没有稳定产品缺陷证据，不扩大为 TTS 能力缺失；本次未调整 30 秒门限或实现。后续需补定位证据，并核对 fixture timeout 后的取消与清理。无论后续全量是否通过，本次未知超时都继续保留。独立日志为 `tts-literal-repeat-{1,2,3}.log` 和 `tts-literal-related-combination.log`，均位于 `/tmp/codeshell-polish-20260911/`。

## 同目录与同文件锁的补充核查

- Desktop trust 与 Session catalog：原 `trust-store.ts` 持目录锁跨 `await`，同进程 `SessionCatalogStore` 的同步锁重试堵住持有者续跑及心跳。真实 Node 调用原先停顿约 10,934 ms 并产生 `ECOMPROMISED` / `ERELEASED`；修复 trust 的有限大小读改写为持锁期间不让出执行，保留跨进程锁、原子替换、文件权限与落盘成功后才发布缓存的规则。相同原生探针修后约 2 ms、无异常；日志 `desktop-lock-trust-catalog-probe.log` 与 `desktop-lock-trust-catalog-fixed-probe.log` 均在 `/tmp/codeshell-polish-20260911/`。正式 trust/catalog/cache/workspace 组合为 **61 pass / 218 assertions / 4 files**，含 16 个进程并发写入和失败/腐败保护，日志 `trust-catalog-lock-final.log`。这是 trust 与 Session catalog 的实际调用冲突，不是 Profile repo catalog 的新功能。
- Panel storage 跨 bridge：`panel-app-bridge.ts:withStorageMutation` 的队列只属于单个实例，两个实例对同一个 app/project 存储文件并发时，第二个同步锁等待会堵住第一个持锁期间的异步读写。隔离 fixture 的真实文件锁回归先复现约 10,225 ms 停顿和锁心跳失效，修后约 145 ms 完成且保留两次写入。获取点改用 5 秒截止、每次立即尝试锁并等待 20 ms 的非阻塞重试；文件锁目标、权限、quota 与命名空间隔离不变，与 server Panel runtime 的获取策略一致。完整 fixture **52 pass / 294 assertions**；wrapper + storage store 为重叠的 **6 pass / 15 assertions**，Desktop 无产物类型检查、局部 lint/format 通过。日志前缀为 `panel-storage-contention-`。
- Panel 进程审批存储：两个 `PanelAppProcessApprovalStore` 实例并发 `remember()` 的探针原先约 10,502 ms，并出现锁已释放、心跳失效及只剩第二条审批；修改持锁的有限读改写为同步执行后约 51 ms，两条审批都保存、无未捕获异常。原有每实例队列和跨进程目录锁保留，拒绝不安全文件目标、审批 revision 失效和作用域约束未放宽；approval store 与实际 process service 联合 **15 pass / 48 assertions / 2 files**。前后日志为 `panel-approval-concurrency-before.log`、`panel-approval-concurrency-after.log`，正式回归为 `panel-approval-process-final.log`，均位于上述临时日志目录。
- Desktop settings 与 CredentialStore：同一个临时 `.code-shell` 根内，异步 `writeSettings` 持目录锁时调用同步凭据保存，原生 Node 探针先复现约 10,926 ms 停顿以及 `ECOMPROMISED` / `ERELEASED`。`settings-service.ts` 的持锁读改写改为同步执行，保持原有 patch/删除、腐败文件恢复、owner-only 临时文件与原子替换语义，未新增容量上限或更改凭据权限。修后相同探针约 104 ms（包含 100 ms 异常观察窗），设置及凭据均保留、无异常。settings、跨进程写入及 MCP patch 真实 writer 组合 **21 pass / 52 assertions / 3 files**，类型/lint/format 通过；日志 `settings-credentials-lock-probe.log`、`settings-credentials-lock-fixed-probe.log`、`settings-credentials-lock-final.log`。该修复针对实际共用目录锁的写入链，不代表所有存储 API 都改成异步等待。

当前 `main/index.ts` 只构造一个全局 `PanelAppBridge`；storage 的双 bridge 回归及 approval store 的双实例回归证明共享持久文件的接口并发边界，不能说成每个面板在现有生产流程都会构造独立 store，也不能把有界非阻塞获取写成所有锁竞争都不会消耗等待时间。

## Memory 独立存储根与写决策的最终边界

只读双根实验先确认：注入 `MemoryManager({baseDir})` 时，原编排只在部分 user 读取/TTL 使用该实例；新建 project/global manager、pending 晋升和 dream 辅链会回到 ambient 根。5 个观察用例 / 16 个断言证明原缺陷，日志 `/tmp/codeshell-polish-20260911/memory-basedir-repro.log` **不是修复后通过记录**。

本轮随后改为一致的存储上下文：

- `MemoryManager.getStorageContext()` 返回已解析 baseDir 与原始 projectDir；`MemoryOrchestrator` 的显式 baseDir 或注入 manager 决定所有目标，冲突配置在副作用前拒绝。等价路径选项继续使用注入实例原始项目 key，避免 `/workspace` 与 `/workspace/` 的记忆分桶漂移。
- ADD/UPDATE/DELETE、project/global user/dream 查询、global pending/project evidence/promotion 与 TTL 统一派生同根 manager；不把 ambient 记忆作为 custom 提取的候选，也不改动 ambient 数据。
- 显式根覆盖 session summary 与 dream cadence；driver 接收一致 baseDir，`runDreamConsolidation` 的读取、ownership guard 和实际 MemoryList/Read/Save/Delete 通过 `ToolContext.memoryBaseDir` 共享目标。
- **默认兼容**：没有显式根/注入 manager 时，MemoryManager 与 dream cadence 仍走 `CODE_SHELL_HOME` → `HOME/.code-shell`，session summary 仍采用原 HOME 默认；未偷偷统一两套历史默认。portable profile 的 `profileMemoryDir` 仍是独立第三层，正常工具可显式访问，自动 dream 继续禁写 profile。
- 正式新增隔离回归先 **1 pass / 5 fail**，完成后连同路径别名和 profile 场景共 **8 项通过**；默认路径、旧编排、scope、dream guard、并发计数与 profile 等联合 **46 pass / 213 assertions / 10 files**。Core `tsc --noEmit` 与局部 ESLint 通过，未为测试刷新 core/dist。原测试中的假 manager / 真实 HOME 摘要清理已替换为临时真实 manager。

后续 canonical 复核另确认了词袋回退覆盖方向/否定/数值不同事实的问题。修后 auto/dream 只有 type/location/name/description/content 完全相同才由 fallback NOOP，其余 ADD；只有明确的模型 UPDATE 且 ownership 通过才更新。15 个新增 canonical 回归及相关旧用例联合 **66 pass / 257 assertions / 9 files**。模型返回无效决策时可能保留日期/表述重复；旧正文尚未进入有界 write-decision prompt，同批不同表述候选仍看不到刚新增记录，均保留真实 TODO。上述专项集合有重叠，不相加为全量测试次数。

## 文档与源码完整清单

下方由本次文件枚举生成；`历史/实施依据` 只说明文档用途，具体未完成后续仍以上述逐项结论和根 TODO 为准。

### 全部设计/待办文档（开始时 75 份）

| 文档                                                                                                                       | 当前用途/状态                                    | 原未勾数 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------: |
| [2026-07-22-codex-tasks.md](2026-07-22-codex-tasks.md)                                                                     | 历史/实施依据，原状态可能过期                    |        0 |
| [2026-07-22-overall-roadmap.md](2026-07-22-overall-roadmap.md)                                                             | 历史/实施依据，原状态可能过期                    |        0 |
| [README.md](README.md)                                                                                                     | 导航索引（本轮校正）                             |        0 |
| [agent-evals-platforms-and-adapters.md](agent-evals-platforms-and-adapters.md)                                             | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [agent-module-resolved-composition-design.md](agent-module-resolved-composition-design.md)                                 | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [agent-optimization-agent.md](agent-optimization-agent.md)                                                                 | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [agent-reliability-and-context-optimization.md](agent-reliability-and-context-optimization.md)                             | 前瞻设计；未作为本轮已实现宣称                   |       28 |
| [arch-debt-p1p2-plan.md](arch-debt-p1p2-plan.md)                                                                           | 历史/实施依据，原状态可能过期                    |        0 |
| [architecture-debt.md](architecture-debt.md)                                                                               | 历史/实施依据，原状态可能过期                    |        0 |
| [browser-automation-library-reuse.md](browser-automation-library-reuse.md)                                                 | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [browser-profile-workspace-lease-design.md](browser-profile-workspace-lease-design.md)                                     | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [bug-status-core.md](bug-status-core.md)                                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [bug-status-desktop-main.md](bug-status-desktop-main.md)                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [bug-status-renderer-tui.md](bug-status-renderer-tui.md)                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [claude-repository-optimization-2026-08-30.md](claude-repository-optimization-2026-08-30.md)                               | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [codeshell-harness-evals.md](codeshell-harness-evals.md)                                                                   | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [codeshell-hub-iteration-design.md](codeshell-hub-iteration-design.md)                                                     | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [codeshell-hub-remote-service-architecture.md](codeshell-hub-remote-service-architecture.md)                               | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [codex-cloud-remote-tasks-design.md](codex-cloud-remote-tasks-design.md)                                                   | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [context-notes-strategy.md](context-notes-strategy.md)                                                                     | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [core-harness-and-plugin-panels.md](core-harness-and-plugin-panels.md)                                                     | 历史/实施依据，原状态可能过期                    |        0 |
| [core-universalize-plugin-panel-design.md](core-universalize-plugin-panel-design.md)                                       | 历史/实施依据，原状态可能过期                    |        0 |
| [credentials-partition-mismatch-plan.md](credentials-partition-mismatch-plan.md)                                           | 历史/实施依据，原状态可能过期                    |        0 |
| [engine-split-plan.md](engine-split-plan.md)                                                                               | 历史/实施依据，原状态可能过期                    |        0 |
| [evidence/README.md](evidence/README.md)                                                                                   | 历史真二进制证据，不作为本轮重跑                 |        0 |
| [external-agent-runtime-tool-bridge-design.md](external-agent-runtime-tool-bridge-design.md)                               | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [github-link-local-first-tech-design.md](github-link-local-first-tech-design.md)                                           | 主体已落地 + 后续/旧设计混合，需按阶段看         |       20 |
| [gpt-cache-optimization-2026-09-06.md](gpt-cache-optimization-2026-09-06.md)                                               | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [gpt-cache-root-cause-2026-09-06.md](gpt-cache-root-cause-2026-09-06.md)                                                   | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [hub-usability-polish.md](hub-usability-polish.md)                                                                         | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [im-gateway-remote-orchestration.md](im-gateway-remote-orchestration.md)                                                   | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [im-gateway-research.md](im-gateway-research.md)                                                                           | 历史/实施依据，原状态可能过期                    |        0 |
| [link-headless-server-feasibility.md](link-headless-server-feasibility.md)                                                 | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [link-server-oauth-architecture.md](link-server-oauth-architecture.md)                                                     | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [mcp-http-auth-oauth-link-tech-design.md](mcp-http-auth-oauth-link-tech-design.md)                                         | 历史/实施依据，原状态可能过期                    |        0 |
| [memory-final-design.md](memory-final-design.md)                                                                           | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [memory-mem0-memgpt-eval.md](memory-mem0-memgpt-eval.md)                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [memory-redesign-eval.md](memory-redesign-eval.md)                                                                         | 历史/实施依据，原状态可能过期                    |        0 |
| [memory-redesign-p0-plan.md](memory-redesign-p0-plan.md)                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [memory-simple-plan-eval.md](memory-simple-plan-eval.md)                                                                   | 历史/实施依据，原状态可能过期                    |        0 |
| [mimi-architecture-review-2026-09-05.md](mimi-architecture-review-2026-09-05.md)                                           | 前瞻设计；未作为本轮已实现宣称                   |        0 |
| [mimi-chat-replay-2026-09-06.md](mimi-chat-replay-2026-09-06.md)                                                           | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [mimi-im-session-bridge-design.md](mimi-im-session-bridge-design.md)                                                       | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [mimi-im-session-bridge-review-2026-09-03.md](mimi-im-session-bridge-review-2026-09-03.md)                                 | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [mobile-remote-optimizations.md](mobile-remote-optimizations.md)                                                           | 历史/实施依据，原状态可能过期                    |        0 |
| [multi-folder-local-project-plan.md](multi-folder-local-project-plan.md)                                                   | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [parent-child-bidirectional-notification-phase0-design.md](parent-child-bidirectional-notification-phase0-design.md)       | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [prompt-cache-optimization.md](prompt-cache-optimization.md)                                                               | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [roadmap.md](roadmap.md)                                                                                                   | 早期产品方向；不是当前缺陷清单                   |        0 |
| [session-cumulative-cache-usage-plan.md](session-cumulative-cache-usage-plan.md)                                           | 历史/实施依据，原状态可能过期                    |        0 |
| [shared-web-workbench.md](shared-web-workbench.md)                                                                         | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-CORE.md](small-features-2026-07-10/PIPELINE-SUMMARY-CORE.md)                   | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-CROSSCUT.md](small-features-2026-07-10/PIPELINE-SUMMARY-CROSSCUT.md)           | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-QCBEHAVIOR.md](small-features-2026-07-10/PIPELINE-SUMMARY-QCBEHAVIOR.md)       | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-QCLIFE.md](small-features-2026-07-10/PIPELINE-SUMMARY-QCLIFE.md)               | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-QUICKCHAT.md](small-features-2026-07-10/PIPELINE-SUMMARY-QUICKCHAT.md)         | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/PIPELINE-SUMMARY-UI.md](small-features-2026-07-10/PIPELINE-SUMMARY-UI.md)                       | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/browser-panel-copy-address.md](small-features-2026-07-10/browser-panel-copy-address.md)         | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/driveagent-jump-to-cli-session.md](small-features-2026-07-10/driveagent-jump-to-cli-session.md) | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/goal-judge-context.md](small-features-2026-07-10/goal-judge-context.md)                         | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/mcp-http-oauth.md](small-features-2026-07-10/mcp-http-oauth.md)                                 | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/mobile-remote-send-image.md](small-features-2026-07-10/mobile-remote-send-image.md)             | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/naming-consolidation.md](small-features-2026-07-10/naming-consolidation.md)                     | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/prompt-cache-deepen.md](small-features-2026-07-10/prompt-cache-deepen.md)                       | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/quickchat-align-side.md](small-features-2026-07-10/quickchat-align-side.md)                     | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/review-panel-wrong-cwd.md](small-features-2026-07-10/review-panel-wrong-cwd.md)                 | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/session-fork.md](small-features-2026-07-10/session-fork.md)                                     | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [small-features-2026-07-10/split-engine-ts.md](small-features-2026-07-10/split-engine-ts.md)                               | 历史计划/实施记录；已落地批次，局部后续见正文    |        0 |
| [smoke-automation-mock-provider.md](smoke-automation-mock-provider.md)                                                     | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [video-studio-panel.md](video-studio-panel.md)                                                                             | 产品设计；媒体宿主在工作区实施，面板仓库另行核验 |        0 |
| [web-panels-validation.md](web-panels-validation.md)                                                                       | 当前实现或历史验证记录；外部验收单独计           |        0 |
| [workspace-datasource-binding-adr.md](workspace-datasource-binding-adr.md)                                                 | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [workspace-profile-讨论稿.md](workspace-profile-讨论稿.md)                                                                 | 历史/实施依据，原状态可能过期                    |        0 |
| [worktree-session-isolation-research.md](worktree-session-isolation-research.md)                                           | 主体已落地 + 后续/旧设计混合，需按阶段看         |        0 |
| [xiaohongshu-automation-session-troubleshooting.md](xiaohongshu-automation-session-troubleshooting.md)                     | 真实使用排查记录；登录态依赖外部验证             |        0 |

### 全部源码标记命中

本表按本轮源码收口时的共享工作区重新扫描：**160 个命中行 / 162 个 TODO 单词 / 91 个文件**，未发现独立 `FIXME/HACK/XXX`。只统计源码/测试/脚本范围，不把本报告自己的 TODO 文本计入。一个文件多处命中列出全部行号；这些数字包含已实现行为的追溯标签，并非未修缺陷数量。

| 源文件                                                                                                                                                     | 全部命中行                   | 判定                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| [packages/coding/src/tools/apply-patch/atomicity.test.ts](../../packages/coding/src/tools/apply-patch/atomicity.test.ts)                                   | 8                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/agent/agent-definition.skills.test.ts](../../packages/core/src/agent/agent-definition.skills.test.ts)                                   | 4                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/cli/agent-server-stdio.ts](../../packages/core/src/cli/agent-server-stdio.ts)                                                           | 236, 242                     | 真实架构后续：共享 MCP/成本               |
| [packages/core/src/context/dedupe-file-reads.test.ts](../../packages/core/src/context/dedupe-file-reads.test.ts)                                           | 5                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/\_\_tests\_\_/engine-config-hot-reload.test.ts](../../packages/core/src/engine/__tests__/engine-config-hot-reload.test.ts)       | 84                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/engine.permission-rules.test.ts](../../packages/core/src/engine/engine.permission-rules.test.ts)                                 | 6                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/engine.ts](../../packages/core/src/engine/engine.ts)                                                                             | 382, 2456, 4070, 4100        | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/friendly-error.ts](../../packages/core/src/engine/friendly-error.ts)                                                             | 3                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/runtime.sandbox-cache.test.ts](../../packages/core/src/engine/runtime.sandbox-cache.test.ts)                                     | 6                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/turn-loop.ts](../../packages/core/src/engine/turn-loop.ts)                                                                       | 362, 466                     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/engine/types.ts](../../packages/core/src/engine/types.ts)                                                                               | 65                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/goal/lifecycle.test.ts](../../packages/core/src/goal/lifecycle.test.ts)                                                                 | 108, 137, 168, 383           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/goal/lifecycle.ts](../../packages/core/src/goal/lifecycle.ts)                                                                           | 657                          | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/llm/model-pool.ts](../../packages/core/src/llm/model-pool.ts)                                                                           | 74, 76, 78, 80, 299, 303     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/llm/provider-auth.ts](../../packages/core/src/llm/provider-auth.ts)                                                                     | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/llm/provider-catalog.ts](../../packages/core/src/llm/provider-catalog.ts)                                                               | 16, 18                       | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/llm/providers/anthropic.ts](../../packages/core/src/llm/providers/anthropic.ts)                                                         | 88                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/llm/providers/openai.ts](../../packages/core/src/llm/providers/openai.ts)                                                               | 333, 627, 674                | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/plugins/pluginCommandHook.test.ts](../../packages/core/src/plugins/pluginCommandHook.test.ts)                                           | 5                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/prompt/composer.ts](../../packages/core/src/prompt/composer.ts)                                                                         | 99                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/prompt/instruction-scanner.test.ts](../../packages/core/src/prompt/instruction-scanner.test.ts)                                         | 7                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/protocol/chat-session.ts](../../packages/core/src/protocol/chat-session.ts)                                                             | 263                          | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/protocol/server.ts](../../packages/core/src/protocol/server.ts)                                                                         | 2381, 2828, 3277             | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/protocol/types.ts](../../packages/core/src/protocol/types.ts)                                                                           | 620, 630                     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/run/RunManager.resume-race.test.ts](../../packages/core/src/run/RunManager.resume-race.test.ts)                                         | 10                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/runtime/truncate-output.ts](../../packages/core/src/runtime/truncate-output.ts)                                                         | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/services/extract-memories.test.ts](../../packages/core/src/services/extract-memories.test.ts)                                           | 8                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/session/memory.maxage.test.ts](../../packages/core/src/session/memory.maxage.test.ts)                                                   | 19                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/session/memory.ts](../../packages/core/src/session/memory.ts)                                                                           | 56, 117                      | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/settings/feature-flags.test.ts](../../packages/core/src/settings/feature-flags.test.ts)                                                 | 10                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/settings/migrate-config.ts](../../packages/core/src/settings/migrate-config.ts)                                                         | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/settings/schema.ts](../../packages/core/src/settings/schema.ts)                                                                         | 152, 185                     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/skills/scanner.allowlist.test.ts](../../packages/core/src/skills/scanner.allowlist.test.ts)                                             | 7                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/agent-types-block.test.ts](../../packages/core/src/tool-system/builtin/agent-types-block.test.ts)                   | 58                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/agent.ts](../../packages/core/src/tool-system/builtin/agent.ts)                                                     | 284, 965                     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/bash.ts](../../packages/core/src/tool-system/builtin/bash.ts)                                                       | 156, 168                     | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/generate-image.tool.test.ts](../../packages/core/src/tool-system/builtin/generate-image.tool.test.ts)               | 146                          | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/generate-image.ts](../../packages/core/src/tool-system/builtin/generate-image.ts)                                   | 168, 271, 307                | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/generate-video.ts](../../packages/core/src/tool-system/builtin/generate-video.ts)                                   | 2, 10, 176, 184, 206         | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/image-providers.ts](../../packages/core/src/tool-system/builtin/image-providers.ts)                                 | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/path-policy-approval-unify.test.ts](../../packages/core/src/tool-system/builtin/path-policy-approval-unify.test.ts) | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/skill.allowlist.test.ts](../../packages/core/src/tool-system/builtin/skill.allowlist.test.ts)                       | 9                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/builtin/video-providers.ts](../../packages/core/src/tool-system/builtin/video-providers.ts)                                 | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/mcp-manager.ts](../../packages/core/src/tool-system/mcp-manager.ts)                                                         | 1014                         | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/path-policy-approval.test.ts](../../packages/core/src/tool-system/path-policy-approval.test.ts)                             | 12                           | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/tool-system/permission.session-cache.test.ts](../../packages/core/src/tool-system/permission.session-cache.test.ts)                     | 2                            | 已实现行为的编号/历史追溯标签             |
| [packages/core/src/types.ts](../../packages/core/src/types.ts)                                                                                             | 651, 653, 868, 874, 878, 880 | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/main/desktop-services.ts](../../packages/desktop/src/main/desktop-services.ts)                                                       | 156, 190, 619                | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/preload/index.ts](../../packages/desktop/src/preload/index.ts)                                                                       | 38, 567, 627                 | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/preload/types.d.ts](../../packages/desktop/src/preload/types.d.ts)                                                                   | 254, 1066, 1123              | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/App.tsx](../../packages/desktop/src/renderer/App.tsx)                                                                       | 384, 439, 2226               | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/ChatView.tsx](../../packages/desktop/src/renderer/ChatView.tsx)                                                             | 147, 154, 1361, 1929         | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/Markdown.test.tsx](../../packages/desktop/src/renderer/Markdown.test.tsx)                                                   | 157                          | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/MessageStream.tsx](../../packages/desktop/src/renderer/MessageStream.tsx)                                                   | 80                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/app/useRunController.ts](../../packages/desktop/src/renderer/app/useRunController.ts)                                       | 968, 1081                    | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/cc-room/CCRoomView.tsx](../../packages/desktop/src/renderer/cc-room/CCRoomView.tsx)                                         | 83                           | 加载更多重试已修；列表发现/收敛后续仍保留 |
| [packages/desktop/src/renderer/chat/OpenWithMenu.tsx](../../packages/desktop/src/renderer/chat/OpenWithMenu.tsx)                                           | 32                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/chat/attachments.test.ts](../../packages/desktop/src/renderer/chat/attachments.test.ts)                                     | 14                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/chat/attachments.ts](../../packages/desktop/src/renderer/chat/attachments.ts)                                               | 56, 170                      | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/chat/openWith.ts](../../packages/desktop/src/renderer/chat/openWith.ts)                                                     | 4                            | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx)                                 | 28                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/diff/reviewScope.ts](../../packages/desktop/src/renderer/diff/reviewScope.ts)                                               | 4                            | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/markdown/remarkPathLinks.test.ts](../../packages/desktop/src/renderer/markdown/remarkPathLinks.test.ts)                     | 200                          | TODO.md 文件名/测试样例，不是待办         |
| [packages/desktop/src/renderer/markdown/remarkPathLinks.ts](../../packages/desktop/src/renderer/markdown/remarkPathLinks.ts)                               | 151                          | TODO.md 文件名/测试样例，不是待办         |
| [packages/desktop/src/renderer/messages/FilesChangedCard.tsx](../../packages/desktop/src/renderer/messages/FilesChangedCard.tsx)                           | 170                          | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/messages/GoalProgressView.tsx](../../packages/desktop/src/renderer/messages/GoalProgressView.tsx)                           | 37                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/messages/TurnEndMessageView.tsx](../../packages/desktop/src/renderer/messages/TurnEndMessageView.tsx)                       | 7                            | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/messages/fileChangeAggregator.ts](../../packages/desktop/src/renderer/messages/fileChangeAggregator.ts)                     | 315                          | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx](../../packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx)                       | 71                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/panels/FilesPanel.tsx](../../packages/desktop/src/renderer/panels/FilesPanel.tsx)                                           | 91, 433, 527, 548            | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/panels/PanelArea.tsx](../../packages/desktop/src/renderer/panels/PanelArea.tsx)                                             | 82, 95, 108, 227             | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/panels/ReviewPanel.tsx](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx)                                         | 29, 36, 84, 89               | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/settings/AdvancedSections.tsx](../../packages/desktop/src/renderer/settings/AdvancedSections.tsx)                           | 1120                         | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/settings/McpSection.tsx](../../packages/desktop/src/renderer/settings/McpSection.tsx)                                       | 88, 718                      | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/settingsBus.ts](../../packages/desktop/src/renderer/settingsBus.ts)                                                         | 12                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx](../../packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx)                           | 24                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/tool-cards/attachments.test.ts](../../packages/desktop/src/renderer/tool-cards/attachments.test.ts)                         | 60, 66, 85, 86               | TODO.md 文件名/测试样例，不是待办         |
| [packages/desktop/src/renderer/tool-cards/attachments.ts](../../packages/desktop/src/renderer/tool-cards/attachments.ts)                                   | 68                           | TODO.md 文件名/测试样例，不是待办         |
| [packages/desktop/src/renderer/tool-cards/utils.test.ts](../../packages/desktop/src/renderer/tool-cards/utils.test.ts)                                     | 19                           | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/types.test.ts](../../packages/desktop/src/renderer/types.test.ts)                                                           | 87, 157                      | 已实现行为的编号/历史追溯标签             |
| [packages/desktop/src/renderer/types.ts](../../packages/desktop/src/renderer/types.ts)                                                                     | 32, 178, 180, 198, 1698      | 已实现行为的编号/历史追溯标签             |
| [packages/tui/src/cli/commands/builtin/init/index.ts](../../packages/tui/src/cli/commands/builtin/init/index.ts)                                           | 15                           | 生成模板/用户占位规则，不是代码待办       |
| [packages/tui/src/cli/commands/builtin/init/templates/empty.md](../../packages/tui/src/cli/commands/builtin/init/templates/empty.md)                       | 42, 46                       | 生成模板/用户占位规则，不是代码待办       |
| [packages/tui/src/cli/commands/builtin/permissions-command.ts](../../packages/tui/src/cli/commands/builtin/permissions-command.ts)                         | 30                           | 已实现行为的编号/历史追溯标签             |
| [packages/tui/src/cli/commands/repl.ts](../../packages/tui/src/cli/commands/repl.ts)                                                                       | 206, 209                     | 真实架构后续：共享 MCP/成本               |
| [packages/tui/src/cli/commands/run.ts](../../packages/tui/src/cli/commands/run.ts)                                                                         | 173, 176                     | 真实架构后续：共享 MCP/成本               |
| [packages/tui/src/render/events/input-event.ts](../../packages/tui/src/render/events/input-event.ts)                                                       | 50, 95                       | major 兼容策略，不盲删                    |
| [packages/tui/src/render/screen.ts](../../packages/tui/src/render/screen.ts)                                                                               | 688                          | 历史/注释漂移；见专项核查                 |
| [tests/model-pool-resolve.test.ts](../../tests/model-pool-resolve.test.ts)                                                                                 | 73                           | 已实现行为的编号/历史追溯标签             |
| [tests/stream-groups.test.ts](../../tests/stream-groups.test.ts)                                                                                           | 94                           | 已实现行为的编号/历史追溯标签             |
| [tests/turn-loop-on-stop.test.ts](../../tests/turn-loop-on-stop.test.ts)                                                                                   | 280                          | 已实现行为的编号/历史追溯标签             |
