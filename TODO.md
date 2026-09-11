# TODO

> 本文件只保留**未完成**的待办；已完成实现与历史验收见 Git 历史和 [能力盘点](docs/architecture/11-feature-inventory.md)。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-09-11。完整来源、源码标记、设计文档和未勾验收判定见 [夜间 TODO 核查](docs/todo/2026-09-11-overnight-todo-audit.md)。本次检查的是共享工作区，包含既有未提交改动，不代表这些改动已经发布。

## 小 feature（体量 M 及以下）

- **Link 真账号 / 真 token 验证**（S，验证任务）。各 provider 仍需授权账号验证 action 响应与错误形状；现有 stub、契约和本地 CLI 测试不能代替真实账号验收。执行时按 provider 单独记录，不写入用户真实数据来代替只读验证。
- **数字人依赖编辑补齐**（S/M）。编辑器已能配置缺失 Skill 的安装源并保留 `requires`，但任意依赖项与外部 `tools` 的图形化增删尚未完整开放。数字人 JSON 导入导出、仓库分发和原地更新按钮都已实现，不再重复排期。发布目前生成仓库骨架，`git init/push` 仍是用户自行完成的后续步骤。
- **TUI 子 agent 待办详情**（S）。主/子 `task_update` 已按 `agentId` 隔离，主待办不会串入子视图；后续可为每个子 agent 保留自己的 TodoWrite 快照并显示。不要再按旧 TaskCreate/Update singleton 设计实现。
- **macOS TTS 偶发测试超时定位**（S，验证任务）。第六轮全量中 `media-tts.test.ts` 的 literal 文本合成用例在 30 秒超时，随后三个独立进程重跑及相邻组合均通过，尚无稳定产品缺陷证据。需补阶段/PID 定位信息，并核对 fixture 超时后的取消清理；保留失败记录，不放宽 30 秒门限、不将其列为 TTS 功能缺失。证据见夜间核查。
- **记忆提取后续精修**（S/M）。同批不同表述候选仍需刷新决策上下文；写决策模型尚需加入有界的旧正文对照。description、严格同批重复、独立存储根透传与保守 fallback 已补齐：相似度不再自动触发 UPDATE，auto/dream 只有完整字段严格相同才由 fallback NOOP；其他回退为 ADD，明确的模型 UPDATE 仍受 ownership 保护。模型失败时可能暂留重复，不能为了去重覆盖方向、否定或数值不同的事实；manual 相近主题继续保守跳过。来源见 [Memory Final Design](docs/todo/memory-final-design.md)。

## 大功能升级（体量 L，分阶段落地）

