# docs/todo — 设计与待办索引

> 当前可执行待办以根 [TODO.md](../../TODO.md) 为准；能力现状见 [全量能力盘点](../architecture/11-feature-inventory.md)。
> 2026-09-11 复核：本目录混有前瞻设计、已实现方案、历史审计和真实验证证据。“未动手”的旧文首与未勾 checkbox 不能单独证明功能缺失。
> 全部 75 份原有 Markdown、48 个未勾验收和源码 TODO 的逐项分类见 [夜间 TODO 核查](2026-09-11-overnight-todo-audit.md)。本轮保留旧文档路径，避免破坏已有源码/设计引用。
> 全量基线的 65 项 skip 原因与本机可执行集成结果见 [跳过测试审计](2026-09-11-skipped-test-audit.md)；跳过标记不等于功能未实现。

## 仍有明确后续的设计

| 文档                                                                                                                                         | 当前状态与剩余范围                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [独立 Link Server](link-server-oauth-architecture.md)                                                                                        | 独立服务与双向 OAuth 尚未实现；现有本地 Link/Hub 管理能力不是该服务                                                       |
| [Hub 迭代](codeshell-hub-iteration-design.md) / [远程服务架构](codeshell-hub-remote-service-architecture.md)                                 | 单管理员部署、共享工作台和基础 Web Panel 已实现；语义协议、远端原生窗口、完整 Panel 适配及多用户后置                      |
| [AgentModule / ResolvedComposition](agent-module-resolved-composition-design.md)                                                             | Phase A/B 已实现；Phase C lifetime/disposer 与 Phase D 请求边界仍待做                                                     |
| [Agent 可靠性与上下文](agent-reliability-and-context-optimization.md)                                                                        | 大部分 Operation/Capability/评测设计仍待实现；09-03 缓存与若干旧缺口已被后续修复覆盖                                      |
| [聊天历史恢复边界](2026-09-11-overnight-todo-audit.md)                                                                                       | 有界快照/实时交接、重试和 epoch 隔离已补回归；必要前缀淘汰时保留可见内容并报告失败，完整 durable raw 长段恢复仍需设计     |
| [Harness 评测](codeshell-harness-evals.md) / [通用评测层](agent-evals-platforms-and-adapters.md) / [优化 Agent](agent-optimization-agent.md) | 设计阶段；未接入平台、上传真实会话或运行完整模型对照实验                                                                  |
| [Codex Cloud 远程任务](codex-cloud-remote-tasks-design.md)                                                                                   | 方向核验与取舍；原生 Cloud 接入未实现，不与本地 Codex runtime 混称                                                        |
| [Memory 最终设计](memory-final-design.md)                                                                                                    | P0/P1 已实现；P2 按决策挂起；description、严格同批重复、保守 fallback 与 baseDir 已修；剩余同批上下文刷新、旧正文有界对照 |
| [Workspace 数据源 ADR](workspace-datasource-binding-adr.md)                                                                                  | 只读 MVP 已实现；Profile 求交、写操作、真实 adapter 和解析索引后续                                                        |
| [WorkspaceProfile 历史讨论](workspace-profile-讨论稿.md)                                                                                     | MVP、portable memory、导入导出和仓库分发已实现；经验运营、完整依赖编辑、plugin 降级仍可规划                               |
| [Worktree / Session 隔离](worktree-session-isolation-research.md)                                                                            | DriveAgent 外部运行时隔离已实现；原生 Agent 隔离是独立后续，不能把旧外部隔离缺口重复实施                                  |
| [视频工作台](video-studio-panel.md)                                                                                                          | 产品草案；媒体宿主能力已有在途实现，具体面板工程与验收需另看对应面板仓库                                                  |
| [早期 Roadmap](roadmap.md)                                                                                                                   | 保留产品方向；Arena 已抽包、HTTP serve 已实现，不再按旧状态表排工                                                         |

## 已实现主体，保留设计依据或后续验证

| 文档                                                                                                                 | 本次复核结论                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [浏览器 Profile / Workspace / 租约](browser-profile-workspace-lease-design.md)                                       | shared profile、workspace、tab control 与生产接线已存在；不再标“未动手”，进一步迁移按现有实现规划        |
| [浏览器自动化库复用](browser-automation-library-reuse.md)                                                            | Electron/扩展 Puppeteer、独立 Playwright 路径已实现；安装版与扩展重载后的真实环境验收单独记录            |
| [外部 Runtime 工具桥](external-agent-runtime-tool-bridge-design.md)                                                  | Codex/Claude、SessionToolHost、工具桥与产品入口已接通；旧文中 Panel/审批限制需要按当前实现复核           |
| [Mimi 进入 Work Session](mimi-im-session-bridge-design.md) / [早期评审](mimi-im-session-bridge-review-2026-09-03.md) | ConversationSessionRoute、持久路由、访问收据、IM bound-session 与 durable outbox 已实现                  |
| [父子双向通知](parent-child-bidirectional-notification-phase0-design.md)                                             | mailbox direction/progress/result、running child 路由与 tree ACL 已实现；原“只设计不实现”是历史快照      |
| [多文件夹项目](multi-folder-local-project-plan.md)                                                                   | project roots、主目录迁移、multi-root 路径策略与 Desktop 接线已实现；外部 runtime 等非目标仍保留         |
| [GitHub Link 本地优先](github-link-local-first-tech-design.md)                                                       | PAT/CLI、读操作、逐次写审批和断开机制已实现；旧 WorkspaceLinkGrant/ActionSpec 架构未照搬，真账号验证另计 |
| [MCP HTTP Auth / OAuth](mcp-http-auth-oauth-link-tech-design.md)                                                     | 认证配置、login/refresh/logout 与 host 服务已实现；不再以早期“未动手”作状态结论                          |
| [IM Gateway](im-gateway-remote-orchestration.md)                                                                     | Phase 1–3 代码闭环、通道、inbox/outbox 与运维入口已实现；真实平台 canary 要显式提供测试条件              |
| [Prompt cache](prompt-cache-optimization.md) / [09-06 实现验证](gpt-cache-optimization-2026-09-06.md)                | 通用缓存与 GPT hybrid 已实现并有短样本真实证据；Responses/20+轮基线与长期成本仍待评估                    |
| [Session 累计 cache usage](session-cumulative-cache-usage-plan.md)                                                   | 累计、落盘、恢复与切模型处理已实现；旧“方案未动手”过期                                                   |
| [会话 notes 策略](context-notes-strategy.md)                                                                         | 原生 notes/save/new-context/history 已实现；连续长程笔记质量与成本仍需真实使用评估                       |
| [Mimi 架构复核](mimi-architecture-review-2026-09-05.md) / [聊天回放](mimi-chat-replay-2026-09-06.md)                 | 设计与后续实现并存；离线回放不能替代全部真实 IM 长程验收                                                 |
| [共享 Web 工作台](shared-web-workbench.md) / [Link 服务端现状](link-headless-server-feasibility.md)                  | 当前实现说明；Desktop Web 与 Hub 共用业务管理服务                                                        |
| [Hub 打磨验收](hub-usability-polish.md) / [Web Panel 验收](web-panels-validation.md)                                 | 09-08/09-09 历史验证和部署证据；不是 09-11 新改动的重跑记录                                              |
| [Smoke 自动化](smoke-automation-mock-provider.md)                                                                    | v1 和 CI 已实现；发布产物层与条件式集成用例单独验收                                                      |

## 历史计划与审计

[架构债](architecture-debt.md)、[P1/P2 实施记录](arch-debt-p1p2-plan.md)、[Core harness 与插件面板](core-harness-and-plugin-panels.md)、[插件面板技术设计](core-universalize-plugin-panel-design.md)、[Engine 拆分旧稿](engine-split-plan.md)、[凭证 partition 旧稿](credentials-partition-mismatch-plan.md) 和 [07-10 小 feature 批次](small-features-2026-07-10/PIPELINE-SUMMARY-CORE.md) 含已完成或已被后续实现替代的阶段，不宜整篇当作开放工单。

[08-30 全仓优化](claude-repository-optimization-2026-08-30.md) 的 C4 记忆正文原子写、C5 WS 上限/pending TTL 与 onboarding 并发写已在当前代码解决；其历史残余项按本轮审计重新判定。三份 [Core](bug-status-core.md)、[Desktop main](bug-status-desktop-main.md)、[Renderer/TUI](bug-status-renderer-tui.md) bug 状态文档保留历史修复证据。

## 维护约定

- 新设计在本目录登记，并写清“设计 / 在途 / 已实现 / 待外部验证”，避免把文档存在等同于功能承诺。
- 完成的待办从根 TODO 删除，设计保留时及时改索引状态；整体迁入 `docs/archive/` 前核对反向引用。
- 不依据历史测试次数、旧行号、未回勾 checkbox 或源码编号 TODO 宣称当前实现未完成或已验收。