- **独立 Link Server + 双向 OAuth2**。独立 Node/Docker 服务，上游保管和刷新第三方凭据，下游给 CodeShell 与其他应用签发按连接、操作、数据范围限制的授权；先单 owner、多应用、GitHub 只读闭环。client、同意页、grant、令牌轮换和撤销尚未实现，第三方原始 token 不下发。见 [Link Server 架构](docs/todo/link-server-oauth-architecture.md)。当前 Desktop/Hub 的本地 Link 管理不是该独立服务。
- **Hub 与 Web 后续**。当前已有单管理员登录/设备撤销、Node/Docker 部署、共享 Web 工作台、模型/Skills/MCP/Link 管理、历史文件和基础 Web Panel；HTTPS 指引与隔离容器验收也已有记录。剩余是两宿主语义协议统一、Electron 原生窗口选择远端 Hub、独立 Hub 多 Workspace、插件市场，以及媒体/音频/Cookie/自动化/PDF 等完整原生 Panel SDK 的 Web 适配。多用户 Runtime/凭据/CLI HOME 隔离仍后置。见 [共享工作台](docs/todo/shared-web-workbench.md)、[Hub 迭代方案](docs/todo/codeshell-hub-iteration-design.md)、[Web 面板](docs/web-panels.md)。历史容器验收不表示本轮新增源码已重新构建部署。
- **Workspace / Profile / 数字人后续**。现有 MVP、Session 绑定、portable memory 读写/编辑、JSON 导入导出和 Git 仓库分发保留。剩余包括项目经验提升为数字人经验的运营流程、受约束的数字人 dream 策略、切换影响预览，以及导出降级为 plugin。自动 dream 目前明确不写 portable profile memory；变更前需要单独确定 ownership 和审批语义。见 [数字人与 Pet 架构](docs/architecture/14-digital-human-and-pet.md) 和 [Profile 历史设计](docs/todo/workspace-profile-讨论稿.md)。
- **Workspace 数据源后续**。mock / mcp-resource / local-files 的只读 MVP 已落地。剩余是更多真实 provider adapter、Profile 求交接线、写操作和上传文件解析/索引。`sources/resolve.ts` 的 `profile` 参数仍只是预留；当前不能宣称按 Profile 限制数据源。见 [数据源 ADR](docs/todo/workspace-datasource-binding-adr.md)。
- **运行时共享资源与生命周期**。runtime 级 MCP 连接聚合、跨 Session 成本汇总，以及 [AgentModule](docs/todo/agent-module-resolved-composition-design.md) Phase C 的 lifetime/disposer 和 Phase D 的请求边界证据仍待推进。现有 per-session MCP、成本统计和 composition compiler 已工作，不能为清理占位注释改变隔离边界。
- **可靠性与评测体系**。统一 Capability/Operation Controller、结构化 VerifiedWriteResult、错误分类/熔断、Skill 列表预算、非核心工具渐进发现、真实长程 cache/notes 回放与按模型评估尚未完整实施。GPT-5.6 hybrid cache 已有短样本真实验证，Responses API / `previous_response_id` 仍是独立评估项。见 [可靠性方案](docs/todo/agent-reliability-and-context-optimization.md)、[Harness 评测](docs/todo/codeshell-harness-evals.md)、[通用评测层](docs/todo/agent-evals-platforms-and-adapters.md)、[优化 Agent](docs/todo/agent-optimization-agent.md)。
- **聊天历史的长程流式恢复**。运行中的快照已淘汰必要流式前缀、或恢复缓冲超限后无法补齐时，当前明确显示恢复失败、保留可见内容并阻止不完整恢复写入缓存；从 durable raw 历史完整恢复正在生成的长段内容仍需后续设计。Mobile 在后台发现新 Main 代次后切回会话时，因保存的 history 与 snapshot 没有共同游标，当前保留 durable 历史并提示实时部分暂不能接续，不直接叠加完整快照；历史返回后，下一个顶层回合开始才恢复实时接收。旧版 peer 未携带 epoch 时仍无法保证跨 Main 重启的游标有效性。本轮有界恢复不等于任意长度、任意历史来源的无缝合并，实现与验证边界见 [夜间核查](docs/todo/2026-09-11-overnight-todo-audit.md)。

## 明确保留、暂不盲改的边界

- **Ink meta/escape 兼容**注释保留到明确 major 迁移策略；不能因为带 TODO 就删除兼容行为。
- **Memory P2 背压 / rate-limit / 注入 cap**按既有产品决策挂起，待真实容量或成本证据触发。
- **外部 CLI 的审批/排队可观测性**受上游 transcript 限制，继续诚实显示可观测状态，不通过猜测补成完整状态。Pet 外部卡片跳转、项目可见性 override 和真实委派终态收尾已实现。
- **Core First**：Arena、Pet、coding 都是独立能力包，经 extension/composition 组合，不反向加回 core 内置业务。
- **quick-chat 不做 Pi 式 parent 指针树状 Session**：快聊是短对话，需要合并时使用 fork/复制派生，不引入树状会话模型。
- **IM Gateway 不做编排大脑 / IM 内富交互审批 / 多租户**：Gateway 负责通道、隧道生命周期与入口回推；已绑定 Session 路由和通知能力保留。
- **同一 Workspace 同时一个 active Profile**；项目专属定制仍放项目指令，项目明确 override 优先。
- **Mimi 工作台不恢复 TodoWrite 聚合**：个人待办由 Mimi 收尾小结和跟进项承载，Session TodoWrite 是执行进度。
- **Mimi 记忆与 core 记忆分开**：不顺手引入置信度分流、待确认收件箱、周月巩固或向量检索；隐形 segment 与 notes 上下文策略保留。
- **服务端先单管理员**：当前不扩展团队租户、per-user worker 或 SSO；显式 passcode-only 兼容入口和 identity/dataRoot 底座保留。
